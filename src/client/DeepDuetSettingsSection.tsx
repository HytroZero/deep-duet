import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useState } from 'react'
import type { AgentRoleProfile, DeepDuetEngineSettings, EngineDescriptor } from '../remote'
import styles from './DeepDuetWorker.module.css'
import type { NS } from './locales'
import { SelectMenu } from './SelectMenu'
import { useDeepDuetSelector, type DeepDuetClientStore, type DeepDuetStoreState } from './store'

export interface DeepDuetSettingsInjected {
  readonly store: DeepDuetClientStore
  readonly t: TranslateNS<typeof NS>
  readonly useDeepduet?: SnapshotSelectorHook<DeepDuetStoreState>
}

type DeepDuetSettingsProps = PropsRuntime<'settings.section'> & DeepDuetSettingsInjected

function modelOptionKey(model: { id: string; provider?: string }): string {
  return `${model.provider ?? ''}::${model.id}`
}

function RoleProfileCard({
  title,
  role,
  profile,
  engines,
  t,
  onChange,
}: {
  title: string
  role: 'master' | 'worker'
  profile: AgentRoleProfile
  engines: readonly EngineDescriptor[]
  t: TranslateNS<typeof NS>
  onChange: (next: AgentRoleProfile) => void
}) {
  const selectedEngine = engines.find(e => e.id === profile.engine) ?? engines[0]
  const models = selectedEngine?.models ?? []
  const selectedModel = models.find(m => m.id === profile.model && (!profile.provider || !m.provider || m.provider === profile.provider))
    ?? models.find(m => m.id === profile.model)
  const efforts = selectedModel?.reasoningEfforts ?? []
  const sandboxes = selectedEngine?.supportedSandboxes ?? ['read-only', 'workspace-write', 'danger-full-access']
  const approvals = selectedEngine?.supportedApprovals ?? ['on-request', 'never']

  const isUnhealthyExternal = selectedEngine?.kind === 'external'
    && (!selectedEngine.health.available || !selectedEngine.health.authenticated)

  const engineOptions = engines.length === 0
    ? [{ value: 'native', label: 'DSH Native' }]
    : engines.map(engine => ({ value: engine.id, label: engine.label }))

  const selectedModelValue = selectedModel
    ? modelOptionKey(selectedModel)
    : (profile.model ? `${profile.provider ?? ''}::${profile.model}` : '')

  const modelOptions = [
    { value: '', label: t('settings.modelDefault') },
    ...models.map(m => ({ value: modelOptionKey(m), label: m.name })),
    ...(profile.model && !selectedModel
      ? [{ value: selectedModelValue, label: profile.model }]
      : []),
  ]

  const effortOptions = [
    { value: '', label: t('settings.modelDefault') },
    ...efforts.map(eff => ({ value: eff.id, label: eff.name })),
    ...(profile.reasoningEffort && !efforts.some(eff => eff.id === profile.reasoningEffort)
      ? [{ value: profile.reasoningEffort, label: profile.reasoningEffort }]
      : []),
  ]

  const sandboxOptions = sandboxes.map(sb => ({
    value: sb,
    label: sb === 'read-only'
      ? t('settings.sandbox.readOnly')
      : sb === 'danger-full-access'
        ? t('settings.sandbox.dangerFullAccess')
        : t('settings.sandbox.workspaceWrite'),
  }))

  const approvalOptions = approvals.map(ap => ({
    value: ap,
    label: ap === 'untrusted'
      ? t('settings.approval.untrusted')
      : ap === 'never'
        ? t('settings.approval.never')
        : t('settings.approval.onRequest'),
  }))

  return (
    <div className={styles.settingsCard}>
      <div className={styles.taskCardTop}>
        <span className={styles.panelTitle}>{title}</span>
        <Tag tone={isUnhealthyExternal ? 'warning' : 'info'}>
          {selectedEngine?.label ?? profile.engine}
        </Tag>
      </div>

      {isUnhealthyExternal && selectedEngine && (
        <div className={styles.settingsWarn}>
          {t('settings.unhealthyCli', {
            detail: selectedEngine.health.message ?? selectedEngine.health.errorCode ?? 'CLI unavailable',
          })}
        </div>
      )}

      <div className={styles.settingsGrid}>
        <div className={styles.fieldLabel}>
          <span>{t('settings.engine')}</span>
          <SelectMenu
            value={profile.engine}
            options={engineOptions}
            onChange={(nextEngineId) => {
              const nextEngine = engines.find(item => item.id === nextEngineId)
              const nextPresetId = nextEngineId === 'native'
                ? (role === 'master' ? 'deepduet' : 'standard')
                : (nextEngine?.presetId ?? nextEngineId)
              const firstModel = nextEngine?.models[0]
              onChange({
                engine: nextEngineId,
                presetId: nextPresetId,
                ...(nextEngineId === 'native'
                  ? {}
                  : {
                      provider: nextEngineId,
                      ...(firstModel ? { model: firstModel.id } : {}),
                      ...(firstModel?.defaultReasoningEffort ? { reasoningEffort: firstModel.defaultReasoningEffort } : {}),
                    }),
                sandboxMode: profile.sandboxMode ?? 'workspace-write',
                approvalPolicy: nextEngine?.supportedApprovals.includes(profile.approvalPolicy ?? 'on-request')
                  ? (profile.approvalPolicy ?? 'on-request')
                  : (nextEngine?.supportedApprovals[0] ?? 'on-request'),
              })
            }}
          />
        </div>

        <div className={styles.fieldLabel}>
          <span>{t('settings.model')}</span>
          <SelectMenu
            value={selectedModelValue}
            options={modelOptions}
            onChange={(val) => {
              const { model: _m, provider: _p, reasoningEffort: _r, ...rest } = profile
              if (!val) {
                onChange({
                  ...rest,
                  ...(profile.engine !== 'native' ? { provider: profile.engine } : {}),
                })
                return
              }
              const [prov, ...restModel] = val.split('::')
              const modelId = restModel.join('::')
              const matched = models.find(m => m.id === modelId && (!prov || m.provider === prov))
              const nextProvider = prov || (profile.engine === 'native' ? undefined : profile.engine)
              const nextEffort = matched?.defaultReasoningEffort
                ?? (profile.reasoningEffort && matched?.reasoningEfforts?.some(e => e.id === profile.reasoningEffort)
                  ? profile.reasoningEffort
                  : undefined)
              onChange({
                ...rest,
                ...(nextProvider ? { provider: nextProvider } : {}),
                model: modelId,
                ...(nextEffort ? { reasoningEffort: nextEffort } : {}),
              })
            }}
          />
        </div>

        <div className={styles.fieldLabel}>
          <span>{t('settings.effort')}</span>
          <SelectMenu
            value={profile.reasoningEffort ?? ''}
            options={effortOptions}
            disabled={efforts.length === 0}
            onChange={(val) => {
              if (!val) {
                const { reasoningEffort: _r, ...rest } = profile
                onChange(rest)
                return
              }
              onChange({ ...profile, reasoningEffort: val })
            }}
          />
        </div>

        <div className={styles.fieldLabel}>
          <span>{t('settings.sandbox')}</span>
          <SelectMenu
            value={profile.sandboxMode ?? 'workspace-write'}
            options={sandboxOptions}
            onChange={val => onChange({
              ...profile,
              sandboxMode: val as AgentRoleProfile['sandboxMode'],
            })}
          />
        </div>

        <div className={styles.fieldLabel}>
          <span>{t('settings.approval')}</span>
          <SelectMenu
            value={profile.approvalPolicy ?? 'on-request'}
            options={approvalOptions}
            onChange={val => onChange({
              ...profile,
              approvalPolicy: val as AgentRoleProfile['approvalPolicy'],
            })}
          />
        </div>
      </div>
    </div>
  )
}

export function DeepDuetSettingsSection({ store, t, useDeepduet }: DeepDuetSettingsProps) {
  const engines = useDeepDuetSelector(store, s => s.engines, undefined, useDeepduet)
  const savedSettings = useDeepDuetSelector(store, s => s.engineSettings, undefined, useDeepduet)
  const saving = useDeepDuetSelector(store, s => Boolean(s.pendingActions.settings), undefined, useDeepduet)
  const error = useDeepDuetSelector(store, s => s.error, undefined, useDeepduet)

  const [draft, setDraft] = useState<DeepDuetEngineSettings>(savedSettings)
  const [savedNotice, setSavedNotice] = useState(false)

  useEffect(() => {
    void store.refreshEngines().catch(() => {})
  }, [])

  useEffect(() => {
    setDraft(savedSettings)
  }, [savedSettings])

  async function handleSave() {
    setSavedNotice(false)
    await store.setSettings(draft).then(() => {
      setSavedNotice(true)
    }).catch(() => {})
  }

  return (
    <div className={styles.settingsWrap}>
      <div className={styles.settingsHeader}>
        <div>
          <h3 className={styles.settingsTitle}>{t('settings.title')}</h3>
          <p className={styles.settingsSubtitle}>{t('settings.subtitle')}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void store.refreshEngines().catch(() => {})}
        >
          {t('settings.refreshEngines')}
        </Button>
      </div>

      <RoleProfileCard
        title={t('settings.masterTitle')}
        role="master"
        profile={draft.master}
        engines={engines}
        t={t}
        onChange={master => setDraft(prev => ({ ...prev, master }))}
      />

      <RoleProfileCard
        title={t('settings.workerTitle')}
        role="worker"
        profile={draft.workerDefault}
        engines={engines}
        t={t}
        onChange={workerDefault => setDraft(prev => ({ ...prev, workerDefault }))}
      />

      {error && <div className={styles.dockError}>{error}</div>}

      <div className={styles.settingsFoot}>
        {savedNotice && <Tag tone="success">{t('settings.saved')}</Tag>}
        <Button variant="primary" size="sm" disabled={saving} onClick={() => void handleSave()}>
          {saving ? t('settings.saving') : t('settings.save')}
        </Button>
      </div>
    </div>
  )
}
