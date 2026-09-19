import { randomUUID } from 'node:crypto'
import type { openStore } from '@memo/storage'
import type {
  NextWorkbench,
  NextWorkflowRequest,
  NextHostRequest,
  NextEvent,
} from '@memo/contracts'
import { learnedHabit } from '@memo/next-action'
import type { createNextActionService } from './next-action-service'

type Store = ReturnType<typeof openStore>
type Service = ReturnType<typeof createNextActionService>
/** Source identifiers are resolved inside the core; renderer/extension never supplies model evidence. */
export function createNextWorkflow(
  store: Store,
  service: Service,
  now = Date.now,
) {
  const repo = store.nextWorkflow
  let busy = false
  let error: string | null = null
  let generation = 0
  let observedRecordId: number | null = null
  let openedRecord: number | null = null
  const queue: Array<() => Promise<void>> = []
  const scheduled = new Set<string>()
  const snapshot = (): NextWorkbench => {
    repo.reconcile()
    const state = store.nextAction.snapshot()
    const data = store.nextAction.data()
    let opened: NextWorkbench['opened'] = null
    if (openedRecord && state.settings.enabled)
      try {
        opened = repo.opened(openedRecord)
      } catch {
        openedRecord = null
      }
    return {
      opened,
      observedRecordId,
      version: state.version,
      settings: state.settings,
      sources: repo.sources(),
      contexts: state.settings.enabled ? repo.contexts() : [],
      events: state.settings.enabled
        ? data.events
            .slice()
            .reverse()
            .slice(0, 20)
            .flatMap((e) => {
              try {
                const c = repo.getEvent(e.id)
                return [
                  {
                    id: e.id,
                    recordId: c.recordId,
                    label: c.label,
                    eventType: e.eventType,
                    habit: learnedHabit(
                      e,
                      data,
                      state.settings.shareAcrossProjects,
                    ),
                    targets: repo.targets(e),
                  },
                ]
              } catch {
                return []
              }
            })
        : [],
      suggestions: repo.suggestions(),
      tools: repo.tools(),
      busy,
      error,
      observation: repo.observation(),
    }
  }
  const drain = async () => {
    if (busy) return
    busy = true
    try {
      while (queue.length) {
        const job = queue.shift()!
        try {
          await job()
        } catch (e) {
          error =
            e instanceof Error && /^NEXT_[A-Z_]+$/.test(e.message)
              ? e.message
              : 'NEXT_ANALYSIS_FAILED'
        }
      }
    } finally {
      busy = false
    }
  }
  const enqueue = (key: string, job: () => Promise<void>) => {
    if (scheduled.has(key) || queue.length >= 20) return
    scheduled.add(key)
    queue.push(async () => {
      try {
        await job()
      } finally {
        scheduled.delete(key)
      }
    })
    void drain()
  }
  const cancel = () => {
    generation++
    queue.length = 0
    scheduled.clear()
    service.cancel()
  }
  const current = (epoch: number) => {
    repo.reconcile()
    if (generation !== epoch || !store.nextAction.snapshot().settings.enabled)
      throw Error('NEXT_STALE_RESULT')
  }
  const inspect = (
    recordId: number,
    visibility: NextEvent['visibility'] = 'explicit-open',
  ) => {
    if (!store.nextAction.snapshot().settings.enabled)
      throw Error('NEXT_UNAVAILABLE')
    const context = repo.context(recordId, visibility)
    observedRecordId = recordId
    const epoch = generation
    enqueue(
      `inspect:${context.event.id}:${context.event.revision}`,
      async () => {
        error = null
        current(epoch)
        let event = store.nextAction
          .data()
          .events.find(
            (e) =>
              e.id === context.event.id &&
              e.revision === context.event.revision,
          )
        if (!event)
          event = await service.observe(context.event, [context.evidence])
        current(epoch)
        // An explicitly opened destination can be associated to several long-lived events.
        // Every link needs model citations from BOTH objects; recency never establishes the relationship.
        const previous = store.nextAction
          .data()
          .events.filter(
            (e) =>
              e.id !== event!.id &&
              e.projectId === event!.projectId &&
              e.accountId === event!.accountId &&
              e.sourceApp !== event!.sourceApp &&
              e.eventType !== 'unknown',
          )
          .slice(-12)
        for (const source of previous) {
          current(epoch)
          const target = repo
            .targets(source)
            .find((t) => t.toolId === event!.sourceApp)
          if (!target) continue
          const d = store.nextAction.data()
          if (
            d.choices.some(
              (c) =>
                c.eventId === source.id &&
                c.evidence.some(
                  (r) =>
                    r.side === 'destination' &&
                    r.id === context.evidence.id &&
                    r.revision === context.evidence.revision,
                ),
            )
          )
            continue
          let origin: ReturnType<typeof repo.getEvent>
          try {
            origin = repo.getEvent(source.id)
          } catch {
            continue
          }
          // Don't turn a recommendation-induced visit into independent training data.
          if (
            repo
              .suggestions()
              .some(
                (s) =>
                  s.eventId === source.id &&
                  s.targetId === target.id &&
                  s.state === 'confirmed',
              )
          )
            continue
          await service.attribute({
            eventId: source.id,
            choiceId: randomUUID(),
            revision:
              Math.max(
                0,
                ...d.choices
                  .filter((c) => c.eventId === source.id)
                  .map((c) => c.revision),
              ) + 1,
            target,
            evidence: [
              origin.evidence,
              { ...context.evidence, side: 'destination' },
            ],
          })
        }
        current(epoch)
        const fresh = repo.getEvent(event.id)
        const feedback = store.nextAction.data().feedback
        const blocked = new Set(
          repo
            .suggestions()
            .filter(
              (s) =>
                s.eventId === event.id &&
                feedback.some(
                  (f) =>
                    f.choiceId === s.choiceId &&
                    f.kind === 'wrong-target' &&
                    !f.undone,
                ),
            )
            .map((s) => s.targetId),
        )
        const targets = await service.recommend(
          event.id,
          [fresh.evidence],
          repo.targets(event).filter((t) => !blocked.has(t.id)),
        )
        current(epoch)
        if (
          targets[0] &&
          !repo
            .suggestions()
            .some(
              (s) =>
                s.eventId === event.id &&
                s.state === 'offered' &&
                s.expiresAt > now(),
            )
        )
          repo.offer(event, targets[0])
      },
    )
  }
  return {
    snapshot,
    cancel,
    handle(request: NextWorkflowRequest | NextHostRequest): NextWorkbench {
      repo.reconcile()
      switch (request.method) {
        case 'nextAction.workbench':
        case 'nextActionHost.reconcile':
          return snapshot()
        case 'nextAction.enroll':
          cancel()
          repo.enroll(request.sourceIds, request.expectedVersion)
          break
        case 'nextAction.inspect':
          repo.opened(request.recordId)
          openedRecord = request.recordId
          inspect(request.recordId)
          break
        case 'nextAction.forgetPreference':
          cancel()
          repo.forgetPreference(request.eventId, request.scope)
          break
        case 'nextAction.prefer':
          cancel()
          repo.prefer(request.eventId, request.toolId, request.scope)
          break
        case 'nextAction.reclassify':
          cancel()
          repo.reclassify(request.eventId, request.eventType)
          inspect(repo.getEvent(request.eventId).recordId)
          break
        case 'nextAction.erase':
          cancel()
          repo.erase(request.scope, request.id)
          break
        case 'nextAction.observation':
          cancel()
          repo.setObservation(request.enabled, request.appIds)
          break
        case 'nextActionHost.targets':
          repo.setTools(request.targets)
          break
        case 'nextActionHost.candidates':
          throw Error('INVALID_REQUEST')
        case 'nextActionHost.visible': {
          if (
            repo
              .visibleCandidates()
              .some((c) => c.recordId === request.recordId)
          )
            inspect(request.recordId, 'visible-object')
          break
        }
        case 'nextActionHost.page': {
          observedRecordId = null
          if (
            !repo.observation().enabled ||
            !store.nextAction.snapshot().settings.enabled
          )
            break
          const recordId = repo.resolvePage(request.url)
          if (recordId) inspect(recordId, request.visibility)
          break
        }
        case 'nextAction.dismissSuggestion': {
          cancel()
          const suggestion = repo.suggestions().find((s) => s.id === request.id)
          if (!suggestion || suggestion.state !== 'offered')
            throw Error('NOT_FOUND')
          const { event, evidence } = repo.getEvent(suggestion.eventId)
          const target = repo
            .targets(event)
            .find((t) => t.id === suggestion.targetId)
          if (!target) throw Error('NEXT_INVALID_TARGET')
          const data = store.nextAction.data(),
            choiceId = randomUUID()
          store.nextAction.putChoice(
            {
              id: choiceId,
              eventId: event.id,
              eventRevision: event.revision,
              revision:
                Math.max(
                  0,
                  ...data.choices
                    .filter((c) => c.eventId === event.id)
                    .map((c) => c.revision),
                ) + 1,
              toolId: target.toolId,
              origin: 'suggestion',
              attribution: 'unknown',
              confidence: 0,
              evidence: [
                {
                  id: evidence.id,
                  revision: evidence.revision,
                  sourceId: evidence.sourceId,
                  grantRevision: evidence.grantRevision,
                  objectId: evidence.objectId,
                  side: 'source',
                },
              ],
              createdAt: now(),
            },
            store.nextAction.snapshot().version,
          )
          repo.updateSuggestion(suggestion.id, 'dismissed', choiceId)
          store.nextAction.feedback(
            choiceId,
            request.kind,
            store.nextAction.snapshot().version,
          )
          break
        }
        case 'nextActionHost.chosen': {
          if (!store.nextAction.snapshot().settings.enabled)
            throw Error('NEXT_UNAVAILABLE')
          const { event, evidence } = repo.getEvent(request.eventId)
          const target = repo
            .targets(event)
            .find((t) => t.id === request.targetId)
          if (!target) throw Error('NEXT_INVALID_TARGET')
          if (request.origin === 'suggestion') {
            const s = repo
              .suggestions()
              .find(
                (s) =>
                  s.id === request.suggestionId &&
                  s.eventId === event.id &&
                  s.targetId === target.id,
              )
            if (!s || s.state !== 'offered') throw Error('NEXT_INVALID_TARGET')
          }
          const data = store.nextAction.data()
          const choiceId = randomUUID()
          store.nextAction.putChoice(
            {
              id: choiceId,
              eventId: event.id,
              eventRevision: event.revision,
              revision:
                Math.max(
                  0,
                  ...data.choices
                    .filter((c) => c.eventId === event.id)
                    .map((c) => c.revision),
                ) + 1,
              toolId: target.toolId,
              origin: request.origin,
              attribution:
                request.result === 'failed' ? 'unknown' : 'confirmed',
              confidence: request.result === 'failed' ? 0 : 1,
              evidence: [
                {
                  id: evidence.id,
                  revision: evidence.revision,
                  sourceId: evidence.sourceId,
                  grantRevision: evidence.grantRevision,
                  objectId: evidence.objectId,
                  side: 'source',
                },
              ],
              createdAt: now(),
            },
            store.nextAction.snapshot().version,
          )
          if (request.suggestionId)
            repo.updateSuggestion(
              request.suggestionId,
              request.result === 'failed' ? 'failed' : 'confirmed',
              choiceId,
            )
          if (request.result === 'failed')
            store.nextAction.feedback(
              choiceId,
              'launch-failed',
              store.nextAction.snapshot().version,
            )
          break
        }
        default:
          throw Error('INVALID_REQUEST') // Execution/OS permission live in the host, never the core.
      }
      return snapshot()
    },
  }
}
