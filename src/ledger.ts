import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { TaskRecord } from './tasks.js'

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isRecord(value: unknown): value is TaskRecord {
  if (!isObject(value)) return false
  const worktree = value.worktree
  return typeof value.sessionId === 'string' && value.sessionId.length > 0
    && typeof value.masterId === 'string' && value.masterId.length > 0
    && typeof value.title === 'string' && typeof value.goal === 'string'
    && typeof value.cwd === 'string' && isAbsolute(value.cwd)
    && ['running', 'idle', 'failed', 'completed'].some(status => status === value.status)
    && typeof value.needsDecision === 'boolean'
    && (value.decisionQuestion === undefined || typeof value.decisionQuestion === 'string')
    && (value.lastSummary === undefined || typeof value.lastSummary === 'string')
    && typeof value.createdAt === 'number' && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0
    && typeof value.updatedAt === 'number' && Number.isSafeInteger(value.updatedAt) && value.updatedAt >= 0
    && (worktree === undefined || (isObject(worktree) && typeof worktree.repoRoot === 'string'
      && isAbsolute(worktree.repoRoot) && worktree.path === value.cwd && typeof worktree.branch === 'string'))
}

/** Open the ledger stored as `deepduet-ledger.json` inside `directory`. */
export async function openLedger(directory: string) {
  const path = join(directory, 'deepduet-ledger.json')
  let records = new Map<string, TaskRecord>()

  const contents = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  if (contents !== undefined) {
    try {
      const data: unknown = JSON.parse(contents)
      if (!isObject(data) || data.version !== 1 || !Array.isArray(data.tasks)) {
        throw new Error('Invalid ledger format')
      }
      for (const record of data.tasks) {
        if (!isRecord(record) || records.has(record.sessionId)) throw new Error('Invalid or duplicate task')
        records.set(record.sessionId, record)
      }
    } catch (cause) {
      throw new Error(`Cannot read DeepDuet ledger at ${path}`, { cause })
    }
  }

  async function commit(next: Map<string, TaskRecord>) {
    await mkdir(directory, { recursive: true })
    const temporary = join(directory, `.deepduet-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, tasks: [...next.values()] }, null, 2) + '\n', {
        flag: 'wx', mode: 0o600,
      })
      await rename(temporary, path)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
    records = next
  }

  const recovered = new Map(records)
  let changed = false
  for (const record of records.values()) {
    if (record.status !== 'running') continue
    changed = true
    const { decisionQuestion: _question, ...task } = record
    recovered.set(record.sessionId, {
      ...task, status: 'failed', needsDecision: false,
      lastSummary: 'Interrupted by process restart', updatedAt: Date.now(),
    })
  }
  if (changed) await commit(recovered)

  let pending = Promise.resolve()
  let closed = false
  return {
    has(sessionId: string) {
      return records.has(sessionId)
    },
    get(sessionId: string) {
      return structuredClone(records.get(sessionId))
    },
    list() {
      return structuredClone([...records.values()])
    },
    put(record: TaskRecord) {
      if (closed) return Promise.reject(new Error('DeepDuet ledger is closed'))
      const snapshot = structuredClone(record)
      const write = pending.then(() => commit(new Map(records).set(snapshot.sessionId, snapshot)))
      pending = write.catch(() => {})
      return write
    },
    close() {
      closed = true
      return pending
    },
  }
}
