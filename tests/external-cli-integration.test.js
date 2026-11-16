import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Approval from '@deepseek-ai/dsh-user-approval'
import * as deepduet from '../dist/index.js'
import { startMasterMcpServer } from '../dist/master-mcp.js'
import { eventually } from './support/fake-host.js'
import * as mockExternalCli from './support/mock-external-cli.js'

const execFileAsync = promisify(execFile)
const textOf = message => message.content.map(b => b.type === 'text' ? b.text : '').join('')
const userMsg = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

class MockNativeLlm extends LlmAdapter {
  constructor(respond) {
    super()
    this.respond = respond
  }

  async listModels(provider) {
    return [{ provider, id: 'mock', name: 'Mock Model' }]
  }

  async *stream(options) {
    const input = options.messages.findLast(m => m.role === 'user' && ['user', 'deepduet'].includes(m.source?.kind))
    const text = await this.respond(input ? textOf(input) : '', options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function initGitRepo(dir) {
  await execFileAsync('git', ['init'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  await writeFile(join(dir, 'README.md'), '# demo\n', 'utf8')
  await execFileAsync('git', ['add', 'README.md'], { cwd: dir })
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: dir })
}

test('deepduet works standalone, persists role profiles, and fails explicitly when requested external engine is missing', { timeout: 15000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deepduet-ext-missing-')))
  const ctx = new Context()
  t.after(async () => {
    try { await ctx.fiber.dispose() }
    finally { await rm(root, { recursive: true, force: true }) }
  })

  await ctx.plugin(TypertRegistry)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') })
  const harness = await mountAgentLoopTestHarness(ctx)
  ctx.llm.registerAdapter(['mock'], new MockNativeLlm(input => `native:${input}`))

  await ctx.plugin(deepduet, { projectRoot: root })

  const enginesSnap = await ctx.deepduet.remoteEngines()
  assert.equal(enginesSnap.engines.length, 1)
  assert.equal(enginesSnap.engines[0]?.id, 'native')
  assert.equal(enginesSnap.engines[0]?.controls.length, 1)
  assert.equal(enginesSnap.engines[0]?.controls[0]?.id, 'sandboxMode')
  assert.equal(enginesSnap.engines[0]?.controls[0]?.labelKey, 'settings.permission')
  assert.deepEqual(
    enginesSnap.engines[0]?.controls[0]?.options.map(o => o.labelKey),
    [
      'settings.nativePermission.readOnly',
      'settings.nativePermission.workspaceWrite',
      'settings.nativePermission.dangerFullAccess',
    ],
  )

  const saved = await ctx.deepduet.remoteSetSettings({
    master: { engine: 'native', presetId: 'deepduet' },
    workerDefault: { engine: 'missing-cli', presetId: 'missing-cli', model: 'ext-pro' },
  })
  assert.equal(saved.workerDefault.engine, 'missing-cli')
  assert.equal(ctx.deepduet.remoteGetSettings().workerDefault.model, 'ext-pro')

  const master = await harness.create('master-1', { provider: 'mock', model: 'mock' }, { cwd: root })
  await assert.rejects(
    () => ctx.deepduet.tasks.spawn({ masterId: master.id, cwd: root }, { title: 'Missing CLI', prompt: 'Should fail' }),
    (err) => err?.code === 'ENGINE_UNAVAILABLE',
  )
})

test('deepduet integrates with ExternalCliEngine contract for mixed Workers, worktrees, dual-channel approvals, and external Master MCP', { timeout: 25000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deepduet-ext-collab-')))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  t.after(async () => {
    try { await ctx.fiber.dispose() }
    finally { await rm(root, { recursive: true, force: true }) }
  })

  await initGitRepo(root)

  await ctx.plugin(Loader, { name: 'loader', root })
  await ctx.plugin(TypertRegistry)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access' })
  await ctx.plugin(Approval)
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') })
  await mountAgentLoopTestHarness(ctx)
  ctx.llm.registerAdapter(['mock'], new MockNativeLlm(input => `native:${input}`))
  await ctx.plugin(AgentPresetRegistry, { default: 'standard' })

  await ctx.plugin(mockExternalCli, {
    id: 'mock-cli',
    presetId: 'mock-cli',
    label: 'MockCLI',
    configControls: [
      {
        id: 'sandboxMode',
        label: 'Sandbox Policy',
        labelKey: 'settings.sandbox',
        defaultValue: 'workspace-write',
        options: [
          { value: 'read-only', label: 'Read Only', labelKey: 'settings.sandbox.readOnly' },
          { value: 'workspace-write', label: 'Workspace Write', labelKey: 'settings.sandbox.workspaceWrite' },
          { value: 'danger-full-access', label: 'Full Access', labelKey: 'settings.sandbox.dangerFullAccess' },
        ],
      },
      {
        id: 'approvalPolicy',
        label: 'Approval Policy',
        labelKey: 'settings.approval',
        defaultValue: 'on-request',
        options: [
          { value: 'on-request', label: 'On Request', labelKey: 'settings.approval.onRequest' },
          { value: 'auto-review', label: 'Auto Review', labelKey: 'settings.approval.autoReview' },
          { value: 'never', label: 'Never Ask', labelKey: 'settings.approval.never' },
        ],
      },
      {
        id: 'networkMode',
        label: 'Network Access',
        defaultValue: 'off',
        options: [
          { value: 'off', label: 'Offline' },
          { value: 'on', label: 'Online' },
        ],
      },
    ],
  })
  await ctx.plugin(deepduet, { projectRoot: root })

  await ctx.agentPresets.register({ id: 'standard', name: 'Standard', plugins: [] })
  await ctx.agentPresets.register({
    id: 'deepduet',
    name: 'DeepDuet',
    plugins: [{ name: new URL('../dist/tools.js', import.meta.url).href }],
  })
  await ctx.agentPresets.register({
    id: 'mock-cli',
    name: 'Mock CLI',
    plugins: [{ name: new URL('./support/mock-external-cli-preset.js', import.meta.url).href }],
  })

  // 1) Engine discovery sees both native (1 control) and external CLI engines (3 controls)
  const enginesSnap = await ctx.deepduet.remoteEngines()
  const nativeEng = enginesSnap.engines.find(e => e.id === 'native')
  assert.equal(nativeEng?.controls.length, 1)
  const extEng = enginesSnap.engines.find(e => e.id === 'mock-cli')
  assert.ok(extEng)
  assert.equal(extEng.health.available, true)
  assert.equal(extEng.health.authenticated, true)
  assert.equal(extEng.models.length, 2)
  assert.equal(extEng.controls.length, 3)
  assert.deepEqual(extEng.controls.map(c => c.id), ['sandboxMode', 'approvalPolicy', 'networkMode'])

  // 2) Mixed mode: native Master spawns external CLI Worker with isolated worktree + dual-channel approval
  const masterHandle = await ctx.agents.create({
    sessionId: 'master-mixed',
    meta: { cwd: root, agentPreset: 'deepduet' },
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async ac => { await ctx.agentPresets.mount(ac, 'deepduet') },
  })
  t.after(() => masterHandle.dispose())

  const spawned = await ctx.deepduet.tasks.spawn(
    { masterId: masterHandle.agent.id, cwd: root },
    {
      title: 'External Worker',
      prompt: 'NEED_APPROVAL',
      isolateWorktree: true,
      engine: 'mock-cli',
      model: 'ext-pro',
      reasoningEffort: 'high',
      sandboxMode: 'workspace-write',
    },
  )

  const workerAgent = ctx.agents.get(spawned.sessionId)
  assert.ok(workerAgent)
  assert.equal(workerAgent.session.header.agentPreset, 'mock-cli')

  // Wait for pendingApproval to surface on the TaskRecord, then approve via Master/Input Dock channel
  let pendingReqId
  await eventually(() => {
    const task = ctx.deepduet.tasks.listTasks(masterHandle.agent.id).find(item => item.sessionId === spawned.sessionId)
    assert.ok(task?.pendingApproval)
    assert.equal(task.needsDecision, true)
    assert.equal(task.profile?.engine, 'mock-cli')
    assert.equal(task.profile?.model, 'ext-pro')
    pendingReqId = task.pendingApproval.requestId
  })

  await ctx.deepduet.remoteResolveApproval({
    masterId: masterHandle.agent.id,
    sessionId: spawned.sessionId,
    requestId: pendingReqId,
    approved: true,
  })

  await eventually(() => {
    const task = ctx.deepduet.tasks.listTasks(masterHandle.agent.id).find(item => item.sessionId === spawned.sessionId)
    assert.equal(task?.status, 'idle')
    assert.equal(task?.needsDecision, false)
    assert.equal(task?.pendingApproval, undefined)
    assert.match(task?.lastSummary ?? '', /Approved and executed/)
  })

  // 3) External CLI Master MCP server & external Master turn routing
  await ctx.deepduet.remoteSetSettings({
    master: {
      engine: 'mock-cli',
      presetId: 'deepduet',
      model: 'ext-pro',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'auto-review',
      engineOptions: { networkMode: 'on' },
    },
    workerDefault: { engine: 'native', presetId: 'standard' },
  })

  const extMasterHandle = await ctx.agents.create({
    sessionId: 'master-ext',
    meta: { cwd: root, agentPreset: 'deepduet' },
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async ac => { await ctx.agentPresets.mount(ac, 'deepduet') },
  })
  t.after(() => extMasterHandle.dispose())

  // Verify external Master was bound to mock-cli with MASTER_PROMPT, deepduet MCP server, approvalPolicy & engineOptions
  const boundCfg = ctx.externalCliEngines?.get('mock-cli')?.getSessionConfig?.('master-ext')
  assert.ok(boundCfg)
  assert.equal(boundCfg.approvalPolicy, 'auto-review')
  assert.deepEqual(boundCfg.engineOptions, { networkMode: 'on' })
  assert.match(boundCfg.developerInstructions ?? '', /DeepDuet Master Orchestration/)
  assert.ok(boundCfg.mcpServers?.deepduet)

  // Verify Master turns route through mock-cli
  const masterTurnDone = new Promise((resolve) => {
    const off = ctx.on('session/event', (session, event) => {
      if (session === extMasterHandle.agent.session && event.type === 'turn/end') {
        off()
        resolve()
      }
    })
  })
  extMasterHandle.agent.followup(userMsg('status check'))
  await masterTurnDone
  const masterMsgs = extMasterHandle.agent.session.deriveMessages()
  assert.ok(masterMsgs.some(m => m.role === 'assistant' && textOf(m).includes('MockCLI(ext-pro): status check')))

  // 4) Direct Master MCP server protocol & token isolation test
  const mcpServer = await startMasterMcpServer(() => ctx.deepduet.tasks)
  t.after(() => mcpServer.close())
  const mcpCfg = mcpServer.issueMasterConfig('master-ext', () => root)

  // Reject unauthenticated caller
  const unauthRes = await fetch(mcpServer.url, { method: 'POST', body: '{}' })
  assert.equal(unauthRes.status, 401)

  // List tools & invoke session_spawn as master-ext
  const listRes = await fetch(mcpServer.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${mcpCfg.env.DEEPDUET_MCP_TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  const listJson = await listRes.json()
  assert.deepEqual(listJson.result.tools.map(t => t.name), ['session_spawn', 'session_steer', 'session_inspect', 'session_manage'])

  const callRes = await fetch(mcpServer.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${mcpCfg.env.DEEPDUET_MCP_TOKEN}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'session_spawn', arguments: { title: 'MCP Worker', prompt: 'via mcp' } },
    }),
  })
  const callJson = await callRes.json()
  const spawnedReceipt = JSON.parse(callJson.result.content[0].text)
  assert.equal(spawnedReceipt.status, 'running')
  await eventually(() => {
    const task = ctx.deepduet.tasks.listTasks('master-ext').find(item => item.sessionId === spawnedReceipt.sessionId)
    assert.equal(task?.status, 'idle')
    assert.equal(task?.lastSummary, 'native:via mcp')
  })
})
