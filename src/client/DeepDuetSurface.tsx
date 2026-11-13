import {
  Button,
  IconChevronRightOutlineRegular,
  IconUsersOutlineRegular,
  StateDot,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { useState, type FormEvent } from 'react'
import type { TaskRecord } from '../remote'
import styles from './DeepDuetWorker.module.css'
import type { DeepDuetLocaleKey, NS } from './locales'
import { getWorkerStatusView, summarizeCounts } from './status'
import { useDeepDuetSelector, type DeepDuetClientStore, type DeepDuetStoreState } from './store'

export interface DeepDuetSurfaceInjected {
  readonly store: DeepDuetClientStore
  readonly t: TranslateNS<typeof NS>
  readonly openSession: (sessionId: string) => void
  readonly openOrchestrator: (taskSessionId?: string) => void
  readonly useDeepduet?: SnapshotSelectorHook<DeepDuetStoreState>
}

type RowLeadingProps = PropsRuntime<'sidebar.session.row.leading'> & DeepDuetSurfaceInjected
type RowTrailingProps = PropsRuntime<'sidebar.session.row.trailing'> & DeepDuetSurfaceInjected
type RowHoverProps = PropsRuntime<'sidebar.session.row.hover'> & DeepDuetSurfaceInjected
type HeaderActionsProps = PropsRuntime<'conversation.session.header.actions'> & DeepDuetSurfaceInjected
type InputDockProps = PropsRuntime<'conversation.input.dock'> & DeepDuetSurfaceInjected
type DeepDuetToolViewProps = PropsRuntime<'tool.call.toolview', string> & DeepDuetSurfaceInjected

export function DeepDuetWorkerLeading({ store, useDeepduet, sessionId }: RowLeadingProps) {
  const task = useDeepDuetSelector(store, s => s.bySessionId[sessionId], undefined, useDeepduet)
  if (!task) return null
  const view = getWorkerStatusView(task)
  return (
    <span className={styles.leadingMark}>
      <StateDot state={view.dot} />
    </span>
  )
}

export function DeepDuetWorkerTrailing({ store, t, useDeepduet, sessionId }: RowTrailingProps) {
  const task = useDeepDuetSelector(store, s => s.bySessionId[sessionId], undefined, useDeepduet)
  if (!task) return null
  const view = getWorkerStatusView(task)
  const badgeTone = task.needsDecision
    ? styles.badgeDecision
    : task.status === 'running'
      ? styles.badgeRunning
      : task.status === 'failed'
        ? styles.badgeFailed
        : ''
  return (
    <span className={`${styles.badge} ${badgeTone}`}>
      {t(view.labelKey)}
    </span>
  )
}

export function DeepDuetWorkerHover({ store, useDeepduet, sessionId }: RowHoverProps) {
  const task = useDeepDuetSelector(store, s => s.bySessionId[sessionId], undefined, useDeepduet)
  if (!task) return null
  const note = task.decisionQuestion
    ?? task.lastSummary
    ?? (task.worktree ? task.worktree.branch : task.cwd)
  if (!note) return null
  return <div className={styles.hoverNote}>{note}</div>
}

export function DeepDuetHeaderActions({
  store,
  t,
  openSession,
  openOrchestrator,
  useDeepduet,
  sessionId,
}: HeaderActionsProps) {
  const asWorker = useDeepDuetSelector(store, s => s.bySessionId[sessionId], undefined, useDeepduet)
  const workers = useDeepDuetSelector(store, s => s.byMasterId[sessionId] ?? [], undefined, useDeepduet)

  if (asWorker) {
    const view = getWorkerStatusView(asWorker)
    return (
      <div className={styles.headerActions}>
        <button
          type="button"
          className={`${styles.pillButton} ${asWorker.needsDecision ? styles.pillAlert : ''}`}
          onClick={() => openOrchestrator(asWorker.sessionId)}
        >
          <StateDot state={view.dot} />
          <span>{t('header.workerTag')}: {t(view.labelKey)}</span>
        </button>
        <button
          type="button"
          className={styles.pillButton}
          onClick={() => openSession(asWorker.masterId)}
        >
          <span>{t('header.backToMaster')}</span>
          <IconChevronRightOutlineRegular size={12} />
        </button>
      </div>
    )
  }

  const counts = summarizeCounts(workers)
  return (
    <div className={styles.headerActions}>
      {counts.needsDecision > 0 && (
        <button
          type="button"
          className={`${styles.pillButton} ${styles.pillAlert}`}
          onClick={() => {
            const firstDecision = workers.find(w => w.needsDecision)
            openOrchestrator(firstDecision?.sessionId)
          }}
        >
          <StateDot state="warning" />
          <span>{t('header.decisionNeeded', { count: counts.needsDecision })}</span>
        </button>
      )}
      <button
        type="button"
        className={styles.pillButton}
        onClick={() => openOrchestrator()}
      >
        <IconUsersOutlineRegular size={13} />
        <span>
          {counts.total > 0
            ? `${t('header.workersCount', { count: counts.total })}${counts.running > 0 ? ` · ${t('header.runningCount', { count: counts.running })}` : ''}`
            : t('header.openOrchestrator')}
        </span>
      </button>
    </div>
  )
}

function DecisionPromptCard({
  task,
  store,
  t,
  openSession,
  useDeepduet,
}: {
  task: TaskRecord
  store: DeepDuetClientStore
  t: TranslateNS<typeof NS>
  openSession: (sessionId: string) => void
  useDeepduet?: SnapshotSelectorHook<DeepDuetStoreState>
}) {
  const [reply, setReply] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const pending = useDeepDuetSelector(store, s => Boolean(s.pendingActions[`steer:${task.sessionId}`]), undefined, useDeepduet)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    const text = reply.trim()
    if (!text) return
    setError(undefined)
    try {
      await store.steer({
        masterId: task.masterId,
        sessionId: task.sessionId,
        instruction: text,
      })
      setReply('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className={`${styles.dockCard} ${styles.dockDecisionCard}`}>
      <div className={styles.dockHeader}>
        <div className={styles.dockTitle}>
          <StateDot state="warning" />
          <span>{t('dock.decisionBadge', { title: task.title })}</span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => openSession(task.sessionId)}>
          {t('dock.openWorker')}
        </Button>
      </div>
      {task.decisionQuestion && (
        <p className={styles.dockQuestion}>{task.decisionQuestion}</p>
      )}
      <form className={styles.dockForm} onSubmit={(e) => void handleSubmit(e)}>
        <input
          className={styles.dockInput}
          type="text"
          value={reply}
          placeholder={t('dock.replyPlaceholder')}
          onChange={e => setReply(e.target.value)}
          disabled={pending}
        />
        <Button variant="primary" size="sm" type="submit" disabled={pending || !reply.trim()}>
          {pending ? t('dock.replySending') : t('dock.replySubmit')}
        </Button>
      </form>
      {error && <div className={styles.dockError}>{error}</div>}
    </div>
  )
}

export function DeepDuetInputDock({
  store,
  t,
  openSession,
  openOrchestrator,
  useDeepduet,
  sessionId,
}: InputDockProps) {
  const asWorker = useDeepDuetSelector(store, s => (sessionId ? s.bySessionId[sessionId] : undefined), undefined, useDeepduet)
  const workers = useDeepDuetSelector(store, s => (sessionId ? s.byMasterId[sessionId] ?? [] : []), undefined, useDeepduet)
  const managing = useDeepDuetSelector(store, s => (asWorker ? Boolean(s.pendingActions[`manage:${asWorker.sessionId}`]) : false), undefined, useDeepduet)

  if (!sessionId) return null

  if (asWorker) {
    const view = getWorkerStatusView(asWorker)
    return (
      <div className={styles.dockStack}>
        <div className={styles.dockCard}>
          <div className={styles.dockHeader}>
            <div className={styles.dockTitle}>
              <StateDot state={view.dot} />
              <span>{t('dock.workerBanner', { title: asWorker.title })}</span>
              <Tag tone={view.tone}>{t(view.labelKey)}</Tag>
            </div>
            <div className={styles.actionRow}>
              <Button variant="ghost" size="sm" onClick={() => openOrchestrator(asWorker.sessionId)}>
                {t('header.openOrchestrator')}
              </Button>
              {asWorker.status === 'running' && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={managing}
                  onClick={() => {
                    void store.manage({
                      masterId: asWorker.masterId,
                      sessionId: asWorker.sessionId,
                      action: 'stop',
                    }).catch(() => {})
                  }}
                >
                  {t('dock.stopTurn')}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => openSession(asWorker.masterId)}>
                {t('header.backToMaster')}
              </Button>
            </div>
          </div>
          {(asWorker.worktree || asWorker.decisionQuestion) && (
            <div className={styles.dockMeta}>
              {asWorker.worktree && (
                <span className={styles.monoText}>
                  {t('dock.workerWorktree', { branch: asWorker.worktree.branch })}
                </span>
              )}
              {asWorker.decisionQuestion && (
                <span>{asWorker.decisionQuestion}</span>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  const pendingDecisions = workers.filter(w => w.needsDecision)
  if (pendingDecisions.length === 0) return null

  return (
    <div className={styles.dockStack}>
      {pendingDecisions.map(task => (
        <DecisionPromptCard
          key={task.sessionId}
          task={task}
          store={store}
          t={t}
          openSession={openSession}
          useDeepduet={useDeepduet}
        />
      ))}
    </div>
  )
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return undefined
    }
  }
  return undefined
}

const TOOL_TITLES: Record<string, DeepDuetLocaleKey> = {
  session_spawn: 'tool.spawn.title',
  session_steer: 'tool.steer.title',
  session_inspect: 'tool.inspect.title',
  session_manage: 'tool.manage.title',
}

export function DeepDuetToolView(props: DeepDuetToolViewProps) {
  const { block, phase, store, t, openSession, useDeepduet } = props
  const toolName = block.name
  const blockRecord = block as unknown as Record<string, unknown>
  const args = asRecord(blockRecord.input) ?? asRecord(blockRecord.args) ?? {}
  const result = phase === 'result'
    ? (asRecord(blockRecord.result) ?? asRecord(blockRecord.output) ?? asRecord(blockRecord.value))
    : undefined

  const workerId = (typeof result?.sessionId === 'string' ? result.sessionId : undefined)
    ?? (typeof args.sessionId === 'string' ? args.sessionId : undefined)
  const knownTask = useDeepDuetSelector(store, s => (workerId ? s.bySessionId[workerId] : undefined), undefined, useDeepduet)
  const title = (typeof result?.title === 'string' ? result.title : undefined)
    ?? knownTask?.title
    ?? (typeof args.title === 'string' ? args.title : undefined)
    ?? workerId?.slice(0, 8)
  const statusView = knownTask ? getWorkerStatusView(knownTask) : undefined

  const titleKey = TOOL_TITLES[toolName] ?? 'tool.inspect.title'

  return (
    <div className={styles.toolCard}>
      <div className={styles.toolCardHeader}>
        <div className={styles.toolCardTitle}>
          <IconUsersOutlineRegular size={14} />
          <span>{t(titleKey)}</span>
          {title && <span>· {title}</span>}
        </div>
        <div className={styles.actionRow}>
          {statusView && (
            <Tag tone={statusView.tone}>{t(statusView.labelKey)}</Tag>
          )}
          {phase !== 'result' && (
            <Tag tone="info">{t('tool.running')}</Tag>
          )}
          {args.isolateWorktree === true && (
            <Tag tone="outline">{t('tool.isolated')}</Tag>
          )}
          {workerId && (
            <Button variant="ghost" size="sm" onClick={() => openSession(workerId)}>
              {t('tool.openWorker')}
            </Button>
          )}
        </div>
      </div>

      {toolName === 'session_spawn' && typeof args.prompt === 'string' && (
        <div className={styles.toolCardBody}>{args.prompt}</div>
      )}
      {toolName === 'session_steer' && typeof args.instruction === 'string' && (
        <div className={styles.toolCardBody}>{args.instruction}</div>
      )}
      {toolName === 'session_manage' && typeof args.action === 'string' && (
        <div className={styles.toolCardBody}>{t('tool.action', { action: args.action })}</div>
      )}
    </div>
  )
}
