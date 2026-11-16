import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as deepduetHost from '../dist/index.js'
import * as deepduetTools from '../dist/tools.js'
import { createDshHost } from '../dist/dsh.js'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const out = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...await collectFiles(full))
    } else {
      out.push(full)
    }
  }
  return out
}

test('codebase contains zero legacy duetdot/dot branding', async () => {
  const files = [
    ...(await collectFiles(join(ROOT, 'src'))),
    join(ROOT, 'package.json'),
    join(ROOT, 'cordis.patch.yml'),
    join(ROOT, 'presets/deepduet.patch.yml'),
    join(ROOT, 'README.md'),
    join(ROOT, 'ideas/argon_v2.md'),
    join(ROOT, 'docs/codebase.md'),
  ]
  for (const file of files) {
    const body = await readFile(file, 'utf8')
    assert.doesNotMatch(body, /duetdot|duet-dot|duet\.dot/iu, `Unexpected legacy name in ${file}`)
  }
})

test('plugin bundle builds slim client extension and declarative patches without overriding DSH web shell', async () => {
  await access(join(ROOT, 'dist/index.js'))
  await access(join(ROOT, 'dist/tools.js'))
  await access(join(ROOT, 'dist/client.js'))

  const cordisPatch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(cordisPatch, /name:\s*dsh-plugin-deepduet/)
  assert.doesNotMatch(cordisPatch, /web-runtime|ui-workspace|ui-agent-preset/)

  const presetPatch = await readFile(join(ROOT, 'presets/deepduet.patch.yml'), 'utf8')
  assert.match(presetPatch, /id:\s*deepduet/)
  assert.match(presetPatch, /name:\s*DeepDuet/)
  assert.match(presetPatch, /order:\s*2/)
  assert.match(presetPatch, /One Mind, Many Workrooms/)
  assert.match(presetPatch, /DeepDuet Closing Reminder/)
  assert.match(presetPatch, /dsh-plugin-deepduet\/tools/)
  assert.doesNotMatch(presetPatch, /dsh-tool-subagent|dsh-tool-workflow|dsh-workflow-ptc|id:\s*delegation/)
})

test('package manifest exposes version 1.0.0 and DeepDuet localized plugin metadata', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-plugin-deepduet')
  assert.equal(pkg.version, '1.0.0')
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  assert.equal(pkg.exports['./tools/locale/*.json'], './locale/tools/*.json')
  assert.ok(pkg.files.includes('locale/*.json'))
  assert.ok(pkg.files.includes('locale/tools/*.json'))

  for (const localeFile of ['locale/en.json', 'locale/zh.json']) {
    const data = JSON.parse(await readFile(join(ROOT, localeFile), 'utf8'))
    assert.equal(data.meta?.title, 'DeepDuet')
    assert.equal(typeof data.meta?.description, 'string')
    assert.ok(data.meta.description.length > 0)
  }

  for (const localeFile of ['locale/tools/en.json', 'locale/tools/zh.json']) {
    const data = JSON.parse(await readFile(join(ROOT, localeFile), 'utf8'))
    assert.equal(typeof data.meta?.title, 'string')
    assert.ok(data.meta.title.includes('DeepDuet'))
    assert.equal(typeof data.meta?.description, 'string')
    assert.ok(data.meta.description.length > 0)
  }
})

test('deepduet-tools mounts Master tools cleanly in preset mode without leaking when agentPresets is active', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deepduet-preset-scope-'))
  const ctx = new Context()
  t.after(async () => {
    try { await ctx.fiber.dispose() }
    finally { await rm(root, { recursive: true, force: true }) }
  })

  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') })
  const harness = await mountAgentLoopTestHarness(ctx)

  // Pretend host has agentPresets configured so host plugin leaves Master surface to preset-deepduet.
  ctx.provide('agentPresets', {
    resolve: async () => ({ id: 'standard' }),
  })

  await ctx.plugin(deepduetHost, { projectRoot: root })
  assert.equal(ctx.tools.get('session_spawn'), undefined)

  await ctx.plugin(deepduetTools)
  assert.ok(ctx.tools.get('session_spawn'))
  assert.ok(ctx.tools.get('session_steer'))
  assert.ok(ctx.tools.get('session_inspect'))
  assert.ok(ctx.tools.get('session_manage'))
  assert.ok(harness)
})

test('spawned workers attach to workspaceRegistry cleanly', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deepduet-ws-group-'))
  const attached = []
  const ctx = new Context()
  t.after(async () => {
    try { await ctx.fiber.dispose() }
    finally { await rm(root, { recursive: true, force: true }) }
  })

  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') })
  const harness = await mountAgentLoopTestHarness(ctx)

  ctx.provide('workspaceRegistry', {
    async resolveByPath(path) {
      if (path === root) {
        return {
          id: 'ws-demo',
          async attachSession(sessionId) {
            attached.push(sessionId)
          },
        }
      }
      return undefined
    },
  })

  const master = await harness.create('master-1', { provider: 'mock', model: 'mock' }, { cwd: root })
  const host = createDshHost(ctx)
  await host.createWorker({
    sessionId: 'worker-shared',
    masterId: master.id,
    cwd: root,
    title: 'Shared Worker',
  })
  assert.deepEqual(attached, ['worker-shared'])
})

test('deepduet host keeps its default ledger in DSH_HOME, independent of the launch directory', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deepduet-cwd-default-')))
  const home = join(root, 'dsh-home')
  const originalCwd = process.cwd()
  const originalHome = process.env.DSH_HOME
  const ctx = new Context()
  t.after(async () => {
    process.chdir(originalCwd)
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
    try { await ctx.fiber.dispose() }
    finally { await rm(root, { recursive: true, force: true }) }
  })

  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') })
  const harness = await mountAgentLoopTestHarness(ctx)

  process.env.DSH_HOME = home
  process.chdir(root)
  await ctx.plugin(deepduetHost)

  const master = await harness.create('master-cwd', { provider: 'mock', model: 'mock' }, { cwd: root })
  const spawned = await ctx.deepduet.tasks.spawn({ masterId: master.id, cwd: root }, {
    title: 'CWD Check',
    prompt: 'Verify ledger path',
  })
  assert.equal(spawned.status, 'running')
  await access(join(home, 'deepduet', 'deepduet-ledger.json'))
  await assert.rejects(access(join(root, '.dsh', 'deepduet-ledger.json')))
})

test('MASTER_PROMPT encodes all 5 architectural capabilities and proactive delegation philosophy as a static prompt section', () => {
  const prompt = deepduetHost.MASTER_PROMPT
  assert.equal(typeof prompt, 'string')
  // 1. Proactive delegation philosophy & execution routing
  assert.match(prompt, /One Mind, Many Workrooms/)
  assert.match(prompt, /Default to `session_spawn` for real work/)
  assert.match(prompt, /Handle quick lookups/)
  assert.match(prompt, /session_spawn/)
  assert.doesNotMatch(prompt, /ephemeral subagents/)
  // 2. Self-contained briefs & isolated worktrees
  assert.match(prompt, /Zero shared chat history/)
  assert.match(prompt, /isolateWorktree: true/)
  assert.match(prompt, /deepduet\/<sessionId>/)
  // 3. Idle-gated non-blocking turn discipline & [Background Digest]
  assert.match(prompt, /idle-gated/)
  assert.match(prompt, /end your turn immediately/)
  assert.match(prompt, /\[Background Digest\]/)
  // 4. Safe autonomy, [NEED_DECISION] translation, mid-flight steer & failure recovery
  assert.match(prompt, /\[NEED_DECISION\]/)
  assert.match(prompt, /session_steer/)
  // 5. GUI takeover coexistence, verification & lifecycle hygiene
  assert.match(prompt, /Take Over/)
  assert.match(prompt, /TASK_BUSY/)
  assert.match(prompt, /session_inspect/)
  assert.match(prompt, /session_manage/)
  assert.match(prompt, /remove_worktree/)
})

test('Master prompt assembly rewrites conflicting built-in DSH sections and strips stray subagent/workflow sections without affecting Workers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deepduet-prompt-rewrite-'))
  const ctx = new Context()
  t.after(async () => {
    try { await ctx.fiber.dispose() }
    finally { await rm(root, { recursive: true, force: true }) }
  })

  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') })
  const harness = await mountAgentLoopTestHarness(ctx)

  ctx.systemPrompt.section({ name: 'tool:jobs', order: 1600, text: 'Track every background job id you start.' })
  ctx.systemPrompt.section({ name: 'tool:goal', order: 2400, text: 'create_goal may infer goal intent... After session resume or fork...' })
  ctx.systemPrompt.section({ name: 'tool:workflow', order: 2600, text: 'Use the workflow tool ONLY when the user explicitly asks...' })
  ctx.systemPrompt.section({ name: 'tool:subagent', order: 2800, text: 'Start independent delegations with subagent or subagent_fork...' })
  ctx.systemPrompt.context({ name: 'subagent:identity', order: 120, text: 'You are the root agent. Your name is "lead".' })

  await ctx.plugin(deepduetHost, { projectRoot: root })

  const master = await harness.create('master-prompt', { provider: 'mock', model: 'mock' }, { cwd: root })
  const spawned = await ctx.deepduet.tasks.spawn({ masterId: master.id, cwd: root }, {
    title: 'Prompt Check',
    prompt: 'Worker prompt check',
  })
  const worker = ctx.agents.get(spawned.sessionId)
  assert.ok(worker)

  const masterAssembly = await ctx.systemPrompt.assemble({ agent: master })
  const masterRendered = masterAssembly.sections.map(s => s.text).join('\n\n')
  const masterContext = masterAssembly.contexts.map(c => c.text).join('\n\n')
  assert.match(masterRendered, /Master conversational partner and orchestrator in DeepDuet mode/)
  assert.match(masterRendered, /do NOT call `create_goal`/)
  assert.match(masterRendered, /Only use bash `run_in_background`/)
  assert.doesNotMatch(masterRendered, /Start independent delegations with subagent/)
  assert.doesNotMatch(masterRendered, /Use the workflow tool ONLY/)
  assert.doesNotMatch(masterRendered, /After session resume or fork/)
  assert.doesNotMatch(masterContext, /root agent/)

  const workerAssembly = await ctx.systemPrompt.assemble({ agent: worker })
  const workerRendered = workerAssembly.sections.map(s => s.text).join('\n\n')
  assert.match(workerRendered, /You are an AI agent powered by DeepSeek Harness/)
  assert.match(workerRendered, /You are a DeepDuet background worker/)
  assert.doesNotMatch(workerRendered, /DeepDuet Master Orchestration/)
})
