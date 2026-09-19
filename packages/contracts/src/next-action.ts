import Ajv from 'ajv'
import type { FromSchema } from 'json-schema-to-ts'

export const nextEventTypes = ['bug_fix', 'development', 'code_review', 'research', 'document', 'data', 'reply', 'unknown'] as const
export type NextEventType = typeof nextEventTypes[number]
const id = { type: 'string', minLength: 1, maxLength: 256, pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$' } as const
const revision = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const
const confidence = { type: 'number', minimum: 0, maximum: 1 } as const
export const nextActionSettingsSchema = {
  type: 'object', additionalProperties: false,
  required: ['enabled', 'shareAcrossProjects', 'proactive', 'shortcut', 'durationMs'],
  properties: {
    enabled: { type: 'boolean' }, shareAcrossProjects: { type: 'boolean' },
    proactive: { type: 'boolean' }, shortcut: { type: 'string', maxLength: 64 },
    durationMs: { enum: [3000, 5000, 8000] },
  },
} as const
export type NextActionSettings = FromSchema<typeof nextActionSettingsSchema>
export const defaultNextActionSettings: NextActionSettings = {
  enabled: false, shareAcrossProjects: true, proactive: true, shortcut: 'Tab', durationMs: 3000,
}
export const nextEventSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'projectId', 'accountId', 'sourceId', 'sourceApp', 'objectId', 'revision', 'grantRevision', 'visibility', 'eventType', 'action', 'createdAt'],
  properties: {
    id, projectId: id, accountId: id, sourceId: id, sourceApp: id, objectId: id,
    revision, grantRevision: revision, visibility: { enum: ['visible-object', 'explicit-open'] },
    eventType: { enum: nextEventTypes }, action: { enum: ['handle', 'review', 'research', 'reply'] },
    createdAt: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  },
} as const
export type NextEvent = FromSchema<typeof nextEventSchema>
export const nextChoiceSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'eventId', 'eventRevision', 'revision', 'toolId', 'origin', 'attribution', 'confidence', 'createdAt', 'evidence'],
  properties: {
    evidence: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false,
      required: ['id', 'revision', 'sourceId', 'grantRevision', 'objectId', 'side'],
      properties: { id, revision, sourceId: id, grantRevision: revision, objectId: id, side: { enum: ['source', 'destination'] } },
    } },
    id, eventId: id, eventRevision: revision, revision, toolId: id,
    origin: { enum: ['natural', 'explicit', 'suggestion'] },
    attribution: { enum: ['confirmed', 'model', 'unknown'] }, confidence,
    createdAt: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  },
} as const
export type NextChoice = FromSchema<typeof nextChoiceSchema>
export interface NextGrant {
  projectId: string
  accountId: string
  sourceId: string
  revision: number
  active: boolean
}
export interface NextPreference {
  id: string
  projectId: string | null
  sourceApp: string
  eventType: NextEventType
  action: NextEvent['action']
  toolId: string
}
export type NextFeedbackKind = 'wrong-event' | 'wrong-type' | 'wrong-target' | 'launch-failed' | 'dismissed'
export interface NextFeedback {
  id: string
  choiceId: string
  kind: NextFeedbackKind
  undone: boolean
  createdAt: number
}
export interface NextLearningData {
  events: NextEvent[]
  choices: NextChoice[]
  grants: NextGrant[]
  preferences: NextPreference[]
  feedback: NextFeedback[]
}
export interface NextHabit {
  state: 'learning' | 'ready'
  eventCount: number
  effectiveCount: number
  toolId: string | null
  confidence: number
  scope: 'project' | 'personal'
}
export interface NextTarget {
  id: string
  revision: number
  projectId: string
  accountId: string
  toolId: string
  label: string
  kind: 'open-object' | 'open-app'
}
export interface NextEvidence {
  sourceId: string
  grantRevision: number
  objectId: string
  id: string
  revision: number
  projectId: string
  accountId: string
  side: 'source' | 'destination'
  text: string
}
export const nextActionOutputSchema = {
  type: 'object', additionalProperties: false,
  required: ['mode', 'eventType', 'action', 'related', 'confidence', 'targetIds', 'citations', 'reason'],
  properties: {
    mode: { enum: ['classify-event', 'attribute-transition', 'recommend'] },
    eventType: { enum: nextEventTypes }, action: { enum: ['handle', 'review', 'research', 'reply'] },
    related: { type: 'boolean' }, confidence,
    targetIds: { type: 'array', maxItems: 3, uniqueItems: true, items: id },
    citations: { type: 'array', maxItems: 20, items: {
      type: 'object', additionalProperties: false, required: ['id', 'revision', 'quote'],
      properties: { id, revision, quote: { type: 'string', minLength: 1, maxLength: 1000 } },
    } },
    reason: { type: 'string', maxLength: 300 },
  },
} as const
// Provider structured-output schemas support a smaller JSON Schema vocabulary.
// Keep uniqueness enforced by the local validator, but don't send uniqueItems to providers.
export const nextActionWireSchema = {
  ...nextActionOutputSchema,
  properties: {
    ...nextActionOutputSchema.properties,
    targetIds: { type:'array', maxItems:3, items:id },
  },
} as const
export type NextActionOutput = FromSchema<typeof nextActionOutputSchema>
export interface NextModelInput {
  mode: NextActionOutput['mode']
  event: NextEvent
  evidence: NextEvidence[]
  targets: NextTarget[]
}
export const nextActionRequestSchema = {
  oneOf: [
    { type: 'object', additionalProperties: false, required: ['method'], properties: { method: { const: 'nextAction.status' } } },
    { type: 'object', additionalProperties: false, required: ['method', 'settings', 'expectedVersion'], properties: {
      method: { const: 'nextAction.configure' }, settings: nextActionSettingsSchema, expectedVersion: revision,
    } },
    { type: 'object', additionalProperties: false, required: ['method', 'expectedVersion'], properties: {
      method: { const: 'nextAction.clear' }, expectedVersion: revision,
    } },
    { type: 'object', additionalProperties: false, required: ['method', 'choiceId', 'kind', 'expectedVersion'], properties: {
      method: { const: 'nextAction.feedback' }, choiceId: id,
      kind: { enum: ['wrong-event', 'wrong-type', 'wrong-target', 'launch-failed', 'dismissed'] }, expectedVersion: revision,
    } },
    { type: 'object', additionalProperties: false, required: ['method', 'feedbackId', 'expectedVersion'], properties: {
      method: { const: 'nextAction.undo' }, feedbackId: id, expectedVersion: revision,
    } },
  ],
} as const
export type NextActionRequest = FromSchema<typeof nextActionRequestSchema>
export interface NextActionSnapshot {
  settings: NextActionSettings
  version: number
  eventCount: number
  choiceCount: number
  recent: Array<{ choiceId: string; toolId: string; eventType: NextEventType; createdAt: number; feedback: NextFeedback | null }>
}
const ajv = new Ajv({ strict: true })
const validateOutput = ajv.compile<NextActionOutput>(nextActionOutputSchema)
const validateEvent = ajv.compile<NextEvent>(nextEventSchema)
const validateChoice = ajv.compile<NextChoice>(nextChoiceSchema)
const validateSettings = ajv.compile<NextActionSettings>(nextActionSettingsSchema)
export function parseNextActionOutput(raw: string): NextActionOutput {
  if (raw.length > 32768) throw Error('NEXT_INVALID_OUTPUT')
  let data: unknown
  try { data = JSON.parse(raw) } catch { throw Error('NEXT_INVALID_OUTPUT') }
  if (!validateOutput(data)) throw Error('NEXT_INVALID_OUTPUT')
  return data
}
export function parseNextEvent(value: unknown): NextEvent {
  if (!validateEvent(value)) throw Error('NEXT_INVALID_EVENT')
  return structuredClone(value)
}
export function parseNextChoice(value: unknown): NextChoice {
  if (!validateChoice(value)) throw Error('NEXT_INVALID_CHOICE')
  return structuredClone(value)
}
export function parseNextSettings(value: unknown): NextActionSettings {
  if (!validateSettings(value)) throw Error('NEXT_INVALID_SETTINGS')
  return structuredClone(value)
}

export interface NextHintView { id: string; label: string; keycap: string | null; durationMs: number }
export interface NextHintBridge {
  ready(): void
  onShow(callback: (view: NextHintView) => void): () => void
  onHide(callback: () => void): () => void
  confirm(id: string): void
  dismiss(id: string): void
}
