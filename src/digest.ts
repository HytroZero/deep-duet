export type DigestEvent = {
  masterId: string
  sessionId: string
  title: string
  status: 'idle' | 'failed'
  needsDecision: boolean
  decisionQuestion?: string
  summary: string
}

type Delivery = (
  masterId: string,
  takeMessage: () => string | undefined,
  signal: AbortSignal,
) => Promise<void>

type Batch = {
  events: Map<string, { event: DigestEvent; failures: number }>
  timer?: ReturnType<typeof setTimeout>
  delivery?: Promise<void>
  controller?: AbortController
}

const WINDOW_MS = 1500
const MAX_ATTEMPTS = 3

export function createDigestQueue(deliver: Delivery, warn: (message: string) => void) {
  const batches = new Map<string, Batch>()
  const lifetime = new AbortController()

  function schedule(masterId: string, batch: Batch) {
    if (lifetime.signal.aborted || batch.timer || batch.delivery || !batch.events.size) return
    batch.timer = setTimeout(() => {
      batch.timer = undefined
      const controller = new AbortController()
      batch.controller = controller
      const signal = AbortSignal.any([lifetime.signal, controller.signal])
      batch.delivery = flush(masterId, batch, signal).finally(() => {
        batch.controller = undefined
        batch.delivery = undefined
        if (lifetime.signal.aborted || !batch.events.size) batches.delete(masterId)
        else schedule(masterId, batch)
      })
    }, WINDOW_MS)
  }

  async function flush(masterId: string, batch: Batch, signal: AbortSignal) {
    // Read the batch at the host's delivery boundary, after waiting for idle.
    let attempted: Batch['events'] | undefined
    try {
      await deliver(masterId, () => {
        if (signal.aborted || !batch.events.size) return
        attempted = new Map(batch.events)
        const events = [...attempted.values()].map(item => item.event)
        events.sort((a, b) => priority(b) - priority(a))
        return '[Background Digest]\n' + events.map(event => {
          const detail = event.decisionQuestion
            ? `\n    [NEED_DECISION]: ${indent(event.decisionQuestion)}`
            : ''
          return `- ${oneLine(event.title)} (${event.sessionId}) [${event.status}] ${indent(event.summary)}${detail}`
        }).join('\n')
      }, signal)
      for (const [id, item] of attempted ?? []) {
        if (batch.events.get(id) === item) batch.events.delete(id)
      }
    } catch (error) {
      if (signal.aborted) return
      for (const [id, item] of attempted ?? batch.events) {
        if (batch.events.get(id) !== item) continue
        item.failures++
        if (item.failures >= MAX_ATTEMPTS) {
          batch.events.delete(id)
          warn(`DeepDuet could not notify ${masterId} about ${id}: ${String(error)}`)
        }
      }
    }
  }

  return {
    enqueue(event: DigestEvent) {
      if (lifetime.signal.aborted) return
      const batch: Batch = batches.get(event.masterId) ?? { events: new Map() }
      batches.set(event.masterId, batch)
      batch.events.set(event.sessionId, { event, failures: 0 })
      schedule(event.masterId, batch)
    },
    forget(masterId: string, sessionId: string) {
      const batch = batches.get(masterId)
      if (!batch) return
      batch.events.delete(sessionId)
      if (batch.events.size) return
      if (batch.delivery) {
        batch.controller?.abort()
        return
      }
      clearTimeout(batch.timer)
      batches.delete(masterId)
    },
    async close() {
      lifetime.abort()
      for (const batch of batches.values()) clearTimeout(batch.timer)
      await Promise.all([...batches.values()].map(batch => batch.delivery))
      batches.clear()
    },
  }
}

/** Keep each task's entry visually nested so a multi-line summary cannot pose as another task or decision. */
function indent(text: string) {
  return text.replace(/\r?\n/g, '\n    ')
}

function oneLine(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

function priority(event: DigestEvent) {
  return Number(event.needsDecision || event.status === 'failed')
}
