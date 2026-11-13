import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openLedger } from '../dist/ledger.js'

test('concurrent puts persist snapshots and recovery preserves finished results', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deepduet-ledger-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ledger = await openLedger(root)
  const task = {
    masterId: 'master', sessionId: 'a', title: 'A', goal: 'do A', cwd: root,
    status: 'running', needsDecision: false, createdAt: 1, updatedAt: 1,
  }
  await Promise.all([
    ledger.put(task),
    ledger.put({ ...task, sessionId: 'b', status: 'idle', lastSummary: 'Finished' }),
  ])
  ledger.get('b').lastSummary = 'tampered'
  await ledger.close()
  const reopened = await openLedger(root)
  assert.equal(reopened.get('a').status, 'failed')
  assert.equal(reopened.get('a').lastSummary, 'Interrupted by process restart')
  assert.equal(reopened.get('b').lastSummary, 'Finished')
  await reopened.close()
})

test('a corrupt or unsupported ledger is preserved', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deepduet-corrupt-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.dsh'))
  const path = join(root, '.dsh', 'deepduet-ledger.json')
  const original = '{"version":2}'
  await writeFile(path, original)
  await assert.rejects(openLedger(root), /Cannot read DeepDuet ledger/)
  assert.equal(await readFile(path, 'utf8'), original)
})
