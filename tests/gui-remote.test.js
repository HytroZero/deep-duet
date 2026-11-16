import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Approval from '@deepseek-ai/dsh-user-approval'
import * as z from 'zod'
import * as plugin from '../dist/index.js'
import { eventually } from './support/fake-host.js'

const textOf = message => message.content.map(block => block.type === 'text' ? block.text : '').join('')
const userMessage = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const deadline = { timeout: 15000 }

class ScriptedModel extends LlmAdapter {
  constructor(respond) {
    super()
    this.respond = respond
  }

  async *stream(options) {
    const input = options.messages.findLast(message => message.role === 'user'
      && ['user', 'deepduet'].includes(message.source?.kind))
    const text = await this.respond(input ? textOf(input) : '', options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function setupRemoteHost(t, respond) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deepduet-gui-remote-')))
  const ctx = new Context()
  t.after(async () => {
    try { await ctx.fiber.dispose() }
    finally { await rm(root, { force: true, recursive: true }) }
  })
  await ctx.plugin(TypertRegistry)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(Approval)
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') })
  const harness = await mountAgentLoopTestHarness(ctx)
  ctx.llm.registerAdapter(['mock'], new ScriptedModel(respond))
  await ctx.plugin(plugin, { projectRoot: root })
  const master = await harness.create('master', { provider: 'mock', model: 'mock' }, { cwd: root })
  return { ctx, master, root }
}

test('host exposes Typert remote descriptors and streams live watch/spawn/inspect/steer/manage', deadline, async t => {
  const { ctx, master, root } = await setupRemoteHost(t, async (input) => {
    if (input.includes('build auth')) {
      return 'Blocked on token decision.\n[NEED_DECISION]: Which token format?'
    }
    return `Completed: ${input}`
  })

  // Verify Typert registry received all 10 endpoints and binding matches gateway check
  const reg = ctx.typert.getPackage('dsh-plugin-deepduet', 'host')
  assert.ok(reg, 'dsh-plugin-deepduet host package should be registered with TypertRegistry')
  const deepduetEndpoints = ctx.typert.local.list({ package: 'dsh-plugin-deepduet' })
  assert.deepEqual(
    deepduetEndpoints.map(item => item.id).sort(),
    [
      'dsh-plugin-deepduet#deepduet/engines',
      'dsh-plugin-deepduet#deepduet/getSettings',
      'dsh-plugin-deepduet#deepduet/inspect',
      'dsh-plugin-deepduet#deepduet/list',
      'dsh-plugin-deepduet#deepduet/manage',
      'dsh-plugin-deepduet#deepduet/resolveApproval',
      'dsh-plugin-deepduet#deepduet/setSettings',
      'dsh-plugin-deepduet#deepduet/spawn',
      'dsh-plugin-deepduet#deepduet/steer',
      'dsh-plugin-deepduet#deepduet/watch',
    ],
  )
  assert.ok(ctx.deepduet.typertRemote, 'deepduet service should bind typertRemote')
  assert.equal(ctx.deepduet.typertRemote.serviceKey, 'deepduet')
  assert.deepEqual(ctx.deepduet.typertRemote, bindTypertRemote(ctx.deepduet, 'deepduet'))

  // Start watching stream
  const ac = new AbortController()
  t.after(() => ac.abort())
  const stream = ctx.deepduet.remoteWatch(ac.signal)
  const first = await stream.next()
  assert.equal(first.done, false)
  assert.deepEqual(first.value, { tasks: [] })

  const snapshots = []
  const pump = (async () => {
    for await (const snap of stream) {
      snapshots.push(snap)
    }
  })()

  // Spawn worker via GUI remoteSpawn
  const receipt = await ctx.deepduet.remoteSpawn({
    masterId: master.id,
    title: 'Auth Task',
    prompt: 'Please build auth service',
  })
  assert.ok(receipt.sessionId)
  assert.equal(receipt.title, 'Auth Task')

  // Wait for watch stream to receive decision update
  await eventually(() => {
    const latest = snapshots.at(-1)
    const worker = latest?.tasks.find(item => item.sessionId === receipt.sessionId)
    assert.ok(worker)
    assert.equal(worker.status, 'idle')
    assert.equal(worker.needsDecision, true)
    assert.equal(worker.decisionQuestion, 'Which token format?')
  })

  // Inspect live state & transcript messages via remoteInspect
  const inspected = await ctx.deepduet.remoteInspect({
    masterId: master.id,
    sessionId: receipt.sessionId,
    tailMessages: 5,
  })
  assert.equal(inspected.task.sessionId, receipt.sessionId)
  assert.equal(inspected.session.id, receipt.sessionId)
  assert.equal(inspected.session.busy, false)
  assert.ok(inspected.session.messages.some(m => m.text.includes('Which token format?')))

  // Answer decision via remoteSteer
  await ctx.deepduet.remoteSteer({
    masterId: master.id,
    sessionId: receipt.sessionId,
    instruction: 'Use JWT RS256',
  })
  await eventually(() => {
    const list = ctx.deepduet.remoteList()
    const worker = list.tasks.find(item => item.sessionId === receipt.sessionId)
    assert.ok(worker)
    assert.equal(worker.status, 'idle')
    assert.equal(worker.needsDecision, false)
    assert.ok(worker.lastSummary?.includes('Completed: Use JWT RS256'))
  })

  // Archive via remoteManage and verify status transitions to completed + stream update
  await ctx.deepduet.remoteManage({
    masterId: master.id,
    sessionId: receipt.sessionId,
    action: 'archive',
  })
  await eventually(() => {
    const latest = snapshots.at(-1)
    const archived = latest?.tasks.find(item => item.sessionId === receipt.sessionId)
    assert.ok(archived)
    assert.equal(archived.status, 'completed')
  })

  ac.abort()
  await pump
  void root
})

test('spawned workers isolate to standard preset across cold resume and GUI takeover', deadline, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deepduet-preset-iso-')))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  t.after(async () => {
    try { await ctx.fiber.dispose() }
    finally { await rm(root, { force: true, recursive: true }) }
  })

  await ctx.plugin(Loader, { name: 'loader', root })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(Approval)
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') })
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(AgentPresetRegistry, { default: 'standard' })

  const markerFile = join(root, 'standard-marker.mjs')
  await writeFile(
    markerFile,
    [
      `export const name = 'standard-marker'`,
      `export const inject = ['systemPrompt']`,
      `export function apply(agentCtx) {`,
      `  agentCtx.effect(() => agentCtx.systemPrompt.section({ name: 'standard-marker', order: 10, text: () => 'STANDARD_PERSONA' }))`,
      `}`,
    ].join('\n'),
    'utf8',
  )
  const toolsUrl = new URL('../dist/tools.js', import.meta.url).href

  await ctx.plugin(plugin, { projectRoot: root })
  await ctx.agentPresets.register({
    id: 'standard',
    name: 'Standard',
    plugins: [{ name: pathToFileURL(markerFile).href }],
  })
  await ctx.agentPresets.register({
    id: 'deepduet',
    name: 'DeepDuet',
    plugins: [{ name: toolsUrl }],
  })
  const seenSystems = []
  ctx.llm.registerAdapter(['mock'], new ScriptedModel(async (input, options) => {
    const systemFromMessages = (options.messages ?? [])
      .filter(m => m.role === 'system')
      .map(m => typeof m.content === 'string' ? m.content : textOf(m))
      .join('\n')
    seenSystems.push({ input, system: systemFromMessages || options.system || '' })
    return `ok: ${input}`
  }))

  const deepduetPreset = await ctx.agentPresets.resolve('deepduet')
  assert.equal(deepduetPreset.broken, undefined, `deepduet preset failed: ${deepduetPreset.broken}`)
  const standardPreset = await ctx.agentPresets.resolve('standard')
  assert.equal(standardPreset.broken, undefined, `standard preset failed: ${standardPreset.broken}`)

  // Create Master with deepduet preset
  const masterHandle = await ctx.agents.create({
    cwd: root,
    meta: { agentPreset: 'deepduet' },
    setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, 'deepduet')
    },
  })
  const master = masterHandle.agent
  master.model.select({ provider: 'mock', model: 'mock' })
  t.after(() => masterHandle.dispose())

  // Master gets Master tools and MASTER_PROMPT
  const masterTools = await master.ctx.tools.resolve({
    agent: master,
    modelSelection: { provider: 'mock', model: 'mock' },
    signal: AbortSignal.timeout(5000),
  })
  t.after(() => masterTools.dispose())
  assert.ok(master.ctx.tools.get('session_spawn', scopeOf(master.ctx), masterTools), 'Master should have session_spawn')
  master.followup(userMessage('master ping'))
  await master.whenIdle()
  const masterCall = seenSystems.find(entry => entry.input === 'master ping')
  assert.ok(masterCall?.system.includes('session_spawn'), 'Master prompt should describe orchestration tools')

  // Spawn worker via DeepDuet
  const created = await ctx.deepduet.tasks.spawn(
    { masterId: master.id, cwd: root },
    { title: 'Standard Worker', prompt: 'Do work' },
  )
  await eventually(() => {
    const task = ctx.deepduet.tasks.listTasks(master.id).find(item => item.sessionId === created.sessionId)
    assert.equal(task?.status, 'idle')
    assert.ok(task?.lastSummary)
  })

  // Live Worker uses standard preset, NOT deepduet orchestrator tools
  const workerAgent = ctx.agents.get(created.sessionId)
  assert.ok(workerAgent)
  assert.equal(workerAgent.session.header.agentPreset, 'standard')
  assert.equal(ctx.agentPresets.presetForSession(workerAgent.session), 'standard')
  const workerTools = await workerAgent.ctx.tools.resolve({
    agent: workerAgent,
    modelSelection: { provider: 'mock', model: 'mock' },
    signal: AbortSignal.timeout(5000),
  })
  t.after(() => workerTools.dispose())
  assert.equal(workerAgent.ctx.tools.get('session_spawn', scopeOf(workerAgent.ctx), workerTools), undefined)
  const workerCall = seenSystems.find(entry => entry.input.includes('Do work'))
  assert.ok(workerCall?.system.includes('STANDARD_PERSONA'), 'Worker prompt should include standard preset persona')
  assert.ok(workerCall?.system.includes('[NEED_DECISION]'), 'Worker prompt should include WORKER_PROMPT')
  assert.ok(!workerCall?.system.includes('session_spawn'), 'Worker prompt must NOT inherit Master prompt')

  // Simulate unload/restart + cold resume from persistence (as GUI takeover does)
  await ctx.deepduet.tasks.close()
  assert.equal(ctx.agents.get(created.sessionId), undefined, 'Worker should be released after close')

  const stored = await ctx.sessionPersistence.stat(created.sessionId)
  assert.equal(stored?.header.agentPreset, 'standard')
  const storedHandle = await ctx.agents.resume({
    resumeSessionId: created.sessionId,
    setup: async (agentCtx) => {
      if (stored?.header.agentPreset) {
        await ctx.agentPresets.mount(agentCtx, stored.header.agentPreset)
      }
    },
  })
  t.after(() => storedHandle.dispose())
  const resumed = storedHandle.agent
  resumed.model.select({ provider: 'mock', model: 'mock' })
  const resumedTools = await resumed.ctx.tools.resolve({
    agent: resumed,
    modelSelection: { provider: 'mock', model: 'mock' },
    signal: AbortSignal.timeout(5000),
  })
  t.after(() => resumedTools.dispose())
  assert.equal(resumed.ctx.tools.get('session_spawn', scopeOf(resumed.ctx), resumedTools), undefined)
  resumed.followup(userMessage('GUI takeover reply'))
  await resumed.whenIdle()
  const history = resumed.session.deriveMessages()
  assert.ok(history.some(m => m.role === 'assistant' && textOf(m).includes('ok: GUI takeover reply')))
  const takeoverCall = seenSystems.find(entry => entry.input === 'GUI takeover reply')
  assert.ok(takeoverCall?.system.includes('STANDARD_PERSONA'))
  assert.ok(takeoverCall?.system.includes('[NEED_DECISION]'))
  assert.ok(!takeoverCall?.system.includes('session_spawn'))
})

test('built dist/client.js loads via __ModuleLoader__ and registers all GUI slots, tab, locales, remote, and menus', async () => {
  const clientCode = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8')
  let loadedModule
  const windowStub = {
    __ModuleLoader__: {
      load(mod) {
        loadedModule = mod
      },
    },
  }
  const externals = {
    react: {
      useEffect: () => {},
      useRef: (initial) => ({ current: initial }),
      useState: (initial) => [initial, () => {}],
      useSyncExternalStore: (_sub, get) => get(),
    },
    'react/jsx-runtime': {
      Fragment: Symbol('Fragment'),
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
    },
    zod: z,
    '@deepseek-ai/dsh-client-store': {
      createSnapshotStore(init) {
        let current = structuredClone(init)
        const listeners = new Set()
        return {
          getSnapshot: () => current,
          subscribe: (fn) => {
            listeners.add(fn)
            return () => listeners.delete(fn)
          },
          update: (mutator) => {
            mutator(current)
            for (const fn of listeners) fn()
          },
          set: (next) => {
            current = next
            for (const fn of listeners) fn()
          },
        }
      },
      shallowEqual: (a, b) => a === b,
    },
    '@deepseek-ai/dsh-client-ui-primitives': {
      Button: () => null,
      IconChevronRightOutlineRegular: () => null,
      IconRefreshOutlineRegular: () => null,
      IconUsersOutlineRegular: () => null,
      StateDot: () => null,
      Tag: () => null,
      relativeTime: () => ({ unit: 'now', n: 0 }),
    },
  }

  vm.runInNewContext(clientCode, { window: windowStub, console, URLSearchParams })
  assert.equal(loadedModule.id, 'dsh-plugin-deepduet')
  const exports = loadedModule.factory((specifier) => {
    if (!(specifier in externals)) {
      throw new Error(`Unexpected external require in dist/client.js: ${specifier}`)
    }
    return externals[specifier]
  })
  assert.equal(typeof exports.apply, 'function')
  assert.ok(Array.isArray(exports.inject))
  assert.ok(exports.inject.includes('remote'))
  assert.ok(exports.inject.includes('sidebarRight'))
  assert.ok(exports.inject.includes('sidebarRightTabs'))

  const mounted = []
  const registeredSlots = []
  const registeredTabs = []
  const registeredLocales = []
  const registeredMenus = []

  const mockCtx = {
    effect(fn) {
      fn()
      return () => {}
    },
    inject(services, callback) {
      if (services.includes('contextMenus')) {
        callback({
          effect: fn => { fn(); return () => {} },
          contextMenus: {
            register: (contrib) => {
              registeredMenus.push(contrib)
              return () => {}
            },
          },
        })
      }
    },
    locale: {
      register: (ns, dicts) => {
        registeredLocales.push({ ns, dicts })
        return () => {}
      },
      bind: () => (key) => key,
    },
    slots: {
      inject: (_name, cb) => cb(),
      register: (spec, comp) => {
        registeredSlots.push({ spec, comp })
        return () => {}
      },
    },
    uiWorkspace: {
      openSession: () => {},
    },
    sidebarRight: {
      openTab: async () => {},
    },
    sidebarRightTabs: {
      register: (def) => {
        registeredTabs.push(def)
        return () => {}
      },
    },
    remote: {
      async $mount(contribution) {
        mounted.push(contribution)
        mockCtx.remote.deepduet = {
          list: async () => ({ ok: true, value: { tasks: [] } }),
          watch: async function* () { yield { tasks: [] } },
          spawn: async () => ({ ok: true, value: {} }),
          steer: async () => ({ ok: true, value: {} }),
          manage: async () => ({ ok: true, value: {} }),
          inspect: async () => ({ ok: true, value: {} }),
        }
      },
      $stream: () => ({
        async *[Symbol.asyncIterator]() {},
        dispose: async () => {},
      }),
    },
  }

  exports.apply(mockCtx)
  await eventually(() => {
    assert.equal(mounted.length, 1)
  })
  assert.equal(mounted[0].package, 'dsh-plugin-deepduet')
  assert.equal(mounted[0].descriptors.length, 10)
  assert.equal(registeredLocales.length, 1)
  assert.equal(registeredLocales[0].ns, 'deepduet')
  assert.ok(registeredLocales[0].dicts.zh && registeredLocales[0].dicts.en)
  assert.equal(registeredTabs.length, 1)
  assert.equal(registeredTabs[0].kind, 'deepduet')
  assert.equal(registeredMenus.length, 1)
  assert.equal(registeredMenus[0].id, 'deepduet-session-actions')

  const slotNames = registeredSlots.map(s => s.spec.key ? `${s.spec.name}:${s.spec.key}` : s.spec.name)
  for (const expected of [
    'sidebar.right.pane.tab:dsh-plugin-deepduet',
    'sidebar.right.pane.tab.title:dsh-plugin-deepduet',
    'sidebar.session.row.leading',
    'sidebar.session.row.trailing',
    'sidebar.session.row.hover',
    'conversation.session.header.actions',
    'conversation.input.dock',
    'settings.section',
    'tool.call.toolview:session_spawn',
    'tool.call.toolview:session_steer',
    'tool.call.toolview:session_inspect',
    'tool.call.toolview:session_manage',
  ]) {
    assert.ok(slotNames.includes(expected), `Missing registered slot ${expected}`)
  }
  for (const { spec } of registeredSlots) {
    assert.equal(spec.locale, 'deepduet')
    assert.equal(typeof spec.inject, 'function')
    const injected = spec.inject()
    assert.ok(injected.hooks?.deepduet, 'Slot registration should inject hooks.deepduet observable')
  }

  assert.equal(registeredLocales[0].dicts.zh['badge.master'], 'Duet')
  assert.equal(registeredLocales[0].dicts.en['badge.master'], 'Duet')

  const trailingSlot = registeredSlots.find(s => s.spec.name === 'sidebar.session.row.trailing')
  assert.ok(trailingSlot)
  const sampleTask = {
    sessionId: 'worker-1',
    masterId: 'master-by-task',
    title: 'Worker',
    goal: 'Work',
    cwd: '/tmp',
    status: 'idle',
    needsDecision: false,
    createdAt: 1,
    updatedAt: 1,
  }
  const deepduetState = {
    tasks: [sampleTask],
    bySessionId: { 'worker-1': sampleTask },
    byMasterId: { 'master-by-task': [sampleTask] },
    inspections: {},
    inspectLoading: {},
    pendingActions: {},
    selectedTaskId: undefined,
    ready: true,
    error: undefined,
  }
  const sessionsState = {
    byId: {
      'master-by-preset': { projectionValues: { agentPreset: 'deepduet' } },
      'master-by-task': { projectionValues: { agentPreset: 'standard' } },
      'worker-1': { projectionValues: { agentPreset: 'standard' } },
      'plain-session': { projectionValues: { agentPreset: 'standard' } },
    },
  }
  const renderTrailing = (sessionId) => {
    const outer = trailingSlot.comp({
      sessionId,
      useDeepduet: (selector) => selector(deepduetState),
      useSessions: (selector) => selector(sessionsState),
    })
    return outer.type(outer.props)
  }

  const presetMasterBadge = renderTrailing('master-by-preset')
  assert.equal(presetMasterBadge?.props?.children, 'badge.master')
  assert.match(presetMasterBadge?.props?.className ?? '', /badgeMaster/)

  const taskMasterBadge = renderTrailing('master-by-task')
  assert.equal(taskMasterBadge?.props?.children, 'badge.master')
  assert.match(taskMasterBadge?.props?.className ?? '', /badgeMaster/)

  const workerBadge = renderTrailing('worker-1')
  assert.equal(workerBadge?.props?.children, 'status.idle')
  assert.doesNotMatch(workerBadge?.props?.className ?? '', /badgeMaster/)

  assert.equal(renderTrailing('plain-session'), null)
})

test('client store mounts and reads remote.deepduet under real Cordis service injection without throwing', async (t) => {
  const clientCode = await readFile(new URL('../dist/client.js', import.meta.url), 'utf8')
  const externals = {
    react: { useRef: (v) => ({ current: v }), useSyncExternalStore: (_s, get) => get() },
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: Symbol('Fragment') },
    '@deepseek-ai/dsh-client-store': {
      createSnapshotStore(initial) {
        let state = structuredClone(initial)
        const listeners = new Set()
        return {
          getSnapshot: () => state,
          subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
          update(updater) {
            const draft = structuredClone(state)
            updater(draft)
            state = draft
            for (const fn of listeners) fn()
          },
        }
      },
      shallowEqual: (a, b) => a === b,
    },
    '@deepseek-ai/dsh-client-ui-primitives': {},
    '@deepseek-ai/dsh-client-ui-renderer': {},
    '@deepseek-ai/dsh-client-ui-tool': {},
    '@deepseek-ai/dsh-typert-protocol/remote-info': {
      createTypertRemoteInfo: () => ({ descriptors: [{ namespace: 'deepduet', method: 'list' }] }),
    },
    zod: z,
  }

  let loadedModule
  const windowStub = {
    __ModuleLoader__: {
      load(mod) {
        loadedModule = mod
      },
    },
  }
  vm.runInNewContext(clientCode, { window: windowStub, console, URLSearchParams })
  const clientExports = loadedModule.factory((specifier) => externals[specifier])

  const root = new Context()

  class MockRemoteService extends Service {
    constructor(ctx) {
      super(ctx, 'remote')
    }
    async $mount() {
      root.plugin({
        apply: (nsCtx) => {
          new MockDeepDuetRemoteService(nsCtx)
        },
      })
      await eventually(() => {
        assert.ok(root.get('remote.deepduet'))
      })
    }
    $stream() {
      return {
        async *[Symbol.asyncIterator]() {},
        dispose: async () => {},
      }
    }
  }

  class MockDeepDuetRemoteService extends Service {
    constructor(ctx) {
      super(ctx, 'remote.deepduet')
    }
    async list() {
      return { ok: true, value: { tasks: [] } }
    }
    async *watch() {
      yield { tasks: [] }
    }
  }

  root.plugin({ apply: (c) => { new MockRemoteService(c) } })

  let store
  root.plugin({
    inject: ['remote'],
    apply: (pluginCtx) => {
      store = clientExports.createDeepDuetStore(pluginCtx)
    },
  })

  await eventually(() => {
    assert.ok(store)
  })

  const stop = store.start()
  t.after(stop)
  await eventually(() => {
    assert.equal(store.snapshot.getSnapshot().ready, true)
  })
  assert.equal(store.snapshot.getSnapshot().error, undefined)

  await store.refresh()
  assert.equal(store.snapshot.getSnapshot().error, undefined)
})
