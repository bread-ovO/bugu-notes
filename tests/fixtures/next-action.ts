import type { NextChoice, NextEvent, NextLearningData, NextModelInput, NextTarget, NextActionOutput } from '@memo/contracts'
export function event(id = 'e1', patch: Partial<NextEvent> = {}): NextEvent {
  return { id, projectId: 'project-a', accountId: 'account-a', sourceId: 'source-a', sourceApp: 'feishu', objectId: `message-${id}`, revision: 1, grantRevision: 1,
    visibility: 'explicit-open', eventType: 'bug_fix', action: 'handle', createdAt: 1000, ...patch }
}
export function choice(id = 'c1', eventId = 'e1', patch: Partial<NextChoice> = {}): NextChoice {
  return { id, eventId, eventRevision: 1, revision: 1, toolId: 'codex', origin: 'natural', attribution: 'confirmed', confidence: 1, evidence: [], createdAt: 90000000, ...patch }
}
export function learning(count = 5): NextLearningData {
  return { events: Array.from({ length: count }, (_, i) => event(`e${i}`)), choices: Array.from({ length: count }, (_, i) => choice(`c${i}`, `e${i}`)),
    grants: [{ projectId: 'project-a', accountId: 'account-a', sourceId: 'source-a', revision: 1, active: true }], feedback: [], preferences: [] }
}
export function target(id = 'codex-a', patch: Partial<NextTarget> = {}): NextTarget {
  return { id, revision: 1, projectId: 'project-a', accountId: 'account-a', toolId: 'codex', label: 'Codex', kind: 'open-app', ...patch }
}
export function modelInput(mode: NextModelInput['mode'] = 'attribute-transition'): NextModelInput {
  return { mode, event: event(), evidence: [
    { id: 'source-msg', sourceId: 'source-a', grantRevision: 1, objectId: 'message-e1', revision: 1, projectId: 'project-a', accountId: 'account-a', side: 'source', text: '请修复登录后白屏，问题编号 BUG-42。' },
    { id: 'destination-msg', sourceId: 'source-b', grantRevision: 1, objectId: 'coding-session', revision: 2, projectId: 'project-a', accountId: 'account-a', side: 'destination', text: '正在修复 BUG-42 的登录后白屏。' },
  ], targets: [target()] }
}
export function output(patch: Partial<NextActionOutput> = {}): NextActionOutput {
  return { mode: 'attribute-transition', eventType: 'bug_fix', action: 'handle', related: true, confidence: 0.97, targetIds: [], citations: [
    { id: 'source-msg', revision: 1, quote: '问题编号 BUG-42' }, { id: 'destination-msg', revision: 2, quote: '正在修复 BUG-42' },
  ], reason: '两侧明确提到同一个问题编号与修复行为', ...patch }
}
