import type {
  NextChoice,
  NextEvent,
  NextHabit,
  NextLearningData,
  NextTarget,
} from '@memo/contracts'

export function hasEventGrant(
  event: NextEvent,
  data: Pick<NextLearningData, 'grants'>,
): boolean {
  return data.grants.some(
    (g) =>
      g.active &&
      g.projectId === event.projectId &&
      g.accountId === event.accountId &&
      g.sourceId === event.sourceId &&
      g.revision === event.grantRevision,
  )
}
export function choiceContribution(
  choice: NextChoice,
  event: NextEvent,
  data: NextLearningData,
): number {
  if (isRetracted(choice, data)) return 0
  if (
    !hasEventGrant(event, data) ||
    choice.evidence.some(
      (e) =>
        !data.grants.some(
          (g) =>
            g.active &&
            g.sourceId === e.sourceId &&
            g.revision === e.grantRevision &&
            g.projectId === event.projectId &&
            g.accountId === event.accountId,
        ),
    )
  )
    return 0
  if (
    choice.attribution === 'model' &&
    (!choice.evidence.some(
      (e) =>
        e.side === 'source' &&
        e.sourceId === event.sourceId &&
        e.objectId === event.objectId,
    ) ||
      !choice.evidence.some((e) => e.side === 'destination'))
  )
    return 0
  if (choice.origin === 'suggestion' || choice.attribution === 'unknown')
    return 0
  if (choice.attribution === 'confirmed') return choice.confidence === 1 ? 1 : 0
  return choice.origin === 'natural' && choice.confidence >= 0.95 ? 0.5 : 0
}
export function isRetracted(
  choice: NextChoice,
  data: NextLearningData,
): boolean {
  return data.feedback.some(
    (f) =>
      f.choiceId === choice.id &&
      !f.undone &&
      (f.kind === 'wrong-event' || f.kind === 'wrong-type'),
  )
}
export function latestIndependentChoices(
  data: NextLearningData,
): Map<string, NextChoice> {
  const events = new Map(data.events.map((e) => [e.id, e]))
  const latest = new Map<string, NextChoice>()
  for (const choice of data.choices) {
    if (
      choice.origin === 'suggestion' ||
      events.get(choice.eventId)?.revision !== choice.eventRevision
    )
      continue
    const old = latest.get(choice.eventId)
    if (
      !old ||
      choice.revision > old.revision ||
      (choice.revision === old.revision &&
        (choice.createdAt > old.createdAt ||
          (choice.createdAt === old.createdAt &&
            choice.id.localeCompare(old.id) > 0)))
    )
      latest.set(choice.eventId, choice)
  }
  return latest
}
export function learnedHabit(
  event: NextEvent,
  data: NextLearningData,
  shareAcrossProjects: boolean,
): NextHabit {
  // A live event supersedes its archived contribution, even if its new choice is uncertain.
  const live = new Set(data.events.map((e) => e.id))
  const archived = (data.contributions ?? []).filter(
    (c) => !live.has(c.event.id),
  )
  const facts = {
    ...data,
    events: [...data.events, ...archived.map((c) => c.event)],
    choices: [...data.choices, ...archived.map((c) => c.choice)],
  }
  const latest = latestIndependentChoices(facts)
  const calculate = (scope: 'project' | 'personal'): NextHabit => {
    const counts = new Map<string, { events: number; weight: number }>()
    let total = 0
    // Each business event contributes once, including across observation revisions and repeated switches.
    for (const e of facts.events) {
      if (
        e.eventType === 'unknown' ||
        e.eventType !== event.eventType ||
        e.action !== event.action ||
        e.sourceApp !== event.sourceApp ||
        !hasEventGrant(e, data) ||
        (scope === 'project' &&
          (e.projectId !== event.projectId || e.accountId !== event.accountId))
      )
        continue
      const c = latest.get(e.id)
      if (!c || isRetracted(c, data)) continue
      const weight = choiceContribution(c, e, data)
      if (!weight) continue
      const old = counts.get(c.toolId) ?? { events: 0, weight: 0 }
      counts.set(c.toolId, {
        events: old.events + 1,
        weight: old.weight + weight,
      })
      total += weight
    }
    const best = [...counts].sort(
      (a, b) => b[1].weight - a[1].weight || a[0].localeCompare(b[0]),
    )[0]
    const score = best && total ? best[1].weight / total : 0
    // The count is an engineering gate, not a measured accuracy claim. Weak model links need more evidence.
    const ready =
      !!best && best[1].events >= 5 && best[1].weight >= 5 && score >= 0.8
    return {
      state: ready ? 'ready' : 'learning',
      eventCount: best?.[1].events ?? 0,
      effectiveCount: best?.[1].weight ?? 0,
      toolId: ready ? best![0] : null,
      confidence: score,
      scope,
    }
  }
  if (!hasEventGrant(event, data) || event.eventType === 'unknown')
    return {
      state: 'learning',
      eventCount: 0,
      effectiveCount: 0,
      toolId: null,
      confidence: 0,
      scope: 'project',
    }
  const local = calculate('project')
  if (local.state === 'ready' || !shareAcrossProjects) return local
  const personal = calculate('personal')
  return personal.state === 'ready' ? personal : local
}

export function rankTargets(
  event: NextEvent,
  data: NextLearningData,
  candidates: NextTarget[],
  shareAcrossProjects: boolean,
  explicitTargetId?: string,
): NextTarget[] {
  const safe = candidates.filter(
    (t) => t.projectId === event.projectId && t.accountId === event.accountId,
  )
  const habit = learnedHabit(event, data, shareAcrossProjects)
  const matching = data.preferences.filter(
    (p) =>
      p.sourceApp === event.sourceApp &&
      p.eventType === event.eventType &&
      p.action === event.action,
  )
  const local = matching.find((p) => p.projectId === event.projectId)
  const personal = shareAcrossProjects
    ? matching.find((p) => p.projectId === null)
    : undefined
  const projectHabit = learnedHabit(event, data, false)
  const tool =
    local?.toolId ?? projectHabit.toolId ?? personal?.toolId ?? habit.toolId
  return [...safe].sort(
    (a, b) =>
      Number(b.id === explicitTargetId) - Number(a.id === explicitTargetId) ||
      Number(b.toolId === tool) - Number(a.toolId === tool),
  )
}

export function canRecommend(
  event: NextEvent,
  data: NextLearningData,
  shareAcrossProjects: boolean,
): boolean {
  if (!hasEventGrant(event, data)) return false
  const sameEventChoices = new Set(
    data.choices.filter((c) => c.eventId === event.id).map((c) => c.id),
  )
  if (
    data.feedback.some(
      (f) =>
        !f.undone &&
        sameEventChoices.has(f.choiceId) &&
        (f.kind === 'wrong-event' || f.kind === 'wrong-type'),
    )
  )
    return false
  return learnedHabit(event, data, shareAcrossProjects).state === 'ready'
}
