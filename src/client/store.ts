import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import { createSnapshotStore, shallowEqual, type SnapshotSelectorHook, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { useRef, useSyncExternalStore } from 'react'
import { z } from 'zod'
import {
  createDeepDuetRemoteInfo,
  type DeepDuetEngineSettings,
  type DeepDuetEnginesSnapshot,
  type DeepDuetInspectParams,
  type DeepDuetInspectResult,
  type DeepDuetManageParams,
  type DeepDuetResolveApprovalParams,
  type DeepDuetSpawnParams,
  type DeepDuetSpawnReceipt,
  type DeepDuetSteerParams,
  type DeepDuetTaskReceipt,
  type DeepDuetTasksSnapshot,
  type EngineDescriptor,
  type TaskRecord,
} from '../remote'

export interface DeepDuetStoreState {
  tasks: TaskRecord[]
  bySessionId: Record<string, TaskRecord>
  byMasterId: Record<string, TaskRecord[]>
  inspections: Record<string, DeepDuetInspectResult>
  inspectLoading: Record<string, boolean>
  pendingActions: Record<string, boolean>
  selectedTaskId: string | undefined
  engines: EngineDescriptor[]
  engineSettings: DeepDuetEngineSettings
  ready: boolean
  error: string | undefined
}

interface DeepDuetRemoteNamespace {
  list(): Promise<RemoteResult<DeepDuetTasksSnapshot>>
  watch(signal?: AbortSignal): AsyncIterable<DeepDuetTasksSnapshot>
  spawn(input: DeepDuetSpawnParams): Promise<RemoteResult<DeepDuetSpawnReceipt>>
  steer(input: DeepDuetSteerParams): Promise<RemoteResult<DeepDuetTaskReceipt>>
  manage(input: DeepDuetManageParams): Promise<RemoteResult<DeepDuetTaskReceipt>>
  inspect(input: DeepDuetInspectParams): Promise<RemoteResult<DeepDuetInspectResult>>
  engines?(): Promise<RemoteResult<DeepDuetEnginesSnapshot>>
  getSettings?(): Promise<RemoteResult<DeepDuetEngineSettings>>
  setSettings?(input: DeepDuetEngineSettings): Promise<RemoteResult<DeepDuetEngineSettings>>
  resolveApproval?(input: DeepDuetResolveApprovalParams): Promise<RemoteResult<DeepDuetTaskReceipt>>
}

interface MountableRemote {
  $mount(contribution: { package: string; descriptors: readonly unknown[] }): Promise<void>
  deepduet?: DeepDuetRemoteNamespace
}

export interface DeepDuetClientStore {
  readonly snapshot: SnapshotStore<DeepDuetStoreState>
  start(): () => void
  selectTask(sessionId: string | undefined): void
  clearError(): void
  refresh(): Promise<void>
  refreshEngines(): Promise<void>
  setSettings(input: DeepDuetEngineSettings): Promise<DeepDuetEngineSettings>
  resolveApproval(input: DeepDuetResolveApprovalParams): Promise<DeepDuetTaskReceipt>
  spawn(input: DeepDuetSpawnParams): Promise<DeepDuetSpawnReceipt>
  steer(input: DeepDuetSteerParams): Promise<DeepDuetTaskReceipt>
  manage(input: DeepDuetManageParams): Promise<DeepDuetTaskReceipt>
  inspect(input: DeepDuetInspectParams): Promise<DeepDuetInspectResult>
}

const DEFAULT_SETTINGS: DeepDuetEngineSettings = {
  master: { engine: 'native', presetId: 'deepduet' },
  workerDefault: { engine: 'native', presetId: 'standard' },
}

const INITIAL_STATE: DeepDuetStoreState = {
  tasks: [],
  bySessionId: {},
  byMasterId: {},
  inspections: {},
  inspectLoading: {},
  pendingActions: {},
  selectedTaskId: undefined,
  engines: [],
  engineSettings: DEFAULT_SETTINGS,
  ready: false,
  error: undefined,
}

function indexTasks(tasks: readonly TaskRecord[]): {
  tasks: readonly TaskRecord[]
  bySessionId: Readonly<Record<string, TaskRecord>>
  byMasterId: Readonly<Record<string, readonly TaskRecord[]>>
} {
  const sorted = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt)
  const bySessionId: Record<string, TaskRecord> = {}
  const byMasterId: Record<string, TaskRecord[]> = {}
  for (const task of sorted) {
    bySessionId[task.sessionId] = task
    const list = (byMasterId[task.masterId] ??= [])
    list.push(task)
  }
  return { tasks: sorted, bySessionId, byMasterId }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const msg = (error as { message?: unknown }).message
    if (typeof msg === 'string') return msg
  }
  return String(error)
}

async function unwrapResult<T>(pending: Promise<RemoteResult<T>>): Promise<T> {
  const result = await pending
  if (!result.ok) {
    const failure: RemoteFailure = result.error
    throw failure
  }
  return result.value
}

export function createDeepDuetStore(ctx: Context): DeepDuetClientStore {
  const store = createSnapshotStore<DeepDuetStoreState>(INITIAL_STATE)
  let remotePromise: Promise<DeepDuetRemoteNamespace> | undefined
  let disposed = false

  function readRemoteNamespace(): DeepDuetRemoteNamespace | undefined {
    if (typeof ctx.get === 'function') {
      return ctx.get('remote.deepduet') as DeepDuetRemoteNamespace | undefined
    }
    return (ctx.remote as unknown as MountableRemote).deepduet
  }

  async function ensureRemote(): Promise<DeepDuetRemoteNamespace> {
    const existing = readRemoteNamespace()
    if (existing) return existing
    remotePromise ??= (async () => {
      const mountable = ctx.remote as unknown as MountableRemote
      const info = createDeepDuetRemoteInfo(z)
      await mountable.$mount({
        package: 'dsh-plugin-deepduet',
        descriptors: info.descriptors,
      })
      const api = readRemoteNamespace()
      if (!api) {
        throw new Error('Failed to mount deepduet remote namespace')
      }
      return api
    })()
    try {
      return await remotePromise
    } catch (error) {
      remotePromise = undefined
      throw error
    }
  }

  function applySnapshot(data: DeepDuetTasksSnapshot): void {
    const indexed = indexTasks(data.tasks)
    store.update((draft) => {
      draft.tasks = [...indexed.tasks]
      draft.bySessionId = { ...indexed.bySessionId }
      draft.byMasterId = Object.fromEntries(
        Object.entries(indexed.byMasterId).map(([k, v]) => [k, [...v]]),
      )
      draft.ready = true
      if (draft.selectedTaskId && !indexed.bySessionId[draft.selectedTaskId]) {
        draft.selectedTaskId = indexed.tasks[0]?.sessionId
      }
    })
  }

  async function withPending<T>(key: string, fn: () => Promise<T>): Promise<T> {
    store.update((draft) => {
      draft.pendingActions[key] = true
      draft.error = undefined
    })
    try {
      return await fn()
    } catch (error) {
      store.update((draft) => {
        draft.error = formatError(error)
      })
      throw error
    } finally {
      store.update((draft) => {
        delete draft.pendingActions[key]
      })
    }
  }

  async function refreshEngines(): Promise<void> {
    const api = await ensureRemote()
    const [enginesRes, settingsRes] = await Promise.all([
      api.engines ? unwrapResult(api.engines()).catch(() => undefined) : Promise.resolve(undefined),
      api.getSettings ? unwrapResult(api.getSettings()).catch(() => undefined) : Promise.resolve(undefined),
    ])
    if (disposed) return
    store.update((draft) => {
      if (enginesRes) draft.engines = [...enginesRes.engines]
      if (settingsRes) draft.engineSettings = settingsRes
    })
  }

  async function refresh(): Promise<void> {
    const api = await ensureRemote()
    const snapshot = await unwrapResult(api.list())
    if (!disposed) applySnapshot(snapshot)
    void refreshEngines().catch(() => {})
  }

  function start(): () => void {
    disposed = false
    let activeStream: { dispose(): Promise<void> } | undefined

    void (async () => {
      try {
        const api = await ensureRemote()
        if (disposed) return
        void refresh().catch(() => {})
        const stream = ctx.remote.$stream<DeepDuetTasksSnapshot>({
          name: 'deepduet/watch',
          open: (signal) => api.watch(signal),
          ended: (accepted) => new Error(
            accepted
              ? 'deepduet/watch stream ended unexpectedly'
              : 'deepduet/watch stream ended before opening snapshot',
          ),
        })
        activeStream = stream
        if (disposed) {
          await stream.dispose()
          return
        }
        for await (const item of stream) {
          item.accept()
          if (disposed) break
          applySnapshot(item.value)
        }
      } catch (error) {
        if (!disposed) {
          store.update((draft) => {
            draft.error = formatError(error)
          })
        }
      }
    })()

    return () => {
      disposed = true
      void activeStream?.dispose()
    }
  }

  return {
    snapshot: store,
    start,

    selectTask(sessionId) {
      store.update((draft) => {
        draft.selectedTaskId = sessionId
      })
    },

    clearError() {
      store.update((draft) => {
        draft.error = undefined
      })
    },

    refresh,
    refreshEngines,

    async setSettings(input) {
      return withPending('settings', async () => {
        const api = await ensureRemote()
        if (!api.setSettings) return input
        const saved = await unwrapResult(api.setSettings(input))
        store.update((draft) => {
          draft.engineSettings = saved
        })
        return saved
      })
    },

    async resolveApproval(input) {
      return withPending(`approval:${input.sessionId}`, async () => {
        const api = await ensureRemote()
        if (!api.resolveApproval) {
          throw new Error('resolveApproval is not supported by this host')
        }
        const receipt = await unwrapResult(api.resolveApproval(input))
        await refresh().catch(() => {})
        return receipt
      })
    },

    async spawn(input) {
      return withPending(`spawn:${input.masterId}`, async () => {
        const api = await ensureRemote()
        const receipt = await unwrapResult(api.spawn(input))
        await refresh().catch(() => {})
        store.update((draft) => {
          draft.selectedTaskId = receipt.sessionId
        })
        return receipt
      })
    },

    async steer(input) {
      return withPending(`steer:${input.sessionId}`, async () => {
        const api = await ensureRemote()
        const receipt = await unwrapResult(api.steer(input))
        await refresh().catch(() => {})
        return receipt
      })
    },

    async manage(input) {
      return withPending(`manage:${input.sessionId}`, async () => {
        const api = await ensureRemote()
        const receipt = await unwrapResult(api.manage(input))
        await refresh().catch(() => {})
        return receipt
      })
    },

    async inspect(input) {
      store.update((draft) => {
        draft.inspectLoading[input.sessionId] = true
        draft.error = undefined
      })
      try {
        const api = await ensureRemote()
        const result = await unwrapResult(api.inspect(input))
        store.update((draft) => {
          draft.inspections[input.sessionId] = result
        })
        return result
      } catch (error) {
        store.update((draft) => {
          draft.error = formatError(error)
        })
        throw error
      } finally {
        store.update((draft) => {
          delete draft.inspectLoading[input.sessionId]
        })
      }
    },
  }
}

export function useDeepDuetSelector<S>(
  store: DeepDuetClientStore,
  selector: (state: DeepDuetStoreState) => S,
  isEqual: (a: S, b: S) => boolean = shallowEqual,
  useDeepduet?: SnapshotSelectorHook<DeepDuetStoreState>,
): S {
  if (useDeepduet) {
    return useDeepduet(selector, isEqual)
  }
  const lastRef = useRef<{ hasValue: boolean; value: S }>({
    hasValue: false,
    value: undefined as S,
  })
  return useSyncExternalStore(
    store.snapshot.subscribe,
    () => {
      const next = selector(store.snapshot.getSnapshot())
      if (lastRef.current.hasValue && isEqual(lastRef.current.value, next)) {
        return lastRef.current.value
      }
      lastRef.current = { hasValue: true, value: next }
      return next
    },
    () => selector(INITIAL_STATE),
  )
}
