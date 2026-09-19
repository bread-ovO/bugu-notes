import Ajv from 'ajv'
import type { FromSchema } from 'json-schema-to-ts'
import type {
  NextActionSettings,
  NextEventType,
  NextHabit,
  NextTarget,
} from './next-action'
const id = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
  pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$',
} as const
const num = {
  type: 'integer',
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
} as const
const ids = {
  type: 'array',
  maxItems: 100,
  uniqueItems: true,
  items: id,
} as const
export const nextWorkflowRequestSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['method'],
      properties: { method: { const: 'nextAction.browserRemove' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method'],
      properties: { method: { const: 'nextAction.diagnostics' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'id', 'kind'],
      properties: {
        method: { const: 'nextAction.dismissSuggestion' },
        id,
        kind: {
          enum: ['wrong-event', 'wrong-type', 'wrong-target', 'dismissed'],
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'eventId', 'scope'],
      properties: {
        method: { const: 'nextAction.forgetPreference' },
        eventId: id,
        scope: { enum: ['project', 'personal'] },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method'],
      properties: { method: { const: 'nextAction.addApplication' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method'],
      properties: { method: { const: 'nextAction.workbench' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'sourceIds', 'sendToModel', 'expectedVersion'],
      properties: {
        method: { const: 'nextAction.enroll' },
        sourceIds: ids,
        sendToModel: { const: true },
        expectedVersion: num,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'recordId'],
      properties: { method: { const: 'nextAction.inspect' }, recordId: num },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'eventId', 'targetId'],
      properties: {
        method: { const: 'nextAction.choose' },
        eventId: id,
        targetId: id,
        suggestionId: id,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'eventId', 'toolId', 'scope'],
      properties: {
        method: { const: 'nextAction.prefer' },
        eventId: id,
        toolId: id,
        scope: { enum: ['project', 'personal'] },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'eventId', 'eventType'],
      properties: {
        method: { const: 'nextAction.reclassify' },
        eventId: id,
        eventType: {
          enum: [
            'bug_fix',
            'development',
            'code_review',
            'research',
            'document',
            'data',
            'reply',
            'unknown',
          ],
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'scope', 'id'],
      properties: {
        method: { const: 'nextAction.erase' },
        scope: { enum: ['project', 'source', 'tool'] },
        id,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'appIds', 'enabled'],
      properties: {
        method: { const: 'nextAction.observation' },
        appIds: ids,
        enabled: { type: 'boolean' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method'],
      properties: { method: { const: 'nextAction.permission' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method'],
      properties: { method: { const: 'nextAction.browserSetup' } },
    },
  ],
} as const
export type NextWorkflowRequest = FromSchema<typeof nextWorkflowRequestSchema>
export const nextHostRequestSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'eventId', 'targetId'],
      properties: {
        method: { const: 'nextActionHost.target' },
        eventId: id,
        targetId: id,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'recordId'],
      properties: {
        method: { const: 'nextActionHost.visible' },
        recordId: num,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method'],
      properties: { method: { const: 'nextActionHost.candidates' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'targets'],
      properties: {
        method: { const: 'nextActionHost.targets' },
        targets: {
          type: 'array',
          maxItems: 24,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'label'],
            properties: {
              id,
              label: { type: 'string', minLength: 1, maxLength: 120 },
            },
          },
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'eventId', 'targetId', 'result', 'origin'],
      properties: {
        method: { const: 'nextActionHost.chosen' },
        eventId: id,
        targetId: id,
        result: {
          enum: [
            'dispatched',
            'app-observed',
            'target-confirmed',
            'unknown',
            'failed',
          ],
        },
        origin: { enum: ['explicit', 'suggestion'] },
        suggestionId: id,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'url', 'visibility'],
      properties: {
        method: { const: 'nextActionHost.page' },
        url: { type: 'string', maxLength: 2048 },
        visibility: { enum: ['visible-object', 'explicit-open'] },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method'],
      properties: { method: { const: 'nextActionHost.reconcile' } },
    },
  ],
} as const
export type NextHostRequest = FromSchema<typeof nextHostRequestSchema>
const validateHost = new Ajv({ strict: true }).compile<NextHostRequest>(
  nextHostRequestSchema,
)
export function parseNextHostRequest(value: unknown): NextHostRequest {
  if (!validateHost(value)) throw Error('INVALID_REQUEST')
  return value
}
export interface NextSourceOption {
  id: string
  projectId: string
  projectName: string
  label: string
  appId: string
  selected: boolean
}
export interface NextContextOption {
  recordId: number
  sourceId: string
  projectId: string
  label: string
  preview: string
}
export interface NextSuggestion {
  id: string
  eventId: string
  targetId: string
  label: string
  createdAt: number
  expiresAt: number
  state: 'offered' | 'confirmed' | 'dismissed' | 'failed' | 'invalid'
  choiceId?: string
}
export interface NextWorkbench {
  observedRecordId: number | null
  opened: { recordId: number; label: string; text: string } | null
  version: number
  settings: NextActionSettings
  sources: NextSourceOption[]
  contexts: NextContextOption[]
  events: Array<{
    id: string
    recordId: number
    label: string
    eventType: NextEventType
    habit: NextHabit
    targets: NextTarget[]
  }>
  suggestions: NextSuggestion[]
  tools: Array<{ id: string; label: string }>
  busy: boolean
  error: string | null
  observation: { enabled: boolean; appIds: string[] }
  capability?: {
    foreground: boolean
    input: boolean
    tab: boolean
    reason: string
  }
}
