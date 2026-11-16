import { randomUUID } from 'node:crypto'
import { appendFile, lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, normalize, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { createDigestQueue } from './digest.js'
import type { DshHost } from './dsh.js'
import { openLedger } from './ledger.js'
import { summarize } from './text.js'

const MAX_TAIL = 20
const MAX_GIT_STATUS_LINES = 200
const STATE_EXCLUDE_PATTERN = '/.dsh/'

export type TaskContext = { masterId: string; cwd: string }
export type SpawnInput = { title: string; prompt: string; cwd?: string; isolateWorktree?: boolean }
export type SteerInput = { sessionId: string; instruction: string }
export type InspectInput = { sessionId?: string; tailMessages?: number }
export type ManageInput = { sessionId: string; action: 'stop' | 'archive' | 'remove_worktree' }
export type WorkerStatus = 'running' | 'idle' | 'failed' | 'completed'

export type TaskRecord = {
  sessionId: string
  masterId: string
  title: string
  goal: string
  cwd: string
  status: WorkerStatus
  needsDecision: boolean
  decisionQuestion?: string
  lastSummary?: string
  worktree?: { repoRoot: string; path: string; branch: string }
  createdAt: number
  updatedAt: number
}

export class TaskError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

type Run = {
  controller: AbortController
  turn: Promise<string>
  outcome?: TaskRecord
}

type TaskInspection =
  | { tasks: Omit<TaskRecord, 'goal' | 'masterId'>[] }
  | { task: TaskRecord; session: Awaited<ReturnType<DshHost['readSession']>>; gitStatus: { text: string } | { unavailable: true } }

function requireText(text: string, field: string) {
  if (!text.trim()) throw new TaskError('INVALID_ARGS', `${field} must not be empty`)
}

function parseReply(reply: string) {
  const text = reply.trim()
  const lines = text.split(/\r?\n/)
  let fence: string | undefined
  for (const line of lines.slice(0, -1)) {
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (!delimiter) continue
    if (!fence) fence = delimiter
    else if (delimiter[0] === fence[0] && delimiter.length >= fence.length && line.trim() === delimiter) fence = undefined
  }
  const question = !fence ? /^\[NEED_DECISION\]:[ \t]*(\S.*)$/.exec(lines.at(-1) ?? '')?.[1] : undefined
  return {
    needsDecision: question !== undefined,
    ...(question === undefined ? {} : { decisionQuestion: question }),
    lastSummary: summarize(question === undefined ? text : lines.slice(0, -1).join('\n').trim()),
  }
}

async function resolveCwd(base: string, requested?: string) {
  if (requested !== undefined) requireText(requested, 'cwd')
  const path = resolve(base, requested ?? '.')
  try {
    const cwd = await realpath(path)
    if (!(await stat(cwd)).isDirectory()) throw new Error('Expected a directory')
    return cwd
  } catch (cause) {
    throw new TaskError('INVALID_CWD', `Cannot use working directory ${path}`, { cause })
  }
}

function truncateLines(text: string, limit: number) {
  const lines = text.split('\n')
  if (lines.length <= limit) return text
  return [...lines.slice(0, limit), `… (${lines.length - limit} more lines)`].join('\n')
}

/**
 * Managed worktrees live under `<repo>/.dsh/`, so keep that directory out of the main checkout's
 * status and `git add -A` through the repository-local exclude file (never the tracked .gitignore).
 */
async function excludeStateDirectory(repoRoot: string, host: DshHost, masterId: string) {
  const commonDir = resolve(repoRoot, (await host.runGit(masterId, repoRoot, ['rev-parse', '--git-common-dir'])).trimEnd())
  const file = join(commonDir, 'info', 'exclude')
  const existing = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return ''
  })
  if (existing.split(/\r?\n/).some(line => line.trim() === STATE_EXCLUDE_PATTERN)) return
  await mkdir(dirname(file), { recursive: true })
  const separator = existing && !existing.endsWith('\n') ? '\n' : ''
  await appendFile(file, `${separator}# DeepDuet worktrees and task state\n${STATE_EXCLUDE_PATTERN}\n`)
}

async function createWorktree(cwd: string, id: string, host: DshHost, masterId: string): Promise<NonNullable<TaskRecord['worktree']>> {
  let path: string | undefined
  try {
    const stdout = await host.runGit(masterId, cwd, ['rev-parse', '--show-toplevel'])
    const repoRoot = await realpath(stdout.trimEnd())
    path = join(repoRoot, '.dsh', 'worktrees', id)
    const branch = `deepduet/${id}`
    await excludeStateDirectory(repoRoot, host, masterId)
    await host.runGit(masterId, repoRoot, ['worktree', 'add', '-b', branch, '--', path])
    return { repoRoot, path, branch }
  } catch (cause) {
    const location = path ? ` at ${path}` : ''
    throw new TaskError('WORKTREE_CREATE_FAILED', `Cannot create Git worktree${location}: ${String(cause)}`, { cause })
  }
}

async function removeWorktree(
  { repoRoot, path, branch }: NonNullable<TaskRecord['worktree']>, host: DshHost, masterId: string,
  beforeRemove?: () => void,
) {
  const registration = await host.runGit(masterId, repoRoot, ['worktree', 'list', '--porcelain', '-z'])
  const checkout = registration.split('\0\0').find(entry => {
    const [location = ''] = entry.split('\0', 1)
    return location.startsWith('worktree ') && normalize(location.slice('worktree '.length)) === normalize(path)
  })
  if (!checkout) {
    const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    if (!entry) return
  }
  if (!checkout || !checkout.split('\0').includes(`branch refs/heads/${branch}`)) {
    throw new Error('Git registration no longer matches the managed worktree')
  }
  await host.runGit(masterId, repoRoot, ['worktree', 'remove', '--', path], beforeRemove)
}

/** Undo a worktree created for a spawn that never started: drop the checkout and its unused branch. */
async function discardWorktree(worktree: NonNullable<TaskRecord['worktree']>, host: DshHost, masterId: string) {
  await removeWorktree(worktree, host, masterId)
  await host.runGit(masterId, worktree.repoRoot, ['branch', '-D', '--', worktree.branch])
}

export type TaskManager = Awaited<ReturnType<typeof openTasks>>

export async function openTasks(
  ledgerDirectory: string,
  host: DshHost,
  warn: (message: string) => void,
  onChange?: (record: TaskRecord) => void,
) {
  const ledger = await openLedger(ledgerDirectory)
  async function save(record: TaskRecord) {
    await ledger.put(record)
    onChange?.(structuredClone(record))
  }
  const digests = createDigestQueue(host.deliverDigest, warn)
  const runs = new Map<string, Run>()
  const provisioning = new Set<string>()
  const mutations = new Map<string, Promise<unknown>>()
  let closing: Promise<void> | undefined

  function checkOpen() {
    if (closing) throw new TaskError('PLUGIN_CLOSED', 'DeepDuet is closing')
  }

  function owned(masterId: string, sessionId: string) {
    const record = ledger.get(sessionId)
    if (record?.masterId !== masterId) throw new TaskError('TASK_NOT_FOUND', `Task ${sessionId} was not found`)
    return record
  }

  function mutate<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const result = (mutations.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(operation)
    mutations.set(sessionId, result)
    return result.finally(() => {
      if (mutations.get(sessionId) === result) mutations.delete(sessionId)
    })
  }

  /** Persist a finished turn, release its run, and queue the Master notification. */
  async function finish(run: Run, outcome: TaskRecord) {
    await save(outcome)
    if (runs.get(outcome.sessionId) === run) runs.delete(outcome.sessionId)
    digests.enqueue({
      masterId: outcome.masterId, sessionId: outcome.sessionId, title: outcome.title,
      status: outcome.status === 'failed' ? 'failed' : 'idle', needsDecision: outcome.needsDecision,
      decisionQuestion: outcome.decisionQuestion, summary: outcome.lastSummary ?? '',
    })
  }

  function start(record: TaskRecord, instruction: string) {
    const { sessionId } = record
    const controller = new AbortController()
    const turn = Promise.resolve().then(() => {
      if (closing) controller.abort(new Error('DeepDuet unloaded'))
      return host.runTurn(sessionId, instruction, controller.signal)
    })
    const run: Run = { controller, turn }
    runs.set(sessionId, run)

    void turn.then(
      reply => settle('idle', parseReply(reply)),
      error => settle('failed', { needsDecision: false, lastSummary: summarize(String(error)) }),
    ).catch(error => warn(`DeepDuet could not save result for ${sessionId}: ${String(error)}`))

    async function settle(status: 'idle' | 'failed', result: ReturnType<typeof parseReply>) {
      if (controller.signal.aborted) return
      const outcome = run.outcome = { ...record, ...result, status, updatedAt: Date.now() }
      while (!controller.signal.aborted && !closing) {
        try {
          await mutate(sessionId, async () => {
            if (runs.get(sessionId) !== run || controller.signal.aborted || closing) return
            await finish(run, outcome)
          })
          return
        } catch (error) {
          warn(`DeepDuet will retry saving result for ${sessionId}: ${String(error)}`)
          await setTimeout(1_000, undefined, { signal: controller.signal, ref: false }).catch(() => {})
        }
      }
    }
  }

  function requireIdle(record: TaskRecord) {
    if (runs.has(record.sessionId) || host.isBusy(record.sessionId)) {
      throw new TaskError('TASK_BUSY', `Task ${record.sessionId} is busy. Wait for it or stop the managed turn.`)
    }
  }

  function receipt({ sessionId, title, cwd, status }: TaskRecord) {
    return { sessionId, title, cwd, status }
  }

  return {
    isWorker(sessionId: string) {
      return provisioning.has(sessionId) || ledger.has(sessionId)
    },

    listTasks(masterId?: string) {
      const items = ledger.list()
      return masterId === undefined ? items : items.filter(task => task.masterId === masterId)
    },

    async spawn(ctx: TaskContext, input: SpawnInput) {
      checkOpen()
      if (provisioning.has(ctx.masterId) || ledger.has(ctx.masterId)) {
        throw new TaskError('MASTER_REQUIRED', 'Only a Master session can spawn DeepDuet workers')
      }
      requireText(input.title, 'title')
      requireText(input.prompt, 'prompt')
      const sessionId = `session-${randomUUID()}`
      return mutate(sessionId, async () => {
        const cwd = await resolveCwd(ctx.cwd, input.cwd)
        const worktree = input.isolateWorktree ? await createWorktree(cwd, sessionId, host, ctx.masterId) : undefined
        const record: TaskRecord = {
          sessionId, masterId: ctx.masterId, title: input.title, goal: input.prompt,
          cwd: worktree?.path ?? cwd, ...(worktree && { worktree }),
          status: 'running', needsDecision: false, createdAt: Date.now(), updatedAt: Date.now(),
        }
        provisioning.add(sessionId)
        try {
          await host.createWorker(record)
          await save(record)
        } catch (cause) {
          try {
            await host.releaseWorker(sessionId)
            if (worktree) await discardWorktree(worktree, host, ctx.masterId)
          } catch (cleanup) {
            throw new TaskError('SPAWN_FAILED',
              `Could not start worker: ${String(cause)}. Cleanup failed; resources may remain at ${record.cwd}: ${String(cleanup)}`,
              { cause })
          }
          throw new TaskError('SPAWN_FAILED', `Could not start worker: ${String(cause)}`, { cause })
        } finally {
          provisioning.delete(sessionId)
        }
        start(record, input.prompt)
        return receipt(record)
      })
    },

    async steer(ctx: TaskContext, input: SteerInput) {
      checkOpen()
      requireText(input.instruction, 'instruction')
      return mutate(input.sessionId, async () => {
        const record = owned(ctx.masterId, input.sessionId)
        if (record.status === 'completed') throw new TaskError('TASK_ARCHIVED', 'This task has been archived')
        requireIdle(record)
        const { decisionQuestion: _question, lastSummary: _summary, ...previous } = record
        const next: TaskRecord = { ...previous, status: 'running', needsDecision: false, updatedAt: Date.now() }
        await save(next)
        digests.forget(ctx.masterId, input.sessionId)
        start(next, input.instruction)
        return receipt(next)
      })
    },

    async inspect(ctx: TaskContext, input: InspectInput): Promise<TaskInspection> {
      checkOpen()
      if (input.sessionId === undefined) {
        return { tasks: ledger.list().filter(task => task.masterId === ctx.masterId && task.status !== 'completed')
          .map(({ goal: _goal, masterId: _masterId, ...task }) => task) }
      }
      const task = owned(ctx.masterId, input.sessionId)
      if (input.tailMessages !== undefined && (!Number.isSafeInteger(input.tailMessages) || input.tailMessages < 0)) {
        throw new TaskError('INVALID_ARGS', 'tailMessages must be a non-negative integer')
      }
      const limit = Math.min(MAX_TAIL, input.tailMessages ?? 5)
      const session = await host.readSession(task.sessionId, limit)
      const gitStatus = await host.runGit(ctx.masterId, session.cwd ?? task.cwd, ['status', '--short'])
        .then(stdout => ({ text: truncateLines(stdout.trimEnd(), MAX_GIT_STATUS_LINES) }), () => ({ unavailable: true as const }))
      return { task, session, gitStatus }
    },

    async manage(ctx: TaskContext, { sessionId, action }: ManageInput) {
      checkOpen()
      return mutate(sessionId, async () => {
        const record = owned(ctx.masterId, sessionId)
        if (action === 'stop') {
          const run = runs.get(sessionId)
          if (run) {
            run.controller.abort(new Error('Stopped by Master'))
            const reply = await run.turn.then(text => text, () => undefined)
            if (reply !== undefined) {
              // The turn finished before the abort landed; keep its real result instead of discarding it.
              const outcome: TaskRecord = { ...record, ...parseReply(reply), status: 'idle', updatedAt: Date.now() }
              if (!outcome.needsDecision) delete outcome.decisionQuestion
              await finish(run, outcome)
              return receipt(outcome)
            }
            runs.delete(sessionId)
          } else {
            requireIdle(record)
          }
          digests.forget(ctx.masterId, sessionId)
          let stopped = record
          // Only an interrupted turn or an outstanding decision changes state; keep idle/failed/completed results intact.
          if (record.status === 'running' || (record.status !== 'completed' && record.needsDecision)) {
            const { decisionQuestion: _question, ...previous } = record
            stopped = {
              ...previous, status: 'idle', needsDecision: false, lastSummary: 'Stopped by Master', updatedAt: Date.now(),
            }
            await save(stopped)
          }
          return receipt(stopped)
        }

        requireIdle(record)
        // Archived tasks cannot be steered, so any outstanding decision is withdrawn.
        const { decisionQuestion: _question, ...archivable } = record
        const archived: TaskRecord = { ...archivable, status: 'completed', needsDecision: false, updatedAt: Date.now() }
        if (action === 'remove_worktree') {
          const worktree = record.worktree
          if (!worktree) throw new TaskError('NO_MANAGED_WORKTREE', 'This task has no managed worktree')
          try {
            return await host.withIdleWorker(sessionId, async checkIdle => {
              // Persist a non-steerable record before the checkout can disappear.
              await save(archived)
              try {
                await removeWorktree(worktree, host, ctx.masterId, checkIdle)
              } catch (cause) {
                try {
                  const remaining = await lstat(worktree.path).catch((error: NodeJS.ErrnoException) => {
                    if (error.code !== 'ENOENT') throw error
                  })
                  if (remaining) await save(record)
                } catch (rollbackError) {
                  throw new Error(`Could not restore the task after removal failed: ${String(rollbackError)}`, { cause })
                }
                throw cause
              }
              digests.forget(ctx.masterId, sessionId)
              const { worktree: _worktree, ...removed } = archived
              await save(removed)
              return receipt(removed)
            })
          } catch (cause) {
            throw new TaskError('WORKTREE_REMOVE_FAILED', `Cannot remove or record removal of ${worktree.path}: ${String(cause)}`, { cause })
          }
        }
        await save(archived)
        digests.forget(ctx.masterId, sessionId)
        return receipt(archived)
      })
    },

    close() {
      return closing ??= Promise.resolve().then(async () => {
        const closingDigests = digests.close()
        for (const run of runs.values()) run.controller.abort(new Error('DeepDuet unloaded'))
        await Promise.allSettled(mutations.values())
        const active = [...runs.entries()]
        const stopped = await Promise.allSettled(active.map(async ([sessionId, run]) => {
          await run.turn.catch(() => {})
          const record = ledger.get(sessionId)
          if (record?.status === 'running') {
            await save(run.outcome ?? {
              ...record, status: 'failed', lastSummary: 'Interrupted by plugin unload', updatedAt: Date.now(),
            })
          }
        }))
        runs.clear()
        const shutdown = await Promise.allSettled([closingDigests, host.close(), ledger.close()])
        const errors = [...stopped, ...shutdown].filter(result => result.status === 'rejected').map(result => result.reason)
        if (errors.length) throw new AggregateError(errors, 'Could not close DeepDuet cleanly')
      })
    },
  }
}
