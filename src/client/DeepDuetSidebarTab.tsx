import {
  Button,
  IconRefreshOutlineRegular,
  IconUsersOutlineRegular,
  StateDot,
  Tag,
  relativeTime,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { useEffect, useState, type FormEvent } from 'react'
import type { TaskRecord } from '../remote'
import styles from './DeepDuetWorker.module.css'
import type { NS } from './locales'
import { getWorkerStatusView } from './status'
import { useDeepDuetSelector, type DeepDuetClientStore, type DeepDuetStoreState } from './store'

export interface DeepDuetSidebarInjected {
  readonly store: DeepDuetClientStore
  readonly t: TranslateNS<typeof NS>
  readonly openSession: (sessionId: string) => void
  readonly useDeepduet?: SnapshotSelectorHook<DeepDuetStoreState>
}

export type DeepDuetSidebarTabProps = PropsRuntime<'sidebar.right.pane.tab'> & DeepDuetSidebarInjected

function formatAge(at: number): string {
  const { unit, n } = relativeTime(at, Date.now())
  switch (unit) {
    case 'now':
      return 'now'
    case 'minutes':
      return `${n}m`
    case 'hours':
      return `${n}h`
    case 'days':
      return `${n}d`
    case 'months':
      return `${n}mo`
    case 'years':
      return `${n}y`
  }
}

export function DeepDuetSidebarTabTitle({ t }: DeepDuetSidebarInjected) {
  return <span>{t('tab.title')}</span>
}

export function DeepDuetSidebarTab({
  store,
  t,
  openSession,
  useDeepduet,
  sessionId: rawSessionId,
}: DeepDuetSidebarTabProps) {
  const sessionId = rawSessionId as SessionId | undefined
  const tasks = useDeepDuetSelector(store, s => s.tasks, undefined, useDeepduet)
  const bySessionId = useDeepDuetSelector(store, s => s.bySessionId, undefined, useDeepduet)
  const selectedTaskId = useDeepDuetSelector(store, s => s.selectedTaskId, undefined, useDeepduet)
  const inspections = useDeepDuetSelector(store, s => s.inspections, undefined, useDeepduet)
  const inspectLoading = useDeepDuetSelector(store, s => s.inspectLoading, undefined, useDeepduet)
  const pendingActions = useDeepDuetSelector(store, s => s.pendingActions, undefined, useDeepduet)
  const storeError = useDeepDuetSelector(store, s => s.error, undefined, useDeepduet)

  const [scope, setScope] = useState<'session' | 'all'>('session')
  const [showSpawn, setShowSpawn] = useState(false)
  const [spawnTitle, setSpawnTitle] = useState('')
  const [spawnPrompt, setSpawnPrompt] = useState('')
  const [spawnWorktree, setSpawnWorktree] = useState(false)
  const [steerText, setSteerText] = useState('')
  const [confirmArchiveId, setConfirmArchiveId] = useState<string | undefined>(undefined)

  const currentTask = sessionId ? bySessionId[sessionId] : undefined
  const activeMasterId = currentTask ? currentTask.masterId : sessionId

  const visibleTasks: readonly TaskRecord[] = scope === 'all' || !activeMasterId
    ? tasks
    : tasks.filter(task => task.masterId === activeMasterId)

  const selectedTask: TaskRecord | undefined = (() => {
    if (selectedTaskId && bySessionId[selectedTaskId]) {
      const candidate = bySessionId[selectedTaskId]
      if (scope === 'all' || !activeMasterId || candidate.masterId === activeMasterId) {
        return candidate
      }
    }
    if (currentTask) return currentTask
    return visibleTasks.find(item => item.needsDecision) ?? visibleTasks[0]
  })()

  useEffect(() => {
    if (currentTask && selectedTaskId !== currentTask.sessionId) {
      store.selectTask(currentTask.sessionId)
    }
  }, [currentTask?.sessionId])

  useEffect(() => {
    if (!selectedTask || inspectLoading[selectedTask.sessionId]) return
    // Re-inspect whenever the ledger record moves past the cached snapshot (e.g. a Worker finished in the background).
    const cached = inspections[selectedTask.sessionId]
    if (cached && cached.task.updatedAt >= selectedTask.updatedAt) return
    void store.inspect({
      masterId: selectedTask.masterId,
      sessionId: selectedTask.sessionId,
      tailMessages: 8,
    }).catch(() => {})
  }, [selectedTask?.sessionId, selectedTask?.updatedAt])

  const inspected = selectedTask ? inspections[selectedTask.sessionId] : undefined
  const isInspecting = selectedTask ? Boolean(inspectLoading[selectedTask.sessionId]) : false
  const isSpawning = activeMasterId ? Boolean(pendingActions[`spawn:${activeMasterId}`]) : false

  async function handleSpawn(event: FormEvent) {
    event.preventDefault()
    if (!activeMasterId) return
    const title = spawnTitle.trim()
    const prompt = spawnPrompt.trim()
    if (!title || !prompt) return
    try {
      await store.spawn({
        masterId: activeMasterId,
        title,
        prompt,
        ...(spawnWorktree && { isolateWorktree: true }),
      })
      setSpawnTitle('')
      setSpawnPrompt('')
      setSpawnWorktree(false)
      setShowSpawn(false)
    } catch {
      // Error surfaced via store.error
    }
  }

  async function handleSteer(event: FormEvent) {
    event.preventDefault()
    if (!selectedTask) return
    const instruction = steerText.trim()
    if (!instruction) return
    try {
      await store.steer({
        masterId: selectedTask.masterId,
        sessionId: selectedTask.sessionId,
        instruction,
      })
      setSteerText('')
      await store.inspect({
        masterId: selectedTask.masterId,
        sessionId: selectedTask.sessionId,
        tailMessages: 8,
      }).catch(() => {})
    } catch {
      // Error surfaced via store.error
    }
  }

  async function handleManage(task: TaskRecord, action: 'stop' | 'archive' | 'remove_worktree') {
    if (action === 'archive' && confirmArchiveId !== task.sessionId) {
      setConfirmArchiveId(task.sessionId)
      return
    }
    setConfirmArchiveId(undefined)
    try {
      await store.manage({
        masterId: task.masterId,
        sessionId: task.sessionId,
        action,
      })
      if (action !== 'archive') {
        await store.inspect({
          masterId: task.masterId,
          sessionId: task.sessionId,
          tailMessages: 8,
        }).catch(() => {})
      }
    } catch {
      // Error surfaced via store.error
    }
  }

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <div className={styles.panelTitle}>
          <IconUsersOutlineRegular size={15} />
          <span>{t('panel.header')}</span>
        </div>
        <div className={styles.headerBtnRow}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void store.refresh().catch(() => {})
              if (selectedTask) {
                void store.inspect({
                  masterId: selectedTask.masterId,
                  sessionId: selectedTask.sessionId,
                  tailMessages: 8,
                }).catch(() => {})
              }
            }}
          >
            <IconRefreshOutlineRegular size={13} />
            <span>{t('panel.refresh')}</span>
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!activeMasterId}
            onClick={() => setShowSpawn(prev => !prev)}
          >
            <span>{t('panel.newWorker')}</span>
          </Button>
        </div>
      </div>

      <div className={styles.filterBar}>
        <div className={styles.filterTabs}>
          <button
            type="button"
            className={`${styles.filterTab} ${scope === 'session' ? styles.filterTabActive : ''}`}
            onClick={() => setScope('session')}
          >
            {t('panel.filterAll')}
          </button>
          <button
            type="button"
            className={`${styles.filterTab} ${scope === 'all' ? styles.filterTabActive : ''}`}
            onClick={() => setScope('all')}
          >
            {t('panel.filterGlobal')}
          </button>
        </div>
        <span className={styles.sectionLabel}>
          {visibleTasks.length}
        </span>
      </div>

      <div className={styles.scrollArea}>
        {storeError && (
          <div className={styles.dockError} role="alert">
            {storeError}
          </div>
        )}

        {showSpawn && (
          <form className={styles.spawnForm} onSubmit={(e) => void handleSpawn(e)}>
            <div className={styles.panelTitle}>{t('spawn.heading')}</div>
            {!activeMasterId ? (
              <div className={styles.dockError}>{t('panel.noActiveSession')}</div>
            ) : (
              <>
                <label className={styles.fieldLabel}>
                  <span>{t('spawn.titleLabel')}</span>
                  <input
                    className={styles.textInput}
                    type="text"
                    value={spawnTitle}
                    placeholder={t('spawn.titlePlaceholder')}
                    onChange={e => setSpawnTitle(e.target.value)}
                    disabled={isSpawning}
                    required
                  />
                </label>
                <label className={styles.fieldLabel}>
                  <span>{t('spawn.promptLabel')}</span>
                  <textarea
                    className={styles.textArea}
                    value={spawnPrompt}
                    placeholder={t('spawn.promptPlaceholder')}
                    onChange={e => setSpawnPrompt(e.target.value)}
                    disabled={isSpawning}
                    required
                  />
                </label>
                <label className={styles.checkboxRow}>
                  <input
                    type="checkbox"
                    checked={spawnWorktree}
                    onChange={e => setSpawnWorktree(e.target.checked)}
                    disabled={isSpawning}
                  />
                  <span>{t('spawn.worktreeLabel')}</span>
                </label>
                <div className={styles.actionRow}>
                  <Button variant="primary" size="sm" type="submit" disabled={isSpawning || !spawnTitle.trim() || !spawnPrompt.trim()}>
                    {isSpawning ? t('spawn.submitting') : t('spawn.submit')}
                  </Button>
                  <Button variant="ghost" size="sm" type="button" onClick={() => setShowSpawn(false)} disabled={isSpawning}>
                    {t('spawn.cancel')}
                  </Button>
                </div>
              </>
            )}
          </form>
        )}

        {visibleTasks.length === 0 ? (
          <div className={styles.emptyState}>
            <strong>{t('panel.emptyTitle')}</strong>
            <span>{t('panel.emptyHint')}</span>
          </div>
        ) : (
          <div className={styles.taskList}>
            {visibleTasks.map((task) => {
              const view = getWorkerStatusView(task)
              const active = selectedTask?.sessionId === task.sessionId
              return (
                <button
                  key={task.sessionId}
                  type="button"
                  className={`${styles.taskCard} ${active ? styles.taskCardActive : ''}`}
                  onClick={() => {
                    setConfirmArchiveId(undefined)
                    store.selectTask(task.sessionId)
                    void store.inspect({
                      masterId: task.masterId,
                      sessionId: task.sessionId,
                      tailMessages: 8,
                    }).catch(() => {})
                  }}
                >
                  <div className={styles.taskCardTop}>
                    <span className={styles.taskCardTitle}>
                      <StateDot state={view.dot} />
                      <span>{task.title}</span>
                    </span>
                    <Tag tone={view.tone}>{t(view.labelKey)}</Tag>
                  </div>
                  {(task.decisionQuestion || task.lastSummary) && (
                    <div className={styles.taskCardSummary}>
                      {task.decisionQuestion ?? task.lastSummary}
                    </div>
                  )}
                  <div className={styles.taskCardMeta}>
                    <span>
                      {task.profile && task.profile.engine !== 'native'
                        ? `${task.profile.engine}${task.profile.model ? ` · ${task.profile.model}` : ''}`
                        : (task.worktree?.branch ?? task.sessionId.slice(0, 8))}
                    </span>
                    <span>{formatAge(task.updatedAt)}</span>
                  </div>
                </button>
              )
            })}
          </div>
        )}

        {selectedTask && (() => {
          const view = getWorkerStatusView(selectedTask)
          const busyManage = Boolean(pendingActions[`manage:${selectedTask.sessionId}`])
          const busySteer = Boolean(pendingActions[`steer:${selectedTask.sessionId}`])
          const busyWorker = selectedTask.status === 'running'
          return (
            <div className={styles.detailCard}>
              <div className={styles.taskCardTop}>
                <span className={styles.taskCardTitle}>
                  <StateDot state={view.dot} />
                  <span>{selectedTask.title}</span>
                </span>
                <Tag tone={view.tone}>{t(view.labelKey)}</Tag>
              </div>

              <div className={styles.actionRow}>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openSession(selectedTask.sessionId)}
                >
                  {t('inspect.openChat')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openSession(selectedTask.masterId)}
                >
                  {t('inspect.openMaster')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={isInspecting}
                  onClick={() => {
                    void store.inspect({
                      masterId: selectedTask.masterId,
                      sessionId: selectedTask.sessionId,
                      tailMessages: 8,
                    }).catch(() => {})
                  }}
                >
                  {t('inspect.inspectBtn')}
                </Button>
                {busyWorker && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyManage}
                    onClick={() => void handleManage(selectedTask, 'stop')}
                  >
                    {t('inspect.stop')}
                  </Button>
                )}
                {selectedTask.worktree && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busyManage || busyWorker}
                    onClick={() => void handleManage(selectedTask, 'remove_worktree')}
                  >
                    {t('inspect.removeWorktree')}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busyManage || busyWorker}
                  onClick={() => void handleManage(selectedTask, 'archive')}
                >
                  {confirmArchiveId === selectedTask.sessionId
                    ? t('inspect.confirmArchive')
                    : t('inspect.archive')}
                </Button>
              </div>

              {selectedTask.needsDecision && selectedTask.decisionQuestion && (
                <div>
                  <div className={styles.sectionLabel}>{t('inspect.decision')}</div>
                  <p className={styles.dockQuestion}>{selectedTask.decisionQuestion}</p>
                  {selectedTask.pendingApproval && selectedTask.pendingApproval.kind !== 'user-input' && (
                    <div className={styles.actionRow}>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={Boolean(pendingActions[`approval:${selectedTask.sessionId}`])}
                        onClick={() => void store.resolveApproval({
                          masterId: selectedTask.masterId,
                          sessionId: selectedTask.sessionId,
                          requestId: selectedTask.pendingApproval!.requestId,
                          approved: true,
                        }).catch(() => {})}
                      >
                        {t('dock.approve')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={Boolean(pendingActions[`approval:${selectedTask.sessionId}`])}
                        onClick={() => void store.resolveApproval({
                          masterId: selectedTask.masterId,
                          sessionId: selectedTask.sessionId,
                          requestId: selectedTask.pendingApproval!.requestId,
                          approved: false,
                        }).catch(() => {})}
                      >
                        {t('dock.reject')}
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {selectedTask.profile && (
                <div>
                  <div className={styles.sectionLabel}>{t('inspect.engine')}</div>
                  <div className={styles.monoText}>
                    {[selectedTask.profile.engine, selectedTask.profile.model, selectedTask.profile.reasoningEffort, selectedTask.profile.sandboxMode]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
              )}

              {selectedTask.lastSummary && (
                <div>
                  <div className={styles.sectionLabel}>{t('inspect.summary')}</div>
                  <p className={styles.dockQuestion}>{selectedTask.lastSummary}</p>
                </div>
              )}

              <div>
                <div className={styles.sectionLabel}>{t('inspect.cwd')}</div>
                <div className={styles.monoText}>{selectedTask.cwd}</div>
              </div>

              {selectedTask.worktree && (
                <div>
                  <div className={styles.sectionLabel}>{t('inspect.worktree')}</div>
                  <div className={styles.monoText}>{selectedTask.worktree.branch}</div>
                </div>
              )}

              <form onSubmit={(e) => void handleSteer(e)} className={styles.fieldLabel}>
                <span className={styles.sectionLabel}>{t('inspect.steerLabel')}</span>
                <div className={styles.dockForm}>
                  <input
                    className={styles.dockInput}
                    type="text"
                    value={steerText}
                    placeholder={busyWorker ? t('inspect.steerBusyHint') : t('inspect.steerPlaceholder')}
                    onChange={e => setSteerText(e.target.value)}
                    disabled={busyWorker || busySteer}
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    type="submit"
                    disabled={busyWorker || busySteer || !steerText.trim()}
                  >
                    {t('inspect.send')}
                  </Button>
                </div>
              </form>

              {inspected && (
                <>
                  <div>
                    <div className={styles.sectionLabel}>{t('inspect.gitStatus')}</div>
                    <pre className={styles.gitBox}>
                      {'unavailable' in inspected.gitStatus
                        ? t('inspect.gitUnavailable')
                        : (inspected.gitStatus.text.trim() || t('inspect.gitClean'))}
                    </pre>
                  </div>

                  <div>
                    <div className={styles.sectionLabel}>{t('inspect.messages')}</div>
                    {inspected.session.messages.length === 0 ? (
                      <div className={styles.taskCardMeta}>{t('inspect.noMessages')}</div>
                    ) : (
                      <div className={styles.messageList}>
                        {inspected.session.messages.map((msg, idx) => (
                          <div key={idx} className={styles.messageRow}>
                            <div className={styles.messageRole}>{msg.role}</div>
                            <div>{msg.text}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )
        })()}
      </div>
    </div>
  )
}
