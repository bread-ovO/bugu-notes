import { nextActionWireSchema, taskChatOutputSchema, taskExtractionSchema } from '@memo/contracts'

/** Fail closed instead of treating unknown internal purposes as task extraction. */
export function modelPurposeSchema(purpose: unknown): object {
  if (purpose === undefined) return taskExtractionSchema
  if (purpose === 'task-chat') return taskChatOutputSchema
  if (purpose === 'next-action') return nextActionWireSchema
  throw Error('MODEL_INVALID_PURPOSE')
}
