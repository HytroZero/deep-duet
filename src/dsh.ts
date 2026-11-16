import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, type ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-title'
import { workspaceWritableRoots } from '@deepseek-ai/dsh-sandbox'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-workspace'
import { execFile } from 'node:child_process'
import { isAbsolute, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import type { ExternalCliApprovalRequest, ExternalCliEngine } from './external-cli-contract.js'
import type { AgentRoleProfile } from './remote.js'
import { summarize } from './text.js'

const exec = promisify(execFile)
// Large checkouts can print megabytes of `git status`; callers truncate what they show.
const GIT_MAX_BUFFER = 16 * 1024 * 1024
const gitLocalEnvironment = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
  'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE',
]

declare module '@deepseek-ai/dsh-llm/types' {
  interface MessageSourceMap {
    deepduet: { kind: 'deepduet'; form: 'notice'; summary: string } | { kind: 'deepduet'; form: 'assignment' }
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    deepduet: { kind: 'deepduet'; form: 'notice'; summary: string } | { kind: 'deepduet'; form: 'assignment' }
  }
}

type SessionInspection = {
  status: 'idle' | 'running' | 'unloaded' | 'unavailable'
  cwd?: string
  messages: { role: 'user' | 'assistant'; text: string }[]
}

export type DshHost = {
  createWorker(task: { sessionId: string; masterId: string; cwd: string; title: string; profile?: AgentRoleProfile }): Promise<void>
  runTurn(
    sessionId: string,
    input: string,
    signal: AbortSignal,
    options?: {
      profile?: AgentRoleProfile
      onApprovalRequest?: (req: ExternalCliApprovalRequest) => void
    },
  ): Promise<string>
  isBusy(sessionId: string): boolean
  releaseWorker(sessionId: string): Promise<void>
  withIdleWorker<T>(sessionId: string, operation: (checkIdle: () => void) => Promise<T>): Promise<T>
  readSession(sessionId: string, limit: number): Promise<SessionInspection>
  runGit(masterId: string, cwd: string, args: string[], beforeExec?: () => void): Promise<string>
  deliverDigest(masterId: string, takeMessage: () => string | undefined, signal: AbortSignal): Promise<void>
  close(): Promise<void>
}

function textOf(message: Message) {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

function recentMessages(messages: Iterable<Message>, limit: number): SessionInspection['messages'] {
  const result: SessionInspection['messages'] = []
  if (limit === 0) return result
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = textOf(message)
    if (!text) continue
    result.push({ role: message.role, text: summarize(text) })
    if (result.length > limit) result.shift()
  }
  return result
}

function* storedMessages(events: readonly SessionEvent[]) {
  for (const event of events) {
    if (event.type === 'user/message') yield event.data
    if (event.type === 'assistant/message') yield event.data.message
  }
}

async function waitForIdle(agent: Agent, signal: AbortSignal) {
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const onAbort = () => aborted.reject(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    await Promise.race([agent.whenIdle(), aborted.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export function createDshHost(ctx: Context): DshHost {
  // Native chat can keep using these sessions after the plugin is unloaded.
  const agents = ctx.extend({ fiber: ctx.root.fiber }).agents
  const handles = new Map<SessionId, AgentHandle>()
  const live = (id: string) => ctx.agents.get(brandString<SessionId>(id))
  const hasPending = (agent: Agent) => agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0

  function codedError(code: string, message: string): Error & { code: string } {
    return Object.assign(new Error(message), { code })
  }

  function resolveExternalEngine(engineId: string): ExternalCliEngine {
    const engine = ctx.root.get('externalCliEngines')?.get(engineId)
    if (!engine) {
      throw codedError('ENGINE_UNAVAILABLE', `External CLI engine "${engineId}" is not installed or unavailable`)
    }
    return engine
  }

  async function requireReadyExternalEngine(engineId: string): Promise<ExternalCliEngine> {
    const engine = resolveExternalEngine(engineId)
    const health = await engine.checkHealth()
    if (!health.available) {
      throw codedError(health.errorCode ?? 'ENGINE_UNAVAILABLE', health.message ?? `CLI for "${engineId}" was not found`)
    }
    if (!health.authenticated) {
      throw codedError(health.errorCode ?? 'CLI_NOT_AUTHENTICATED', health.message ?? `CLI for "${engineId}" is not authenticated`)
    }
    return engine
  }

  async function resume(id: SessionId, signal: AbortSignal): Promise<Agent> {
    const existing = live(id)
    if (existing) return existing
    const stored = await ctx.sessionPersistence.stat(id, { signal })
    const preset = stored?.header.agentPreset
    try {
      const handle = await agents.resume({
        resumeSessionId: id,
        signal,
        setup: async agentCtx => {
          if (preset !== undefined) await agentCtx.get('agentPresets')?.mount?.(agentCtx, preset)
        },
      })
      handles.set(id, handle)
      return handle.agent
    } catch (error) {
      // Native chat may have loaded the same session while storage was opening.
      const concurrent = live(id)
      if (concurrent && !signal.aborted) return concurrent
      throw error
    }
  }

  return {
    async createWorker({ sessionId, masterId, cwd, title, profile }) {
      // A Master opened from storage (e.g. from the GUI after a restart) is loaded on demand.
      const parent = live(masterId)
        ?? await resume(brandString<SessionId>(masterId), AbortSignal.timeout(15_000)).catch(() => undefined)
      if (!parent) throw new Error(`Master ${masterId} is unavailable`)
      if (parent.session.header.origin === 'subagent') throw new Error('A subagent session cannot act as a DeepDuet Master')
      const id = brandString<SessionId>(sessionId)
      const parentPresets = parent.ctx.get('agentPresets') as (typeof parent.ctx extends never ? never : {
        composedPreset(ctx: unknown): string | undefined
        composeFrom(ctx: unknown, parentCtx: unknown): unknown
        resolve?(id?: string): Promise<{ id: string; broken?: string }>
        mount?(ctx: unknown, id?: string): Promise<unknown>
      }) | undefined
      const parentPreset = parentPresets?.composedPreset(parent.ctx)

      const isExternal = Boolean(profile && profile.engine !== 'native')
      const externalEngine = isExternal ? await requireReadyExternalEngine(profile!.engine) : undefined

      let workerPreset = parentPreset
      let mountPresetId: string | undefined
      if (externalEngine) {
        workerPreset = externalEngine.presetId
        if (parentPresets && typeof parentPresets.resolve === 'function' && typeof parentPresets.mount === 'function') {
          const resolved = await parentPresets.resolve(externalEngine.presetId).catch(() => undefined)
          if (resolved && resolved.broken === undefined) {
            mountPresetId = resolved.id
          }
        }
      } else if (parentPresets && parentPreset === 'deepduet' && typeof parentPresets.resolve === 'function' && typeof parentPresets.mount === 'function') {
        const standard = await parentPresets.resolve('standard').catch(() => undefined)
        if (standard && standard.broken === undefined) {
          workerPreset = standard.id
          mountPresetId = standard.id
        }
      }

      const parentSelection = parent.model.current()
      const parentOptions = parent.options
      const extRegistry = ctx.root.get('externalCliEngines')
      const parentIsExternal = Boolean(parentSelection && extRegistry?.get(parentSelection.provider))

      async function resolveNativeFallbackSelection() {
        if (parentSelection && !parentIsExternal) return parentSelection
        const optProvider = parentOptions.provider
        const optModel = parentOptions.model
        if (optProvider && optModel && !extRegistry?.get(optProvider)) {
          return {
            provider: optProvider,
            model: optModel,
            ...(parentOptions.reasoningEffort ? { reasoningEffort: parentOptions.reasoningEffort } : {}),
          }
        }
        const defaultModelSvc = ctx.root.get('agentDefaultModel') as {
          currentSelection?(): { provider: string; model: string; reasoningEffort?: ReasoningEffortId } | undefined
        } | undefined
        const defSel = defaultModelSvc?.currentSelection?.()
        if (defSel && !extRegistry?.get(defSel.provider)) return defSel
        const llm = ctx.root.get('llm')
        if (llm) {
          for (const prov of llm.listProviders()) {
            if (extRegistry?.get(prov.id)) continue
            const models = await llm.listModels(prov.id).catch(() => [])
            if (models[0]) return { provider: prov.id, model: models[0].id }
          }
        }
        return undefined
      }

      const nativeFallback = externalEngine ? undefined : await resolveNativeFallbackSelection()
      const selection = externalEngine
        ? {
            provider: externalEngine.id,
            model: profile?.model ?? 'codex-default',
            ...(profile?.reasoningEffort ? { reasoningEffort: profile.reasoningEffort as ReasoningEffortId } : {}),
          }
        : (profile?.provider && profile?.model)
          ? {
              provider: profile.provider,
              model: profile.model,
              ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort as ReasoningEffortId } : {}),
            }
          : (profile?.model && nativeFallback)
            ? {
                provider: nativeFallback.provider,
                model: profile.model,
                ...(profile.reasoningEffort
                  ? { reasoningEffort: profile.reasoningEffort as ReasoningEffortId }
                  : nativeFallback.reasoningEffort
                    ? { reasoningEffort: nativeFallback.reasoningEffort }
                    : {}),
              }
            : nativeFallback

      const policy = parent.ctx.get('sandboxPolicy')?.resolve({ session: parent.session })
      if (policy?.mode === 'workspace-write' && !workspaceWritableRoots(policy).some(root => {
        const path = relative(root, cwd)
        return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
      })) {
        throw new Error('Worker directory lies outside the Master session’s writable workspace')
      }
      const agentOptions: AgentOptions = { ...selection }
      const handle = await agents.create({
        sessionId: id,
        // Workers run as ordinary coding sessions so cold resume and GUI takeover work seamlessly.
        meta: { cwd, parentSession: parent.id, agentPreset: workerPreset },
        agentOptions,
        async setup(agentCtx, { session }) {
          const presets = agentCtx.get('agentPresets') as typeof parentPresets
          if (mountPresetId && presets?.mount) {
            await presets.mount(agentCtx, mountPresetId)
          } else if (!externalEngine) {
            presets?.composeFrom(agentCtx, parent.ctx)
          }
          const effectiveSandbox = profile?.sandboxMode ?? policy?.mode
          if (effectiveSandbox) setSandboxMode(session, effectiveSandbox)
          const approval = parent.ctx.get('approval')
          if (approval) {
            const effectiveApproval = profile?.approvalPolicy === 'never'
              ? 'never'
              : (profile?.approvalPolicy ? 'ask' : (approval.overrideOf(parent.session) ?? approval.config.policy ?? 'ask'))
            setApprovalPolicy(session, effectiveApproval)
          }
        },
      })
      handles.set(id, handle)
      try {
        const session = handle.agent.session
        if (selection) handle.agent.model.select(selection)
        handle.agent.ctx.get('sessionTitle')?.rename(session, title)
        if (externalEngine) {
          await externalEngine.configureSession(sessionId, {
            ...(profile?.model ? { model: profile.model } : {}),
            ...(profile?.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
            ...(profile?.sandboxMode ? { sandboxMode: profile.sandboxMode } : policy ? { sandboxMode: policy.mode } : {}),
            ...(profile?.approvalPolicy ? { approvalPolicy: profile.approvalPolicy } : {}),
            ...(profile?.engineOptions ? { engineOptions: profile.engineOptions } : {}),
          })
        }
        await ctx.sessions.flush(session)
        // Attach shared-cwd workers directly to the project Workspace so the sidebar updates immediately.
        const workspace = await ctx.get('workspaceRegistry')?.resolveByPath(cwd).catch(() => undefined)
        if (workspace) await workspace.attachSession(id).catch(() => {})
      } catch (error) {
        await handle.dispose()
        handles.delete(id)
        throw error
      }
    },

    async runTurn(sessionId, input, signal, options) {
      signal.throwIfAborted()
      const agent = await resume(brandString<SessionId>(sessionId), signal)
      signal.throwIfAborted()
      if (agent.status !== 'idle' || hasPending(agent)) {
        throw new Error(`Session ${sessionId} already has active or queued work`)
      }

      const profile = options?.profile
      if (profile && profile.engine !== 'native') {
        const engine = await requireReadyExternalEngine(profile.engine)
        const result = await engine.runSessionTurn({
          sessionId,
          input,
          config: {
            ...(profile.model ? { model: profile.model } : {}),
            ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
            ...(profile.sandboxMode ? { sandboxMode: profile.sandboxMode } : {}),
            ...(profile.approvalPolicy ? { approvalPolicy: profile.approvalPolicy } : {}),
            ...(profile.engineOptions ? { engineOptions: profile.engineOptions } : {}),
          },
          signal,
          ...(options?.onApprovalRequest ? { onApprovalRequest: options.onApprovalRequest } : {}),
        })
        return result.replyText
      }

      const message = createUserMessage({
        content: [{ type: 'text', text: input }],
        source: { kind: 'deepduet', form: 'assignment' },
      })
      const result = Promise.withResolvers<string>()
      let firstTurn: number | undefined
      let admitted = false
      let reply = ''
      const unsubscribe = ctx.on('session/event', (session, event) => {
        if (session !== agent.session) return
        if (event.type === 'turn/start') firstTurn ??= event.data.turn
        if (event.type === 'user/message' && event.data.id === message.id) admitted = true
        if (event.type === 'assistant/message' && admitted && event.data.turn === firstTurn) {
          const text = textOf(event.data.message)
          if (text) reply = text
        }
        if (event.type !== 'turn/end' || event.data.turn !== firstTurn) return
        const reason = event.data.reason
        if (admitted && (reason.kind === 'completed' || reason.kind === 'max-tokens')) result.resolve(reply)
        else result.reject(new Error(reason.kind === 'error' ? reason.error.message : `Worker turn ended: ${reason.kind}`))
      })
      const aborted = Promise.withResolvers<never>()
      const onAbort = () => aborted.reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      let settlement: Promise<string> | undefined
      try {
        agent.followup(message)
        const idleWithoutResult = agent.whenIdle().then(() => {
          throw new Error('Worker became idle without finishing the submitted turn')
        })
        settlement = Promise.race([result.promise, idleWithoutResult])
        return await Promise.race([settlement, aborted.promise])
      } catch (error) {
        if (signal.aborted) {
          // Preserve pending native input and only cancel while this turn owns the driver.
          const boundary = ctx.agents.turnBoundaryOf(agent.session)
          const pending = agent.inbox.remove(message.id)
          if (!pending && firstTurn !== undefined && firstTurn === boundary.lastTurn && boundary.openTurnStartSeq !== null) {
            agent.cancel({ kind: 'parent' }, { keepInbox: true })
            // Requeue the last follow-up in place to wake DSH after this cancellation.
            const followup = agent.inbox.nextTurn.at(-1)
              ?? agent.inbox.nextStep.findLast(input => input.source.kind === 'user')
            if (followup && agent.inbox.remove(followup.id)) agent.followup(followup)
            await settlement?.catch(() => {})
          }
        }
        throw error
      } finally {
        unsubscribe()
        signal.removeEventListener('abort', onAbort)
      }
    },

    isBusy(id) {
      const agent = live(id)
      if (agent !== undefined && (agent.status === 'running' || hasPending(agent))) return true
      const registry = ctx.root.get('externalCliEngines')
      if (registry) {
        for (const engine of registry.list()) {
          if (engine.isSessionBusy(id)) return true
        }
      }
      return false
    },

    async releaseWorker(id) {
      const key = brandString<SessionId>(id)
      const handle = handles.get(key)
      if (!handle) return
      if (handle.agent.status === 'running' || hasPending(handle.agent)) throw new Error(`Session ${id} is busy`)
      await handle.dispose()
      handles.delete(key)
    },

    async withIdleWorker(id, operation) {
      const agent = await resume(brandString<SessionId>(id), AbortSignal.timeout(15_000))
      return agent.runMaintenance(async signal => {
        function checkIdle() {
          signal.throwIfAborted()
          if (hasPending(agent)) throw new Error(`Session ${id} has queued work`)
        }
        checkIdle()
        return operation(checkIdle)
      })
    },

    async readSession(id, limit) {
      const agent = live(id)
      if (agent) {
        return {
          status: agent.status, cwd: ctx.workingDirectory.get(agent.session),
          messages: recentMessages(limit ? agent.session.deriveMessages() : [], limit),
        }
      }
      const sessionId = brandString<SessionId>(id)
      if (!await ctx.sessionPersistence.stat(sessionId)) return { status: 'unavailable', messages: [] }
      await using stored = await ctx.sessionPersistence.open(sessionId, 'read')
      const { events } = await stored.read()
      const lastCwd = events.findLast(event => event.type === 'working-directory/change')
      const cwd = lastCwd?.data.cwd ?? stored.header.cwd
      return {
        status: 'unloaded', ...(cwd && { cwd }), messages: recentMessages(storedMessages(events), limit),
      }
    },

    async runGit(masterId, cwd, args, beforeExec) {
      const signal = AbortSignal.timeout(15_000)
      const master = live(masterId) ?? await resume(brandString<SessionId>(masterId), signal).catch(() => undefined)
      const policy = master?.ctx.get('sandboxPolicy')?.resolve({ session: master.session })
      if (!policy) throw new Error('DeepDuet requires the native sandbox policy for Git operations')
      const command = ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args]
      let argv = command
      if (policy.mode !== 'danger-full-access') {
        const sandbox = master?.ctx.get('sandbox')
        if (!sandbox) throw new Error('Native sandbox is unavailable')
        argv = (await sandbox.confine(command, { ...policy, mode: policy.mode }, signal)).argv
      }
      const [program, ...parameters] = argv
      if (!program) throw new Error('No Git command was resolved')
      const env: NodeJS.ProcessEnv = {
        ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_NO_LAZY_FETCH: '1',
      }
      for (const name of gitLocalEnvironment) delete env[name]
      beforeExec?.()
      const { stdout } = await exec(program, parameters, {
        cwd, signal, maxBuffer: GIT_MAX_BUFFER,
        env,
      })
      return stdout
    },

    async deliverDigest(id, takeMessage, signal) {
      const master = await resume(brandString<SessionId>(id), signal)
      do {
        await waitForIdle(master, signal)
        signal.throwIfAborted()
      } while (master.status !== 'idle')

      // No await between the last idle check and enqueue. followup uses the next-turn inbox.
      const text = takeMessage()
      if (text === undefined) return
      master.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'deepduet', form: 'notice', summary: 'Background worker updates' },
      }))
    },

    async close() {
      const results = await Promise.allSettled([...handles.values()].map(async handle => {
        if (handle.agent.status === 'idle' && !hasPending(handle.agent)) await handle.dispose()
      }))
      handles.clear()
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (errors.length) throw new AggregateError(errors, 'Could not release DeepDuet sessions')
    },
  }
}
