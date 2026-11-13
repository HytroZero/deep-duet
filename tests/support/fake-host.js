import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout } from 'node:timers/promises'

const exec = promisify(execFile)

export async function eventually(check, ms = 4000) {
  const deadline = Date.now() + ms
  for (;;) {
    try {
      return await check()
    } catch (error) {
      if (Date.now() >= deadline) throw error
    }
    await setTimeout(10)
  }
}

export function fakeHost() {
  const sessions = new Map()
  const turns = new Map()
  const digests = []
  return {
    turns, digests,
    async createWorker(task) {
      sessions.set(task.sessionId, { status: 'idle', messages: [] })
    },
    async runTurn(id, input, signal) {
      signal.throwIfAborted()
      const turn = Promise.withResolvers()
      turns.set(id, { input, ...turn })
      const session = sessions.get(id)
      session.status = 'running'
      session.messages.push({ role: 'user', text: input })
      const abort = () => turn.reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      try {
        const text = await turn.promise
        session.messages.push({ role: 'assistant', text })
        return text
      } finally {
        session.status = 'idle'
        signal.removeEventListener('abort', abort)
      }
    },
    isBusy(id) { return sessions.get(id)?.status === 'running' },
    async releaseWorker() {},
    async withIdleWorker(id, operation) {
      const checkIdle = () => {
        if (this.isBusy(id)) throw new Error(`Session ${id} is busy`)
      }
      checkIdle()
      return operation(checkIdle)
    },
    async readSession(id, limit) {
      const session = sessions.get(id)
      return { ...session, messages: limit ? session.messages.slice(-limit) : [] }
    },
    async runGit(_masterId, cwd, args, beforeExec) {
      beforeExec?.()
      return (await exec('git', args, { cwd })).stdout
    },
    async deliverDigest(id, takeMessage) {
      const message = takeMessage()
      if (message) digests.push({ id, message })
    },
    async close() {},
  }
}
