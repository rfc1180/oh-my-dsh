/** Model-facing framing and durable provenance for additive steering notes. */

import { createUserMessage, type ContentBlock, type MessageSource, type UserMessage } from '@deepseek-ai/dsh-llm'

export const STEERING_NOTE_PLUGIN = 'omdsh/steering-note'

const STEERING_NOTE_INSTRUCTION = [
  'Continuation note for the task already in progress.',
  'Keep the current task as the primary objective.',
  'Treat the next block as added context or a correction to the current task, not as a new task.',
  'If it is unrelated or would replace the main objective, ask whether the user intends to switch tasks; do not switch silently.',
  'This note does not cancel tool calls or other work already in progress.',
  '',
].join('\n')

interface SteeringNoteValue {
  readonly source: MessageSource
  readonly content: readonly ContentBlock[]
}

/** Create one user-role note whose producer provenance cannot grant direct-prompt lifecycle authority. */
export function createSteeringNoteMessage(note: string): UserMessage {
  return createUserMessage({
    content: [
      { type: 'text', text: STEERING_NOTE_INSTRUCTION },
      { type: 'text', text: note },
    ],
    source: {
      kind: 'plugin',
      plugin: STEERING_NOTE_PLUGIN,
      form: 'notice',
      summary: 'Continuation note to the current task',
    },
  })
}

/** Recover only the human-authored text, never the host-owned model instruction. */
export function steeringNoteText(value: SteeringNoteValue): string | undefined {
  if (value.source.kind !== 'plugin' || value.source.plugin !== STEERING_NOTE_PLUGIN) return undefined
  const note = value.content[1]
  return note?.type === 'text' ? note.text : undefined
}
