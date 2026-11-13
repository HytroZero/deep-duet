import type { TaskRecord } from '../remote'
import type { DeepDuetLocaleKey } from './locales'

export type WorkerDotState = 'done' | 'warning' | 'ongoing' | 'error' | 'idle'
export type WorkerTagTone = 'neutral' | 'success' | 'info' | 'warning' | 'danger'

export interface WorkerStatusView {
  readonly dot: WorkerDotState
  readonly tone: WorkerTagTone
  readonly labelKey: DeepDuetLocaleKey
}

export function getWorkerStatusView(task: Pick<TaskRecord, 'status' | 'needsDecision'>): WorkerStatusView {
  if (task.needsDecision) {
    return { dot: 'warning', tone: 'warning', labelKey: 'status.needsDecision' }
  }
  switch (task.status) {
    case 'running':
      return { dot: 'ongoing', tone: 'info', labelKey: 'status.running' }
    case 'failed':
      return { dot: 'error', tone: 'danger', labelKey: 'status.failed' }
    case 'completed':
      return { dot: 'done', tone: 'success', labelKey: 'status.completed' }
    default:
      return { dot: 'idle', tone: 'neutral', labelKey: 'status.idle' }
  }
}

export function summarizeCounts(tasks: readonly TaskRecord[]): {
  total: number
  running: number
  needsDecision: number
  failed: number
} {
  let running = 0
  let needsDecision = 0
  let failed = 0
  for (const task of tasks) {
    if (task.status === 'running') running += 1
    if (task.needsDecision) needsDecision += 1
    if (task.status === 'failed') failed += 1
  }
  return { total: tasks.length, running, needsDecision, failed }
}
