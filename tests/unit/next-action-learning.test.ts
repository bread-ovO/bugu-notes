import { describe, expect, it } from 'vitest'
import { canRecommend, learnedHabit, rankTargets } from '@memo/next-action'
import { event, choice, learning, target } from '../fixtures/next-action'

describe('event-driven learning', () => {
  it('requires five independent real events; a preference cannot bootstrap a cold start', () => {
    const d = learning(4)
    d.preferences.push({ id: 'fixed', projectId: 'project-a', sourceApp: 'feishu', eventType: 'bug_fix', action: 'handle', toolId: 'codex' })
    expect(canRecommend(event(), d, true)).toBe(false)
    d.events.push(event('e4')); d.choices.push(choice('c4', 'e4'))
    expect(canRecommend(event(), d, true)).toBe(true)
  })
  it('does not count repeated switches, observation revisions, or duplicate choices as five events', () => {
    const d = learning(1)
    for (let i = 2; i < 9; i++) d.choices.push(choice(`repeat-${i}`, 'e0', { revision: i }))
    expect(learnedHabit(event(), d, true).eventCount).toBe(1)
    expect(canRecommend(event(), d, true)).toBe(false)
  })
  it.each(['suggestion', 'unknown', 'weak-model', 'unknown-event', 'old-revision', 'revoked', 'renewed-grant'] as const)('rejects bootstrap via %s', mode => {
    const d = learning(10)
    if (mode === 'suggestion') d.choices.forEach(c => c.origin = 'suggestion')
    if (mode === 'unknown') d.choices.forEach(c => c.attribution = 'unknown')
    if (mode === 'weak-model') d.choices.forEach(c => { c.attribution = 'model'; c.confidence = 0.94 })
    if (mode === 'unknown-event') d.events.forEach(e => e.eventType = 'unknown')
    if (mode === 'old-revision') d.events.forEach(e => e.revision++)
    if (mode === 'revoked') d.grants[0]!.active = false
    if (mode === 'renewed-grant') d.grants[0]!.revision++
    expect(canRecommend(event(), d, true)).toBe(false)
  })
  it('recommendation clicks neither add evidence nor erase earlier independent choices', () => {
    const d = learning()
    d.choices.push(choice('recommended', 'e0', { revision: 2, origin: 'suggestion', toolId: 'claude' }))
    expect(learnedHabit(event(), d, true)).toMatchObject({ state: 'ready', eventCount: 5, toolId: 'codex' })
  })
  it('weights automatic attributions below confirmed choices', () => {
    const d = learning(5)
    d.choices.forEach(c => { c.attribution = 'model'; c.confidence = 0.97; c.evidence = [
      { id: `src-${c.eventId}`, revision: 1, sourceId: 'source-a', grantRevision: 1, objectId: `message-${c.eventId}`, side: 'source' },
      { id: `dest-${c.eventId}`, revision: 1, sourceId: 'source-a', grantRevision: 1, objectId: 'session', side: 'destination' },
    ] })
    expect(learnedHabit(event(), d, true).effectiveCount).toBe(2.5)
    expect(canRecommend(event(), d, true)).toBe(false)
  })
  it('links an event even next day; neither duration nor inactivity manufactures a relation', () => {
    const d = learning()
    d.choices.forEach(c => c.createdAt += 5 * 86400000)
    expect(canRecommend(event(), d, true)).toBe(true)
    d.choices.forEach(c => c.attribution = 'unknown')
    expect(canRecommend(event(), d, true)).toBe(false)
  })
  it('mixed tool usage is not a stable habit', () => {
    const d = learning(10)
    d.choices.slice(5).forEach(c => c.toolId = 'claude')
    expect(canRecommend(event(), d, true)).toBe(false)
  })
  it.each(['dismissed', 'launch-failed', 'wrong-target'] as const)('%s does not punish the tool preference', kind => {
    const d = learning()
    d.feedback.push({ id: 'f', choiceId: 'c1', kind, undone: false, createdAt: 1 })
    expect(canRecommend(event('fresh'), d, true)).toBe(true)
  })
  it.each(['wrong-event', 'wrong-type'] as const)('%s retracts contribution, suppresses this event, and supports undo', kind => {
    const d = learning()
    const f = { id: 'f', choiceId: 'c1', kind, undone: false, createdAt: 1 }
    d.feedback.push(f)
    expect(learnedHabit(event('fresh'), d, true).eventCount).toBe(4)
    expect(canRecommend(event('e1'), d, true)).toBe(false)
    f.undone = true
    expect(canRecommend(event('e1'), d, true)).toBe(true)
  })
  it('shares tools to authorized new projects, never shares concrete targets or ungranted contexts', () => {
    const d = learning()
    const b = event('b', { projectId: 'project-b' })
    expect(canRecommend(b, d, true)).toBe(false)
    d.grants.push({ ...d.grants[0]!, projectId: 'project-b' })
    expect(canRecommend(b, d, true)).toBe(true)
    expect(canRecommend(b, d, false)).toBe(false)
    expect(rankTargets(b, d, [target(), target('b', { projectId: 'project-b' })], true).map(t => t.id)).toEqual(['b'])
  })
  it('explicit current choice > project preference > learned project > personal preference', () => {
    const d = learning()
    d.preferences.push({ id: 'b', projectId: 'project-a', sourceApp: 'feishu', eventType: 'bug_fix', action: 'handle', toolId: 'claude' })
    const ts = [target(), target('claude', { toolId: 'claude' })]
    expect(rankTargets(event(), d, ts, true)[0]!.toolId).toBe('claude')
    expect(rankTargets(event(), d, ts, true, 'codex-a')[0]!.toolId).toBe('codex')
    d.preferences[0]!.projectId = null
    expect(rankTargets(event(), d, ts, true)[0]!.toolId).toBe('codex')
  })
  it('event type, source application and action are separate learning scopes', () => {
    for (const patch of [{ eventType: 'research' as const }, { sourceApp: 'mail' }, { action: 'review' as const }])
      expect(canRecommend(event('new', patch), learning(), true)).toBe(false)
  })
})
