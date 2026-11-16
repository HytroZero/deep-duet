import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
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

  const saved = await ctx.deepduet.remoteSetSettings({
    master: { engine: 'native', presetId: 'deepduet' },
    workerDefault: { engine: 'codex-portal', presetId: 'codex-portal', model: 'gpt-5.4' },
  })
  assert.equal(saved.workerDefault.engine, 'codex-portal')
  assert.equal(ctx.deepduet.remoteGetSettings().workerDefault.model, 'gpt-5.4')

  const master = await harness.create('master-1', { provider: 'mock', model: 'mock' }, { cwd: root })
  await assert.rejects(
    () => ctx.deepduet.tasks.spawn({ masterId: master.id, cwd: root }, { title: 'Missing CLI', prompt: 'Should fail' }),
    (err) => err?.code === 'ENGINE_UNAVAILABLE',
  )
})

test('deepduet integrates with dsh-codex-portal for mixed Workers, worktrees, dual-channel approvals, and external Master MCP', { timeout: 25000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deepduet-codex-collab-')))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  t.after(async () => {
    try { await ctx.fiber.dispose() }
    finally { await rm(root, { recursive: true, force: true }) }
  })

  await initGitRepo(root)

  // Stage mock codex CLI shim referencing dsh-codex-portal's mock script
  const mockCliSrc = join(root, '..', '..', 'dsh-codex-portal', 'tests', 'support', 'mock-codex-cli.mjs')
  const codexShimDir = join(root, 'bin')
  await copyFile(
    new URL('../../dsh-codex-portal/tests/support/mock-codex-cli.mjs', import.meta.url),
    join(root, 'mock-codex-cli.mjs'),
  )
  let binPath
  if (process.platform === 'win32') {
    binPath = join(root, 'codex.cmd')
    await writeFile(binPath, `@echo off\r\n"%dp0%\\mock-codex-cli.mjs" %*\r\n`, 'utf8')
  } else {
    binPath = join(root, 'codex')
    await writeFile(binPath, `#!/usr/bin/env sh\nexec "${process.execPath}" "${join(root, 'mock-codex-cli.mjs')}" "$@"\n`, 'utf8')
    await chmod(binPath, 0o755)
  }
  void mockCliSrc
  void codexShimDir

  await ctx.plugin(Loader, { name: 'loader', root })
  await ctx.plugin(TypertRegistry)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access' })
  await ctx.plugin(Approval)
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') })
  await mountAgentLoopTestHarness(ctx)
  ctx.llm.registerAdapter(['mock'], new MockNativeLlm(input => `native:${input}`))
  await ctx.plugin(AgentPresetRegistry, { default: 'standard' })

  const codexPlugin = await import('../../dsh-codex-portal/dist/index.js')
  await ctx.plugin(codexPlugin, { binaryPath: binPath, configPath: join(root, 'codex-cfg.json') })
  await ctx.plugin(deepduet, { projectRoot: root })

  await ctx.agentPresets.register({ id: 'standard', name: 'Standard', plugins: [] })
  await ctx.agentPresets.register({
    id: 'deepduet',
    name: 'DeepDuet',
    plugins: [{ name: new URL('../dist/tools.js', import.meta.url).href }],
  })
  await ctx.agentPresets.register({
    id: 'codex-portal',
    name: 'Codex Portal',
    plugins: [{ name: new URL('../../dsh-codex-portal/dist/preset-runtime.js', import.meta.url).href }],
  })

  // 1) Engine discovery sees both native and codex-portal
  const enginesSnap = await ctx.deepduet.remoteEngines()
  const codexEng = enginesSnap.engines.find(e => e.id === 'codex-portal')
  assert.ok(codexEng)
  assert.equal(codexEng.health.available, true)
  assert.equal(codexEng.health.authenticated, true)
  assert.equal(codexEng.models.length, 2)

  // 2) Mixed mode: native Master spawns codex-portal Worker with isolated worktree + dual-channel approval
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
      title: 'Codex Worker',
      prompt: 'NEED_APPROVAL',
      isolateWorktree: true,
      engine: 'codex-portal',
      model: 'gpt-5.4',
      reasoningEffort: 'high',
      sandboxMode: 'workspace-write',
    },
  )

  // Wait for pendingApproval to surface on the TaskRecord, then approve via Master/Input Dock channel
  let pendingReqId
  await eventually(() => {
    const task = ctx.deepduet.tasks.listTasks(masterHandle.agent.id).find(item => item.sessionId === spawned.sessionId)
    assert.ok(task?.pendingApproval)
    assert.equal(task.needsDecision, true)
    assert.equal(task.profile?.engine, 'codex-portal')
    assert.equal(task.profile?.model, 'gpt-5.4')
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
    master: { engine: 'codex-portal', presetId: 'deepduet', model: 'gpt-5.4', sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    workerDefault: { engine: 'native', presetId: 'standard' },
  })

  const extMasterHandle = await ctx.agents.create({
    sessionId: 'master-codex',
    meta: { cwd: root, agentPreset: 'deepduet' },
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async ac => { await ctx.agentPresets.mount(ac, 'deepduet') },
  })
  t.after(() => extMasterHandle.dispose())

  // Verify external Master was bound to codex-portal with MASTER_PROMPT & deepduet MCP server
  const boundCfg = ctx.externalCliEngines?.get('codex-portal')?.getSessionConfig?.('master-codex')
  assert.ok(boundCfg)
  assert.match(boundCfg.developerInstructions ?? '', /DeepDuet Master Orchestration/)
  assert.ok(boundCfg.mcpServers?.deepduet)

  // Verify Master turns route through codex-portal
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
  assert.ok(masterMsgs.some(m => m.role === 'assistant' && textOf(m).includes('Codex(gpt-5.4): status check')))

  // 4) Direct Master MCP server protocol & token isolation test
  const mcpServer = await startMasterMcpServer(() => ctx.deepduet.tasks)
  t.after(() => mcpServer.close())
  const mcpCfg = mcpServer.issueMasterConfig('master-codex', () => root)

  // Reject unauthenticated caller
  const unauthRes = await fetch(mcpServer.url, { method: 'POST', body: '{}' })
  assert.equal(unauthRes.status, 401)

  // List tools & invoke session_spawn as master-codex
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
    const task = ctx.deepduet.tasks.listTasks('master-codex').find(item => item.sessionId === spawnedReceipt.sessionId)
    assert.equal(task?.status, 'idle')
    assert.equal(task?.lastSummary, 'native:via mcp')
  })
})
