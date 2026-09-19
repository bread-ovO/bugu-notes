import type { openStore } from '@memo/storage'
import { analyzeNextAction, type TaskModelRequest } from '@memo/model'
import {
  canRecommend,
  hasEventGrant,
  rankTargets,
  validateNextModelInput,
} from '@memo/next-action'
import type {
  NextActionRequest,
  NextEvent,
  NextEvidence,
  NextTarget,
} from '@memo/contracts'

type Store = ReturnType<typeof openStore>
type Model = (
  input: TaskModelRequest,
) => Promise<{ content: string; model: string }>
/** Trusted adapter entry points. Importing a source is never an observation of the user seeing it. */
export function createNextActionService(
  store: Store,
  model: Model,
  now = Date.now,
) {
  let controller: AbortController | null = null
  let disposed = false
  const run = async <T>(
    operation: (signal: AbortSignal, version: number) => Promise<T>,
  ): Promise<T> => {
    const state = store.nextAction.snapshot()
    if (disposed || controller || !state.settings.enabled)
      throw Error('NEXT_UNAVAILABLE')
    store.nextWorkflow.takeBudget()
    const current = new AbortController()
    controller = current
    const timer = setTimeout(() => current.abort(), 45000)
    try {
      return await operation(current.signal, state.version)
    } finally {
      clearTimeout(timer)
      if (controller === current) controller = null
    }
  }
  const assertCurrent = (version: number, signal: AbortSignal) => {
    if (
      disposed ||
      signal.aborted ||
      store.nextAction.snapshot().version !== version
    )
      throw Error('NEXT_STALE_RESULT')
  }
  const authorizeEvidence = (event: NextEvent, evidence: NextEvidence[]) => {
    const grants = store.nextAction.data().grants
    if (
      !evidence.every((e) =>
        grants.some(
          (g) =>
            g.active &&
            g.projectId === event.projectId &&
            g.accountId === event.accountId &&
            g.sourceId === e.sourceId &&
            g.revision === e.grantRevision,
        ),
      )
    )
      throw Error('NEXT_NOT_AUTHORIZED')
  }
  const transport = async (request: TaskModelRequest) =>
    (await model(request)).content
  const eventById = (id: string) => {
    const event = store.nextAction.data().events.find((e) => e.id === id)
    if (!event) throw Error('NOT_FOUND')
    return event
  }
  const cancel = () => controller?.abort()
  return {
    cancel,
    dispose() {
      disposed = true
      cancel()
    },
    handle(request: NextActionRequest) {
      const repo = store.nextAction
      if (request.method === 'nextAction.status') {
        repo.prune()
        return repo.snapshot()
      }
      cancel()
      if (request.method === 'nextAction.configure')
        return repo.configure(request.settings, request.expectedVersion)
      if (request.method === 'nextAction.clear') {
        const result = repo.clear(request.expectedVersion)
        store.nextWorkflow.clear()
        return result
      }
      if (request.method === 'nextAction.feedback')
        return repo.feedback(
          request.choiceId,
          request.kind,
          request.expectedVersion,
        )
      return repo.undo(request.feedbackId, request.expectedVersion)
    },
    async observe(
      event: NextEvent,
      evidence: NextEvidence[],
    ): Promise<NextEvent> {
      return run(async (signal, version) => {
        // Grants are checked before sending any text to the model, not merely before persistence.
        const d = store.nextAction.data()
        if (!hasEventGrant(event, d)) throw Error('NEXT_NOT_AUTHORIZED')
        authorizeEvidence(event, evidence)
        const input = validateNextModelInput({
          mode: 'classify-event',
          event,
          evidence,
          targets: [],
        })
        const result = await analyzeNextAction(input, transport, signal)
        assertCurrent(version, signal)
        const classified = {
          ...event,
          eventType:
            result.related && result.confidence >= 0.9
              ? result.eventType
              : ('unknown' as const),
          action: result.action,
        }
        store.nextAction.putEvent(classified, version)
        return classified
      })
    },
    async attribute(input: {
      eventId: string
      choiceId: string
      revision: number
      target: NextTarget
      evidence: NextEvidence[]
    }): Promise<void> {
      return run(async (signal, version) => {
        const event = eventById(input.eventId)
        if (!hasEventGrant(event, store.nextAction.data()))
          throw Error('NEXT_NOT_AUTHORIZED')
        authorizeEvidence(event, input.evidence)
        const result = await analyzeNextAction(
          {
            mode: 'attribute-transition',
            event,
            evidence: input.evidence,
            targets: [input.target],
          },
          transport,
          signal,
        )
        assertCurrent(version, signal)
        store.nextAction.putChoice(
          {
            id: input.choiceId,
            eventId: event.id,
            eventRevision: event.revision,
            revision: input.revision,
            toolId: input.target.toolId,
            origin: 'natural',
            attribution: result.related ? 'model' : 'unknown',
            confidence: result.confidence,
            evidence: result.citations.map((c) => {
              const e = input.evidence.find((e) => e.id === c.id)!
              return {
                id: e.id,
                revision: e.revision,
                sourceId: e.sourceId,
                grantRevision: e.grantRevision,
                objectId: e.objectId,
                side: e.side,
              }
            }),
            createdAt: now(),
          },
          version,
        )
      })
    },
    async recommend(
      eventId: string,
      evidence: NextEvidence[],
      targets: NextTarget[],
    ): Promise<NextTarget[]> {
      const event = eventById(eventId)
      const snapshot = store.nextAction.snapshot()
      if (
        !snapshot.settings.enabled ||
        !canRecommend(
          event,
          store.nextAction.data(),
          snapshot.settings.shareAcrossProjects,
        )
      )
        return []
      return run(async (signal, version) => {
        authorizeEvidence(event, evidence)
        const eligible = rankTargets(
          event,
          store.nextAction.data(),
          targets,
          snapshot.settings.shareAcrossProjects,
        ).slice(0, 12)
        const result = await analyzeNextAction(
          { mode: 'recommend', event, evidence, targets: eligible },
          transport,
          signal,
        )
        assertCurrent(version, signal)
        if (!result.related) return []
        return rankTargets(
          event,
          store.nextAction.data(),
          result.targetIds.map((id) => targets.find((t) => t.id === id)!),
          snapshot.settings.shareAcrossProjects,
        )
      })
    },
  }
}
