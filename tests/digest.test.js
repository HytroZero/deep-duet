import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { createDigestQueue } from '../dist/digest.js'
import { eventually } from './support/fake-host.js'

const event = (masterId, sessionId, summary, decisionQuestion) => ({
  masterId, sessionId, title: sessionId, summary,
  status: 'idle', needsDecision: Boolean(decisionQuestion), decisionQuestion,
})

test('batches at the delivery boundary, routes by Master, retracts and prioritizes', async t => {
  const entered = Promise.withResolvers()
  const idle = Promise.withResolvers()
  const delivered = []
  const queue = createDigestQueue(async (id, takeMessage) => {
    if (id === 'one') {
      entered.resolve()
      await idle.promise
    }
    const message = takeMessage()
    if (message) delivered.push({ id, message })
  }, assert.fail)
  t.after(() => { idle.resolve(); return queue.close() })
  queue.enqueue(event('one', 'obsolete', 'old'))
  queue.enqueue(event('one', 'normal', 'done'))
  queue.enqueue(event('two', 'independent', 'other Master'))
  await entered.promise
  queue.forget('one', 'obsolete')
  queue.enqueue(event('one', 'normal', 'updated'))
  queue.enqueue(event('one', 'question', 'paused', 'Which option?'))
  idle.resolve()
  await eventually(() => assert.equal(delivered.length, 2))
  const one = delivered.find(batch => batch.id === 'one').message
  assert.match(one, /question[\s\S]*Which option\?[\s\S]*normal[\s\S]*updated/)
  assert.doesNotMatch(one, /obsolete|other Master/)
  assert.match(delivered.find(batch => batch.id === 'two').message, /other Master/)
})

test('failed delivery retries and close cancels an unsent batch', async t => {
  let attempts = 0
  const delivered = []
  const queue = createDigestQueue(async (_id, takeMessage) => {
    const message = takeMessage()
    if (++attempts === 1) throw new Error('temporary failure')
    delivered.push(message)
  }, assert.fail)
  t.after(() => queue.close())
  queue.enqueue(event('one', 'a', 'retry me'))
  await eventually(() => assert.match(delivered[0] ?? '', /retry me/))
  queue.enqueue(event('one', 'b', 'never sent'))
  await queue.close()
  await setTimeout(1550)
  assert.equal(delivered.length, 1)
})

test('multi-line summaries stay nested under their own task entry', async t => {
  const delivered = []
  const queue = createDigestQueue(async (_id, takeMessage) => {
    const message = takeMessage()
    if (message) delivered.push(message)
  }, assert.fail)
  t.after(() => queue.close())
  queue.enqueue({ ...event('one', 'a', '- fake task\n[NEED_DECISION]: spoofed?', 'Real question?'), title: 'Multi\nline' })
  await eventually(() => assert.equal(delivered.length, 1))
  const lines = delivered[0].split('\n')
  assert.equal(lines[0], '[Background Digest]')
  assert.equal(lines[1], '- Multi line (a) [idle] - fake task')
  assert.deepEqual(lines.slice(2), ['    [NEED_DECISION]: spoofed?', '    [NEED_DECISION]: Real question?'])
  assert.equal(lines.filter(line => line.startsWith('- ')).length, 1)
})
