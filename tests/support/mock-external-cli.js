import { randomUUID } from 'node:crypto'

export function createExternalCliEngineRegistry() {
  const engines = new Map()
  const listeners = new Set()

  const notify = () => {
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // Ignore subscriber errors during registry broadcast.
      }
    }
  }

  return {
    register(engine) {
      engines.set(engine.id, engine)
      notify()
      return () => {
        if (engines.get(engine.id) === engine) {
          engines.delete(engine.id)
          notify()
        }
      }
    },
    get(idOrPreset) {
      const direct = engines.get(idOrPreset)
      if (direct) return direct
      for (const engine of engines.values()) {
        if (engine.presetId === idOrPreset) return engine
      }
      return undefined
    },
    list() {
      return [...engines.values()]
    },
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

function textOf(message) {
  return message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
}

export const name = 'mock-external-cli'
export const inject = ['agents']

export function apply(ctx, options = {}) {
  const id = options.id ?? 'mock-cli'
  const presetId = options.presetId ?? id
  const label = options.label ?? 'MockCLI'
  const models = options.models ?? [
    {
      id: 'ext-pro',
      name: 'Ext Pro',
      description: 'Mock external pro model',
      reasoningEfforts: [
        { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High' },
      ],
      defaultReasoningEffort: 'medium',
    },
    {
      id: 'ext-mini',
      name: 'Ext Mini',
      description: 'Mock external mini model',
    },
  ]
  const health = options.health ?? {
    available: true,
    authenticated: true,
    version: '1.0.0',
    accountLabel: 'mock@example.com',
  }

  const sessionConfigs = new Map()
  const sessionThreads = new Map()
  const busySessions = new Set()
  const pendingApprovals = new Map()
  const activeTurns = new Map()

  const engine = {
    id,
    presetId,
    label,
    supportedSandboxes: options.supportedSandboxes ?? ['read-only', 'workspace-write', 'danger-full-access'],
    supportedApprovals: options.supportedApprovals ?? ['untrusted', 'on-request', 'auto-review', 'never'],
    ...(options.configControls ? { configControls: options.configControls } : {}),

    async checkHealth() {
      return { ...health }
    },

    async listModels() {
      return health.available ? structuredClone(models) : []
    },

    async configureSession(sessionId, config) {
      const merged = { ...(sessionConfigs.get(sessionId) ?? {}), ...config }
      sessionConfigs.set(sessionId, merged)
      const agent = ctx.agents.get(sessionId)
      const targetModel = merged.model ?? models[0]?.id
      if (agent && targetModel) {
        agent.model.select({
          provider: id,
          model: targetModel,
          ...(merged.reasoningEffort ? { reasoningEffort: merged.reasoningEffort } : {}),
        })
      }
    },

    async runSessionTurn({ sessionId, input, config, signal, onApprovalRequest }) {
      if (!health.available) {
        throw Object.assign(new Error(health.message ?? 'Mock CLI binary not found'), {
          code: health.errorCode ?? 'CLI_NOT_FOUND',
        })
      }
      if (!health.authenticated) {
        throw Object.assign(new Error(health.message ?? 'Mock CLI not authenticated'), {
          code: health.errorCode ?? 'CLI_NOT_AUTHENTICATED',
        })
      }

      if (config) {
        await engine.configureSession(sessionId, config)
      }
      signal.throwIfAborted()

      const effectiveModel = sessionConfigs.get(sessionId)?.model ?? models[0]?.id ?? 'ext-default'
      const threadId = sessionThreads.get(sessionId) ?? `thread-${sessionId}`
      sessionThreads.set(sessionId, threadId)
      busySessions.add(sessionId)

      const cancelDeferred = Promise.withResolvers()
      activeTurns.set(sessionId, cancelDeferred)

      try {
        if (input.includes('NEED_APPROVAL') && onApprovalRequest) {
          const requestId = `req-${randomUUID()}`
          const approvalDeferred = Promise.withResolvers()
          const resolve = (decision) => {
            pendingApprovals.delete(requestId)
            approvalDeferred.resolve(decision)
          }
          pendingApprovals.set(requestId, resolve)
          onApprovalRequest({
            requestId,
            kind: 'command',
            title: 'Run mock command',
            detail: 'echo mock-approved',
            resolve,
          })

          const aborted = Promise.withResolvers()
          const onAbort = () => aborted.reject(signal.reason)
          signal.addEventListener('abort', onAbort, { once: true })
          try {
            const decision = await Promise.race([
              approvalDeferred.promise,
              cancelDeferred.promise,
              aborted.promise,
            ])
            return {
              replyText: decision?.approved ? 'Approved and executed' : 'Denied by user',
              threadId,
            }
          } finally {
            pendingApprovals.delete(requestId)
            signal.removeEventListener('abort', onAbort)
          }
        }

        return {
          replyText: `${label}(${effectiveModel}): ${input}`,
          threadId,
        }
      } finally {
        activeTurns.delete(sessionId)
        busySessions.delete(sessionId)
      }
    },

    isSessionBusy(sessionId) {
      return busySessions.has(sessionId)
    },

    async cancelSessionTurn(sessionId) {
      activeTurns.get(sessionId)?.reject(new Error('Mock turn cancelled'))
    },

    async readSessionThreadId(sessionId) {
      return sessionThreads.get(sessionId)
    },

    getSessionConfig(sessionId) {
      return sessionConfigs.get(sessionId)
    },

    resolveApproval(requestId, decision) {
      const resolve = pendingApprovals.get(requestId)
      if (!resolve) return false
      resolve(decision)
      return true
    },
  }

  let registry = ctx.root.get('externalCliEngines')
  if (!registry) {
    registry = createExternalCliEngineRegistry()
    ctx.provide('externalCliEngines', registry)
  }
  ctx.effect(() => registry.register(engine), 'mock-external-cli: register engine')

  ctx.effect(() => ctx.on('llm/stream', async function* (streamOptions, next) {
    if (streamOptions.provider !== id) {
      yield* next()
      return
    }
    const lastUser = streamOptions.messages.findLast(
      m => m.role === 'user' && ['user', 'deepduet'].includes(m.source?.kind),
    )
    const input = lastUser ? textOf(lastUser) : ''
    const text = `${label}(${streamOptions.model}): ${input}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }), 'mock-external-cli: llm/stream takeover')
}
