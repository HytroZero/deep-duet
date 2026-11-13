import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openTasks } from '../dist/tasks.js'
import { createDeepDuetRemoteHandlers } from '../dist/host-remote.js'
import { eventually, fakeHost } from './support/fake-host.js'

async function setup(t, warn = assert.fail) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'deepduet-tasks-')))
  const host = fakeHost()
  const tasks = await openTasks(cwd, host, warn)
  t.after(async () => {
    await tasks.close()
    await rm(cwd, { force: true, recursive: true })
  })
  const ctx = { masterId: 'master', cwd }
  return { ctx, tasks, host }
}

test('spawns concurrently, preserves the full decision, steers and archives', async t => {
  const { ctx, tasks, host } = await setup(t)
  const [a, b] = await Promise.all(['A', 'B'].map(title => tasks.spawn(ctx, { title, prompt: `Do ${title}` })))
  assert.equal(a.status, 'running')
  assert.equal(b.status, 'running')
  await assert.rejects(tasks.steer(ctx, { sessionId: a.sessionId, instruction: 'wait' }), { code: 'TASK_BUSY' })
  await assert.rejects(tasks.inspect({ ...ctx, masterId: 'other' }, a), { code: 'TASK_NOT_FOUND' })
  const question = 'Which option? ' + 'x'.repeat(600)
  host.turns.get(a.sessionId).resolve(`${'s'.repeat(550)}\n[NEED_DECISION]: ${question}`)
  host.turns.get(b.sessionId).resolve('Finished B')
  await eventually(() => assert.equal(host.digests.length, 1))
  assert.ok(host.digests[0].message.includes(question))
  assert.ok(host.digests[0].message.includes('Finished B'))
  const { task, session } = await tasks.inspect(ctx, { sessionId: a.sessionId, tailMessages: 1 })
  assert.equal(task.lastSummary.length, 500)
  assert.equal(task.decisionQuestion, question)
  assert.equal(session.messages.length, 1)
  await tasks.steer(ctx, { sessionId: a.sessionId, instruction: 'Option 2' })
  assert.equal(host.turns.get(a.sessionId).input, 'Option 2')
  host.turns.get(a.sessionId).resolve('Done')
  await eventually(async () => assert.equal((await tasks.inspect(ctx, a)).task.status, 'idle'))
  await tasks.manage(ctx, { sessionId: a.sessionId, action: 'archive' })
  assert.deepEqual((await tasks.inspect(ctx, {})).tasks.map(task => task.sessionId), [b.sessionId])
  await assert.rejects(tasks.steer(ctx, { sessionId: a.sessionId, instruction: 'again' }), { code: 'TASK_ARCHIVED' })
})

test('persists a finished result and delivers it after ledger writes recover', async t => {
  const failedWrite = Promise.withResolvers()
  const { ctx, tasks, host } = await setup(t, failedWrite.resolve)
  const task = await tasks.spawn(ctx, { title: 'Task', prompt: 'Start' })
  const directory = join(ctx.cwd, '.dsh')
  const backup = `${directory}-backup`
  await rename(directory, backup)
  await writeFile(directory, 'temporarily unavailable')
  host.turns.get(task.sessionId).resolve('Finished despite the write failure')
  assert.match(await failedWrite.promise, /retry saving result/)
  await assert.rejects(tasks.steer(ctx, { ...task, instruction: 'Continue' }), { code: 'TASK_BUSY' })
  await rm(directory)
  await rename(backup, directory)
  await eventually(() => assert.match(host.digests[0]?.message ?? '', /Finished despite the write failure/))
  const ledger = JSON.parse(await readFile(join(directory, 'deepduet-ledger.json'), 'utf8'))
  assert.equal(ledger.tasks[0].status, 'idle')
})

test('stop prevents late settlements and supports retry after execution failure', async t => {
  const { ctx, tasks, host } = await setup(t)
  const { sessionId } = await tasks.spawn(ctx, { title: 'Task', prompt: 'Start' })
  const first = host.turns.get(sessionId)
  await tasks.manage(ctx, { sessionId, action: 'stop' })
  first.resolve('stale')
  assert.equal((await tasks.inspect(ctx, { sessionId })).task.lastSummary, 'Stopped by Master')
  await tasks.steer(ctx, { sessionId, instruction: 'Continue' })
  host.turns.get(sessionId).reject(new Error('model offline'))
  await eventually(async () => assert.equal((await tasks.inspect(ctx, { sessionId })).task.status, 'failed'))
  assert.match((await tasks.inspect(ctx, { sessionId })).task.lastSummary, /model offline/)
  assert.equal((await tasks.steer(ctx, { sessionId, instruction: 'Retry' })).status, 'running')
})

test('creates a real worktree and retains dirty files on a refused removal', async t => {
  const { ctx, tasks, host } = await setup(t)
  const git = (...args) => execFileSync('git', args, { cwd: ctx.cwd, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.org', '-c', 'commit.gpgsign=false',
    'commit', '--allow-empty', '-qm', 'initial')
  const task = await tasks.spawn(ctx, { title: 'Isolated', prompt: 'Edit', isolateWorktree: true })
  const { sessionId, cwd } = task
  assert.equal(cwd, join(ctx.cwd, '.dsh', 'worktrees', sessionId))
  await tasks.manage(ctx, { sessionId, action: 'stop' })
  const changed = join(cwd, 'keep.txt')
  await writeFile(changed, 'pending')
  await assert.rejects(tasks.manage(ctx, { sessionId, action: 'remove_worktree' }), { code: 'WORKTREE_REMOVE_FAILED' })
  assert.equal((await tasks.inspect(ctx, task)).gitStatus.text, '?? keep.txt')
  await rm(changed)

  const remove = () => tasks.manage(ctx, { sessionId, action: 'remove_worktree' })
  const ledger = join(ctx.cwd, '.dsh', 'deepduet-ledger.json')
  const backup = `${ledger}.backup`
  await rename(ledger, backup)
  await mkdir(ledger)
  await assert.rejects(remove(), { code: 'WORKTREE_REMOVE_FAILED' })
  assert.ok((await stat(cwd)).isDirectory())
  await rm(ledger, { recursive: true })
  await rename(backup, ledger)

  const runGit = host.runGit
  const isBusy = host.isBusy
  host.runGit = async (...args) => {
    const result = await runGit(...args)
    if (args[2][1] === 'list') host.isBusy = () => true
    return result
  }
  await assert.rejects(remove(), /Session .* is busy/)
  assert.ok((await stat(cwd)).isDirectory())
  assert.equal((await tasks.inspect(ctx, task)).task.status, 'idle')
  host.isBusy = isBusy

  host.runGit = async (...args) => {
    const result = await runGit(...args)
    if (args[2][1] === 'remove') {
      await rename(ledger, backup)
      await mkdir(ledger)
    }
    return result
  }
  await assert.rejects(remove(), { code: 'WORKTREE_REMOVE_FAILED' })
  await assert.rejects(stat(cwd), { code: 'ENOENT' })
  await assert.rejects(tasks.steer(ctx, { sessionId, instruction: 'Continue' }), { code: 'TASK_ARCHIVED' })
  await rm(ledger, { recursive: true })
  await rename(backup, ledger)
  assert.equal(JSON.parse(await readFile(ledger, 'utf8')).tasks[0].status, 'completed')
  host.runGit = runGit
  assert.equal((await remove()).status, 'completed')
  assert.match(git('branch', '--list'), new RegExp(`deepduet/${sessionId}`))
})

test('archiving withdraws an outstanding decision', async t => {
  const { ctx, tasks, host } = await setup(t)
  const { sessionId } = await tasks.spawn(ctx, { title: 'Task', prompt: 'Start' })
  host.turns.get(sessionId).resolve('Plan ready\n[NEED_DECISION]: Delete the cache?')
  await eventually(async () => assert.equal((await tasks.inspect(ctx, { sessionId })).task.needsDecision, true))
  await tasks.manage(ctx, { sessionId, action: 'archive' })
  const { task } = await tasks.inspect(ctx, { sessionId })
  assert.equal(task.status, 'completed')
  assert.equal(task.needsDecision, false)
  assert.equal(task.decisionQuestion, undefined)
  assert.equal(task.lastSummary, 'Plan ready')
})

test('stopping an idle failed task keeps its failure result', async t => {
  const { ctx, tasks, host } = await setup(t)
  const { sessionId } = await tasks.spawn(ctx, { title: 'Task', prompt: 'Start' })
  host.turns.get(sessionId).reject(new Error('model offline'))
  await eventually(async () => assert.equal((await tasks.inspect(ctx, { sessionId })).task.status, 'failed'))
  const receipt = await tasks.manage(ctx, { sessionId, action: 'stop' })
  assert.equal(receipt.status, 'failed')
  const { task } = await tasks.inspect(ctx, { sessionId })
  assert.equal(task.status, 'failed')
  assert.match(task.lastSummary, /model offline/)
})

test('remote handlers enforce the caller Master ownership', async t => {
  const { ctx, tasks, host } = await setup(t)
  const remote = createDeepDuetRemoteHandlers({
    ctx: { agents: { get: () => undefined }, workingDirectory: { get: () => ctx.cwd } },
    host, projectRoot: ctx.cwd, getTasks: () => tasks,
  })
  const { sessionId } = await tasks.spawn(ctx, { title: 'Task', prompt: 'Start' })
  host.turns.get(sessionId).resolve('Done')
  await eventually(async () => assert.equal((await tasks.inspect(ctx, { sessionId })).task.status, 'idle'))
  const foreign = { masterId: 'other', sessionId }
  await assert.rejects(remote.remoteManage({ ...foreign, action: 'archive' }), { code: 'TASK_NOT_FOUND' })
  await assert.rejects(remote.remoteSteer({ ...foreign, instruction: 'Continue' }), { code: 'TASK_NOT_FOUND' })
  await assert.rejects(remote.remoteInspect(foreign), { code: 'TASK_NOT_FOUND' })
  assert.equal((await tasks.inspect(ctx, { sessionId })).task.status, 'idle')
  assert.equal((await remote.remoteManage({ masterId: ctx.masterId, sessionId, action: 'archive' })).status, 'completed')
})
