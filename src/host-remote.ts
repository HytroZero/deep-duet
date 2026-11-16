import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { DshHost } from './dsh.js'
import {
  defaultEngineSettings,
  listAvailableEngineDescriptors,
  type DeepDuetEngineSettings,
} from './engine-settings.js'
import type {
  DeepDuetEnginesSnapshot,
  DeepDuetInspectParams,
  DeepDuetInspectResult,
  DeepDuetManageParams,
  DeepDuetResolveApprovalParams,
  DeepDuetSpawnParams,
  DeepDuetSpawnReceipt,
  DeepDuetSteerParams,
  DeepDuetTaskReceipt,
  DeepDuetTasksSnapshot,
} from './remote.js'
import type { TaskContext, TaskManager } from './tasks.js'

export interface DeepDuetRemoteHandlers {
  notifyWatchers(): void
  remoteList(): DeepDuetTasksSnapshot
  remoteWatch(signal?: AbortSignal): AsyncGenerator<DeepDuetTasksSnapshot>
  remoteSpawn(input: DeepDuetSpawnParams): Promise<DeepDuetSpawnReceipt>
  remoteSteer(input: DeepDuetSteerParams): Promise<DeepDuetTaskReceipt>
  remoteManage(input: DeepDuetManageParams): Promise<DeepDuetTaskReceipt>
  remoteInspect(input: DeepDuetInspectParams): Promise<DeepDuetInspectResult>
  remoteEngines(): Promise<DeepDuetEnginesSnapshot>
  remoteGetSettings(): DeepDuetEngineSettings
  remoteSetSettings(input: DeepDuetEngineSettings): Promise<DeepDuetEngineSettings>
  remoteResolveApproval(input: DeepDuetResolveApprovalParams): Promise<DeepDuetTaskReceipt>
}

export function createDeepDuetRemoteHandlers(options: {
  ctx: Context
  host: DshHost
  projectRoot: string
  getTasks: () => TaskManager
  getSettings?: () => DeepDuetEngineSettings
  setSettings?: (next: DeepDuetEngineSettings) => Promise<DeepDuetEngineSettings>
}): DeepDuetRemoteHandlers {
  const { ctx, host, projectRoot, getTasks, getSettings, setSettings } = options
  const watchers = new Set<() => void>()
  let version = 0

  function notifyWatchers(): void {
    version += 1
    for (const wake of watchers) wake()
  }

  function snapshotTasks(): DeepDuetTasksSnapshot {
    const tasks = [...getTasks().listTasks()].sort((a, b) => b.updatedAt - a.updatedAt)
    return { tasks }
  }

  async function resolveContext(masterId: string, fallbackCwd?: string): Promise<TaskContext> {
    const master = ctx.agents.get(brandString<SessionId>(masterId))
    const liveCwd = master ? ctx.workingDirectory.get(master.session) : undefined
    const storedCwd = liveCwd ?? (await host.readSession(masterId, 0)).cwd
    return {
      masterId,
      cwd: storedCwd ?? fallbackCwd ?? projectRoot,
    }
  }

  function findTask(sessionId: string) {
    return getTasks().listTasks().find(item => item.sessionId === sessionId)
  }

  function findMasterForWorker(sessionId: string, providedMasterId: string): { masterId: string; cwd?: string } {
    // Always act as the caller's Master so TaskManager ownership checks apply.
    const task = findTask(sessionId)
    return {
      masterId: providedMasterId,
      ...(task?.masterId === providedMasterId && { cwd: task.cwd }),
    }
  }

  function toReceipt(result: { sessionId: string; title: string; status: string }): DeepDuetTaskReceipt {
    const record = findTask(result.sessionId)
    return {
      sessionId: result.sessionId,
      title: result.title,
      status: result.status,
      needsDecision: record?.needsDecision ?? false,
      ...(record?.decisionQuestion !== undefined && { decisionQuestion: record.decisionQuestion }),
      ...(record?.lastSummary !== undefined && { lastSummary: record.lastSummary }),
      ...(record?.worktree !== undefined && { worktree: record.worktree }),
    }
  }

  return {
    notifyWatchers,

    remoteList() {
      return snapshotTasks()
    },

    async *remoteWatch(signal?: AbortSignal) {
      let seen = version
      yield snapshotTasks()
      while (!signal?.aborted) {
        if (version === seen) {
          await new Promise<void>((resolve) => {
            const finish = () => {
              watchers.delete(finish)
              signal?.removeEventListener('abort', finish)
              resolve()
            }
            watchers.add(finish)
            signal?.addEventListener('abort', finish, { once: true })
            if (version !== seen || signal?.aborted) finish()
          })
        }
        if (signal?.aborted) break
        seen = version
        yield snapshotTasks()
      }
    },

    async remoteSpawn(input) {
      const context = await resolveContext(input.masterId, input.cwd)
      const created = await getTasks().spawn(context, {
        title: input.title,
        prompt: input.prompt,
        ...(input.cwd !== undefined && { cwd: input.cwd }),
        ...(input.isolateWorktree !== undefined && { isolateWorktree: input.isolateWorktree }),
        ...(input.engine !== undefined && { engine: input.engine }),
        ...(input.provider !== undefined && { provider: input.provider }),
        ...(input.model !== undefined && { model: input.model }),
        ...(input.reasoningEffort !== undefined && { reasoningEffort: input.reasoningEffort }),
        ...(input.sandboxMode !== undefined && { sandboxMode: input.sandboxMode }),
        ...(input.approvalPolicy !== undefined && { approvalPolicy: input.approvalPolicy }),
      })
      const record = findTask(created.sessionId)
      return {
        sessionId: created.sessionId,
        title: created.title,
        cwd: created.cwd,
        status: created.status,
        ...(record?.worktree !== undefined && { worktree: record.worktree }),
      }
    },

    async remoteSteer(input) {
      const target = findMasterForWorker(input.sessionId, input.masterId)
      const context = await resolveContext(target.masterId, target.cwd)
      const updated = await getTasks().steer(context, {
        sessionId: input.sessionId,
        instruction: input.instruction,
      })
      return toReceipt(updated)
    },

    async remoteManage(input) {
      const target = findMasterForWorker(input.sessionId, input.masterId)
      const context = await resolveContext(target.masterId, target.cwd)
      const updated = await getTasks().manage(context, {
        sessionId: input.sessionId,
        action: input.action,
      })
      return toReceipt(updated)
    },

    async remoteInspect(input) {
      const target = findMasterForWorker(input.sessionId, input.masterId)
      const context = await resolveContext(target.masterId, target.cwd)
      const inspected = await getTasks().inspect(context, {
        sessionId: input.sessionId,
        ...(input.tailMessages !== undefined && { tailMessages: input.tailMessages }),
      })
      if (!('task' in inspected)) {
        throw new Error(`DeepDuet worker ${input.sessionId} was not found`)
      }
      return {
        task: inspected.task,
        session: {
          id: inspected.task.sessionId,
          title: inspected.task.title,
          cwd: inspected.session.cwd ?? inspected.task.cwd,
          busy: inspected.session.status === 'running',
          messages: inspected.session.messages,
        },
        gitStatus: inspected.gitStatus,
      }
    },

    async remoteEngines() {
      return {
        engines: await listAvailableEngineDescriptors(ctx),
      }
    },

    remoteGetSettings() {
      return getSettings ? getSettings() : defaultEngineSettings()
    },

    async remoteSetSettings(input) {
      if (!setSettings) return defaultEngineSettings()
      const saved = await setSettings(input)
      notifyWatchers()
      return saved
    },

    async remoteResolveApproval(input) {
      const target = findMasterForWorker(input.sessionId, input.masterId)
      const context = await resolveContext(target.masterId, target.cwd)
      const updated = await getTasks().resolveApproval(context, {
        sessionId: input.sessionId,
        requestId: input.requestId,
        approved: input.approved,
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
      })
      return toReceipt(updated)
    },
  }
}
