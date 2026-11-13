import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Approval from '@deepseek-ai/dsh-user-approval'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createDshHost } from '../dist/dsh.js'
import * as plugin from '../dist/index.js'
import { eventually } from './support/fake-host.js'

const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const textOf = message => message.content.map(block => block.type === 'text' ? block.text : '').join('')
const deadline = { timeout: 12000 }

class ScriptedModel extends LlmAdapter {
  constructor(respond) {
    super()
    this.respond = respond
  }

  async *stream(options) {
    const input = options.messages.findLast(message => message.role === 'user'
      && ['user', 'deepduet'].includes(message.source?.kind))
    const text = await this.respond(textOf(input), options)
    if (typeof text === 'object') {
      const call = { type: 'tool-call', id: text.id, name: text.name, arguments: JSON.stringify(text.args) }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
      yield { type: 'block-end', index: 0, block: call }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    }
    yield { type: 'finish', reason: { kind: typeof text === 'object' ? 'tool-calls' : 'stop' } }
  }
}

async function setup(t, respond) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'deepduet-dsh-')))
  const ctx = new Context()
  t.after(async () => {
    try { await ctx.fiber.dispose() }
    finally { await rm(root, { force: true, recursive: true }) }
  })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(Approval)
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') })
  const harness = await mountAgentLoopTestHarness(ctx)
  ctx.llm.registerAdapter(['mock'], new ScriptedModel(respond))
  const master = await harness.create('master', { provider: 'mock', model: 'mock' }, { cwd: root })
  return { ctx, master, root }
}

test('real Agent Loop isolates managed replies from native followups and resumes the worker', deadline, async t => {
  const managed = Promise.withResolvers()
  const managedEntered = Promise.withResolvers()
  const takeover = Promise.withResolvers()
  const takeoverEntered = Promise.withResolvers()
  const cancelEntered = Promise.withResolvers()
  const { ctx, master, root } = await setup(t, async (input, options) => {
    if (input === 'managed') {
      managedEntered.resolve()
      await managed.promise
    }
    if (input === 'native takeover') {
      takeoverEntered.resolve()
      await takeover.promise
    }
    if (input === 'cancel me') {
      cancelEntered.resolve()
      await setTimeout(10000, undefined, { signal: options.signal })
    }
    if (input === 'error') throw new Error('scripted provider failure')
    return 'reply to ' + input
  })
  const host = createDshHost(ctx)
  t.after(() => { managed.resolve(); takeover.resolve() })
  const cwd = join(root, 'child')
  await mkdir(cwd)
  await host.createWorker({ sessionId: 'worker', masterId: master.id, cwd, title: 'Test worker' })
  const worker = ctx.agents.get('worker')
  assert.equal(ctx.workingDirectory.get(worker.session), cwd)
  const turn = host.runTurn(worker.id, 'managed', new AbortController().signal)
  await Promise.race([managedEntered.promise, turn])
  worker.followup(user('native takeover'))
  managed.resolve()
  assert.equal(await turn, 'reply to managed')
  await Promise.race([takeoverEntered.promise, worker.whenIdle()])
  assert.equal(host.isBusy(worker.id), true)
  takeover.resolve()
  await worker.whenIdle()

  const cancel = new AbortController()
  const cancelled = host.runTurn(worker.id, 'cancel me', cancel.signal)
  await cancelEntered.promise
  const queued = user('native after cancellation')
  worker.followup(queued)
  cancel.abort(new Error('stopped'))
  await assert.rejects(cancelled, /stopped/)
  await worker.whenIdle()
  assert.equal(worker.status, 'idle')
  assert.ok(worker.session.deriveMessages().some(message => message.id === queued.id))
  assert.ok(worker.session.deriveMessages().some(message => textOf(message) === 'reply to native after cancellation'))
  await assert.rejects(host.runTurn(worker.id, 'error', new AbortController().signal), /scripted provider failure/)

  await host.releaseWorker(worker.id)
  assert.equal((await host.readSession(worker.id, 20)).status, 'unloaded')
  assert.equal(await host.runTurn(worker.id, 'resumed', new AbortController().signal), 'reply to resumed')

  const resumed = ctx.agents.get(worker.id)
  const resumeMaintenance = Promise.withResolvers()
  const checking = Promise.withResolvers()
  const maintenance = host.withIdleWorker(resumed.id, async checkIdle => {
    checking.resolve()
    await resumeMaintenance.promise
    checkIdle()
    assert.fail('worktree removal must not start with a queued native turn')
  })
  await checking.promise
  resumed.followup(user('native during worktree cleanup'))
  assert.equal(resumed.status, 'idle')
  resumeMaintenance.resolve()
  await assert.rejects(maintenance, /has queued work/)
  await resumed.whenIdle()
  assert.ok(resumed.session.deriveMessages().some(message => textOf(message) === 'reply to native during worktree cleanup'))
  await host.close()
})

test('plugin tools run through DSH, wait for Master idle and deliver a merged decision', deadline, async t => {
  const holdMaster = Promise.withResolvers()
  const finishWorkers = Promise.withResolvers()
  const finishNative = Promise.withResolvers()
  const receipts = []
  const requests = []
  const { ctx, master, root } = await setup(t, async (input, options) => {
    const latest = options.messages.findLast(message => message.role !== 'user' || message.source?.kind === 'user')
    requests.push({ input, options })
    if (input === 'quick') return 'quick reply'
    if (input === 'start workers') {
      if (latest.role !== 'tool') {
        return { id: 'spawn-a', name: 'session_spawn', args: { title: 'A', prompt: 'Worker A', cwd: 'child' } }
      }
      if (receipts.length === 1) {
        return { id: 'spawn-b', name: 'session_spawn', args: { title: 'B', prompt: 'Worker B' } }
      }
      await holdMaster.promise
      return 'Workers started'
    }
    if (input.startsWith('Worker ')) {
      await finishWorkers.promise
      return input === 'Worker A' ? 'Paused\n[NEED_DECISION]: Which option?' : 'Finished B'
    }
    if (input === 'choose option two' && latest.role !== 'tool') {
      return { id: 'steer-a', name: 'session_steer', args: { sessionId: receipts[0].sessionId, instruction: 'Option two' } }
    }
    if (input === 'native during unload') await finishNative.promise
    return 'Received ' + input
  })
  t.after(() => { holdMaster.resolve(); finishWorkers.resolve(); finishNative.resolve() })
  await mkdir(join(root, 'child'))
  const mounted = ctx.plugin(plugin, { projectRoot: root })
  await mounted
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'tool/result' && ['spawn-a', 'spawn-b'].includes(event.data.message.source.callId)) {
      receipts.push(JSON.parse(textOf(event.data.message)))
    }
  })
  master.followup(user('quick'))
  await master.whenIdle()
  assert.equal(ctx.agents.list().length, 1)
  assert.match(textOf(requests[0].options.messages[0]), /Handle quick lookups/)
  master.followup(user('start workers'))
  await eventually(() => assert.equal(receipts.length, 2))
  assert.equal(receipts[0].cwd, join(root, 'child'))
  await eventually(() => assert.equal(requests.filter(request => request.input.startsWith('Worker ')).length, 2))
  const workerRequest = requests.find(request => request.input === 'Worker A')
  assert.match(textOf(workerRequest.options.messages[0]), /You are a DeepDuet background worker/)
  assert.ok(!workerRequest.options.tools?.some(tool => tool.name === 'session_spawn'))
  finishWorkers.resolve()
  await eventually(() => assert.equal(ctx.agents.get(receipts[1].sessionId).status, 'idle'))
  await setTimeout(1550)
  assert.ok(!requests.some(request => request.input.startsWith('[Background Digest]')))
  holdMaster.resolve()
  await eventually(() => assert.equal(requests.filter(request => request.input.startsWith('[Background Digest]')).length, 1))
  const digest = requests.find(request => request.input.startsWith('[Background Digest]'))
  assert.match(digest.input, /Which option\?[\s\S]*Finished B/)
  assert.equal(textOf(digest.options.messages[0]), textOf(requests[0].options.messages[0]))
  master.followup(user('choose option two'))
  await eventually(() => assert.ok(requests.some(request => request.input === 'Option two')))
  await master.whenIdle()
  const nativeWorker = ctx.agents.get(receipts[1].sessionId)
  nativeWorker.followup(user('native during unload'))
  await eventually(() => assert.ok(requests.some(request => request.input === 'native during unload')))
  await mounted.dispose()
  assert.equal(ctx.agents.get(receipts[0].sessionId), undefined)
  assert.equal(ctx.agents.get(nativeWorker.id), nativeWorker)
  assert.equal(nativeWorker.status, 'running')
  assert.equal(ctx.agents.get(master.id), master)
  finishNative.resolve()
  await nativeWorker.whenIdle()
  assert.ok(nativeWorker.session.deriveMessages().some(message => textOf(message) === 'Received native during unload'))
})

test('a Worker tool waits for and respects native approval', deadline, async t => {
  const asked = Promise.withResolvers()
  const answer = Promise.withResolvers()
  const { ctx, master, root } = await setup(t, (input, options) => {
    const result = options.messages.findLast(message => message.role === 'tool')
    return result ? 'approval settled' : { id: 'approval-call', name: 'fixture_approval', args: {} }
  })
  t.after(() => answer.resolve('rejected'))
  ctx.tools.register(defineTool({
    name: 'fixture_approval', description: 'A harmless approval fixture.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
    execute: async () => 'tool executed',
  }))
  ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'fixture_approval' ? { kind: 'ask' } : next())
  ctx.on('approval/request', request => {
    asked.resolve(request)
    return answer.promise
  })
  const host = createDshHost(ctx)
  await host.createWorker({ sessionId: 'approval-worker', masterId: master.id, cwd: root, title: 'Approval worker' })
  const turn = host.runTurn('approval-worker', 'request approval', new AbortController().signal)
  const request = await Promise.race([asked.promise, turn])
  assert.equal(request.agent.id, 'approval-worker')
  assert.equal(host.isBusy('approval-worker'), true)
  answer.resolve('rejected')
  assert.equal(await turn, 'approval settled')
  const events = ctx.agents.get('approval-worker').session.snapshotEvents()
  assert.equal(events.find(event => event.type === 'approval/decided').data.outcome, 'rejected')
  assert.equal(events.find(event => event.type === 'tool/result').data.error.code, 'APPROVAL_REJECTED')
  await host.close()
})
