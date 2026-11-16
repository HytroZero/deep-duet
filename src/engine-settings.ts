import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  EngineConfigControl,
  ExternalCliApprovalPolicy,
  ExternalCliEngine,
  ExternalCliHealth,
  ExternalCliModelInfo,
  ExternalCliSandboxMode,
} from './external-cli-contract.js'

import type { AgentRoleProfile, DeepDuetEngineSettings, EngineDescriptor } from './remote.js'

export type { AgentRoleProfile, DeepDuetEngineSettings, EngineDescriptor }

export const DEFAULT_MASTER_PROFILE: AgentRoleProfile = {
  engine: 'native',
  presetId: 'deepduet',
}

export const DEFAULT_WORKER_PROFILE: AgentRoleProfile = {
  engine: 'native',
  presetId: 'standard',
}

export function defaultEngineSettings(): DeepDuetEngineSettings {
  return {
    master: { ...DEFAULT_MASTER_PROFILE },
    workerDefault: { ...DEFAULT_WORKER_PROFILE },
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const SANDBOX_LABELS: Record<ExternalCliSandboxMode, { label: string; labelKey: string }> = {
  'read-only': { label: 'Read Only (read-only)', labelKey: 'settings.sandbox.readOnly' },
  'workspace-write': { label: 'Workspace Write (workspace-write)', labelKey: 'settings.sandbox.workspaceWrite' },
  'danger-full-access': { label: 'Full Access (danger-full-access)', labelKey: 'settings.sandbox.dangerFullAccess' },
}

const APPROVAL_LABELS: Record<ExternalCliApprovalPolicy, { label: string; labelKey: string }> = {
  'on-request': { label: 'On Request (on-request)', labelKey: 'settings.approval.onRequest' },
  'auto-review': { label: 'Auto Review (auto-review)', labelKey: 'settings.approval.autoReview' },
  'untrusted': { label: 'Untrusted (untrusted)', labelKey: 'settings.approval.untrusted' },
  'never': { label: 'Never Ask (never)', labelKey: 'settings.approval.never' },
}

const NATIVE_ENGINE_CONTROLS: readonly EngineConfigControl[] = [
  {
    id: 'sandboxMode',
    label: 'Permission Mode',
    labelKey: 'settings.permission',
    defaultValue: 'workspace-write',
    options: [
      { value: 'read-only', label: 'View Only', labelKey: 'settings.nativePermission.readOnly' },
      { value: 'workspace-write', label: 'Workspace Write', labelKey: 'settings.nativePermission.workspaceWrite' },
      { value: 'danger-full-access', label: 'Full Access', labelKey: 'settings.nativePermission.dangerFullAccess' },
    ],
  },
]

function buildExternalEngineControls(engine: ExternalCliEngine): EngineConfigControl[] {
  if (engine.configControls && engine.configControls.length > 0) {
    return engine.configControls.map(ctrl => ({
      id: ctrl.id,
      label: ctrl.label,
      ...(ctrl.labelKey ? { labelKey: ctrl.labelKey } : {}),
      ...(ctrl.defaultValue !== undefined ? { defaultValue: ctrl.defaultValue } : {}),
      options: ctrl.options.map(opt => ({
        value: opt.value,
        label: opt.label,
        ...(opt.labelKey ? { labelKey: opt.labelKey } : {}),
      })),
    }))
  }
  const controls: EngineConfigControl[] = []
  if (engine.supportedSandboxes.length > 0) {
    controls.push({
      id: 'sandboxMode',
      label: 'Sandbox Policy',
      labelKey: 'settings.sandbox',
      defaultValue: engine.supportedSandboxes.includes('workspace-write') ? 'workspace-write' : engine.supportedSandboxes[0],
      options: engine.supportedSandboxes.map(mode => ({
        value: mode,
        label: SANDBOX_LABELS[mode].label,
        labelKey: SANDBOX_LABELS[mode].labelKey,
      })),
    })
  }
  if (engine.supportedApprovals.length > 0) {
    controls.push({
      id: 'approvalPolicy',
      label: 'Approval Policy',
      labelKey: 'settings.approval',
      defaultValue: engine.supportedApprovals.includes('on-request') ? 'on-request' : engine.supportedApprovals[0],
      options: engine.supportedApprovals.map(policy => ({
        value: policy,
        label: APPROVAL_LABELS[policy].label,
        labelKey: APPROVAL_LABELS[policy].labelKey,
      })),
    })
  }
  return controls
}

function parseEngineOptions(raw: unknown): Record<string, string> | undefined {
  if (!isObject(raw)) return undefined
  const entries: [string, string][] = []
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' && k.trim()) {
      entries.push([k.trim(), v])
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function parseProfile(raw: unknown, fallback: AgentRoleProfile): AgentRoleProfile {
  if (!isObject(raw)) return { ...fallback }
  const engine = typeof raw.engine === 'string' && raw.engine.trim() ? raw.engine.trim() : fallback.engine
  const presetId = typeof raw.presetId === 'string' && raw.presetId.trim()
    ? raw.presetId.trim()
    : (engine === 'native' ? fallback.presetId : engine)
  const profile: AgentRoleProfile = {
    engine,
    presetId,
  }
  if (typeof raw.provider === 'string' && raw.provider.trim()) profile.provider = raw.provider.trim()
  if (typeof raw.model === 'string' && raw.model.trim()) profile.model = raw.model.trim()
  if (typeof raw.reasoningEffort === 'string' && raw.reasoningEffort.trim()) {
    profile.reasoningEffort = raw.reasoningEffort.trim()
  }
  if (raw.sandboxMode === 'read-only' || raw.sandboxMode === 'workspace-write' || raw.sandboxMode === 'danger-full-access') {
    profile.sandboxMode = raw.sandboxMode
  }
  if (
    raw.approvalPolicy === 'untrusted'
    || raw.approvalPolicy === 'on-request'
    || raw.approvalPolicy === 'auto-review'
    || raw.approvalPolicy === 'never'
  ) {
    profile.approvalPolicy = raw.approvalPolicy
  }
  const engineOptions = parseEngineOptions(raw.engineOptions)
  if (engineOptions) profile.engineOptions = engineOptions
  return profile
}

export function normalizeEngineSettings(raw: unknown): DeepDuetEngineSettings {
  if (!isObject(raw)) return defaultEngineSettings()
  return {
    master: parseProfile(raw.master, DEFAULT_MASTER_PROFILE),
    workerDefault: parseProfile(raw.workerDefault, DEFAULT_WORKER_PROFILE),
  }
}

export function resolveWorkerProfile(
  settings: DeepDuetEngineSettings,
  overrides?: {
    engine?: string
    provider?: string
    model?: string
    reasoningEffort?: string
    sandboxMode?: ExternalCliSandboxMode
    approvalPolicy?: ExternalCliApprovalPolicy
    engineOptions?: Record<string, string>
  },
  registry?: Context['externalCliEngines'],
): AgentRoleProfile {
  const base = settings.workerDefault
  const engine = overrides?.engine?.trim() || base.engine || 'native'
  const engineChanged = engine !== base.engine

  let presetId = base.presetId
  if (engine === 'native') {
    presetId = 'standard'
  } else {
    const ext = registry?.get(engine)
    presetId = ext?.presetId ?? engine
  }

  const provider = overrides?.provider?.trim()
    || (!engineChanged ? base.provider : undefined)
    || (engine !== 'native' ? engine : undefined)
  const model = overrides?.model?.trim() || (!engineChanged ? base.model : undefined)
  const reasoningEffort = overrides?.reasoningEffort?.trim() || (!engineChanged ? base.reasoningEffort : undefined)
  const sandboxMode = overrides?.sandboxMode ?? base.sandboxMode
  const approvalPolicy = overrides?.approvalPolicy ?? (!engineChanged ? base.approvalPolicy : undefined)
  const mergedOptions = {
    ...(!engineChanged ? base.engineOptions : undefined),
    ...overrides?.engineOptions,
  }
  const hasEngineOptions = Object.keys(mergedOptions).length > 0

  return {
    engine,
    presetId,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(sandboxMode ? { sandboxMode } : {}),
    ...(approvalPolicy ? { approvalPolicy } : {}),
    ...(hasEngineOptions ? { engineOptions: mergedOptions } : {}),
  }
}

export async function openEngineSettings(directory: string) {
  const path = join(directory, 'deepduet-settings.json')
  let current: DeepDuetEngineSettings = defaultEngineSettings()

  const rawText = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
  if (rawText !== undefined) {
    try {
      const parsed = JSON.parse(rawText) as Record<string, unknown>
      current = normalizeEngineSettings(parsed.settings ?? parsed)
    } catch {
      current = defaultEngineSettings()
    }
  }

  let pending = Promise.resolve()

  return {
    get(): DeepDuetEngineSettings {
      return structuredClone(current)
    },
    async set(next: DeepDuetEngineSettings): Promise<DeepDuetEngineSettings> {
      const normalized = normalizeEngineSettings(next)
      const write = pending.then(async () => {
        await mkdir(directory, { recursive: true })
        const tmp = join(directory, `.deepduet-settings-${randomUUID()}.tmp`)
        try {
          await writeFile(tmp, `${JSON.stringify({ version: 1, settings: normalized }, null, 2)}\n`, {
            flag: 'wx',
            mode: 0o600,
          })
          await rename(tmp, path)
        } catch (error) {
          await rm(temporaryPath(tmp), { force: true }).catch(() => {})
          throw error
        }
        current = normalized
      })
      pending = write.catch(() => {})
      await write
      return structuredClone(current)
    },
  }
}

function temporaryPath(path: string) {
  return path
}

export async function listAvailableEngineDescriptors(ctx: Context): Promise<EngineDescriptor[]> {
  const nativeModels: Array<ExternalCliModelInfo & { provider?: string }> = []
  const llm = ctx.root.get('llm')
  if (llm) {
    for (const provider of llm.listProviders()) {
      try {
        const models = await llm.listModels(provider.id)
        for (const model of models) {
          const resolved = await llm.resolveModelInfo(provider.id, model.id).catch(() => undefined)
          nativeModels.push({
            id: model.id,
            name: `${provider.name} · ${model.name}`,
            provider: provider.id,
            ...(model.description ? { description: model.description } : {}),
            ...(resolved?.reasoning ? {
              reasoningEfforts: resolved.reasoning.efforts.map(e => ({
                id: e.id,
                name: e.name,
                ...(e.description ? { description: e.description } : {}),
              })),
              ...(resolved.reasoning.defaultEffort ? { defaultReasoningEffort: resolved.reasoning.defaultEffort } : {}),
            } : {}),
          })
        }
      } catch {
        // Ignore individual provider discovery failure so healthy providers remain selectable.
      }
    }
  }

  const descriptors: EngineDescriptor[] = [
    {
      id: 'native',
      presetId: 'standard',
      label: 'DSH Native',
      kind: 'native',
      supportedSandboxes: ['read-only', 'workspace-write', 'danger-full-access'],
      supportedApprovals: [],
      controls: [...NATIVE_ENGINE_CONTROLS],
      health: { available: true, authenticated: true },
      models: nativeModels,
    },
  ]

  const registry = ctx.root.get('externalCliEngines')
  if (registry) {
    for (const engine of registry.list()) {
      const health = await engine.checkHealth().catch((err): ExternalCliHealth => ({
        available: false,
        authenticated: false,
        errorCode: 'CLI_UNHEALTHY',
        message: err instanceof Error ? err.message : String(err),
      }))
      const models = health.available ? await engine.listModels().catch(() => []) : []
      descriptors.push({
        id: engine.id,
        presetId: engine.presetId,
        label: engine.label,
        kind: 'external',
        supportedSandboxes: engine.supportedSandboxes,
        supportedApprovals: engine.supportedApprovals,
        controls: buildExternalEngineControls(engine),
        health,
        models,
      })
    }
  }

  return descriptors
}
