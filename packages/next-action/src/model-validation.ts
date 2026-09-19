import { parseNextActionOutput, parseNextEvent, type NextActionOutput, type NextModelInput } from '@memo/contracts'

/** Evidence comes from authorized adapters, never from the renderer or the model. */
export function validateNextModelInput(input: NextModelInput): NextModelInput {
  parseNextEvent(input.event)
  if (!['classify-event', 'attribute-transition', 'recommend'].includes(input.mode) ||
      input.evidence.length > 20 || input.targets.length > 12 ||
      new Set(input.evidence.map(e => e.id)).size !== input.evidence.length ||
      new Set(input.targets.map(t => t.id)).size !== input.targets.length ||
      input.evidence.reduce((sum, e) => sum + e.text.length, 0) > 6000) throw Error('NEXT_INVALID_INPUT')
  for (const e of input.evidence) {
    if (!e.sourceId || !e.objectId || e.sourceId.length > 256 || e.objectId.length > 256 ||
        !Number.isSafeInteger(e.grantRevision) || e.grantRevision < 1 ||
        (e.side === 'source' && (e.objectId !== input.event.objectId || e.sourceId !== input.event.sourceId)) ||
        !e.id || e.id.length > 256 || !Number.isSafeInteger(e.revision) || e.revision < 1 ||
        e.projectId !== input.event.projectId || e.accountId !== input.event.accountId ||
        !['source', 'destination'].includes(e.side) || !e.text.trim()) throw Error('NEXT_INVALID_INPUT')
  }
  for (const t of input.targets) {
    if (!t.id || t.id.length > 256 || !Number.isSafeInteger(t.revision) || t.revision < 1 ||
        !t.toolId || t.toolId.length > 256 || !t.label || t.label.length > 120 ||
        !['open-object', 'open-app'].includes(t.kind) ||
        t.projectId !== input.event.projectId || t.accountId !== input.event.accountId) throw Error('NEXT_INVALID_INPUT')
  }
  return structuredClone(input)
}
export function validateNextDecision(raw: string, input: NextModelInput): NextActionOutput {
  const out = parseNextActionOutput(raw)
  if (out.mode !== input.mode || (out.mode !== 'recommend' && out.targetIds.length) ||
      (!out.related && out.targetIds.length) ||
      (out.eventType === 'unknown' && (out.related || out.targetIds.length))) throw Error('NEXT_INVALID_OUTPUT')
  const cited = new Set<string>()
  const sides = new Set<string>()
  for (const c of out.citations) {
    const e = input.evidence.find(e => e.id === c.id && e.revision === c.revision)
    if (!e || !c.quote.trim() || !e.text.includes(c.quote) || cited.has(c.id)) throw Error('NEXT_INVALID_CITATION')
    cited.add(c.id)
    sides.add(e.side)
  }
  if (out.eventType !== 'unknown' && !sides.has('source')) throw Error('NEXT_INVALID_CITATION')
  if (out.mode === 'attribute-transition' && out.related && !sides.has('destination')) throw Error('NEXT_INVALID_CITATION')
  if (out.mode !== 'classify-event' && (out.eventType !== input.event.eventType || out.action !== input.event.action))
    throw Error('NEXT_INVALID_OUTPUT')
  if (out.targetIds.some(id => !input.targets.some(t => t.id === id))) throw Error('NEXT_INVALID_TARGET')
  if (out.mode === 'recommend' && out.related && (!out.targetIds.length || out.confidence < 0.9))
    throw Error('NEXT_LOW_CONFIDENCE')
  // Valid quotes are a prerequisite, not proof of causality. Learning applies its own stricter gate.
  return out
}
