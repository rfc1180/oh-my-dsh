/** Model-facing framing and durable provenance for additive steering notes. */

import { createUserMessage, type ContentBlock, type MessageSource, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export const STEERING_NOTE_PLUGIN = 'omdsh/steering-note'
export const STEERING_CONTINUATION_PLUGIN = 'omdsh/steering-continuation'

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

/** Create one hidden, one-shot prompt that returns control to the interrupted task. */
export function createSteeringContinuationMessage(): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: 'Resume the primary task now. The preceding continuation note was not a completion signal. If the task is complete, verify and report that; otherwise take the next concrete action.',
    }],
    source: {
      kind: 'plugin',
      plugin: STEERING_CONTINUATION_PLUGIN,
      form: 'notice',
      summary: 'Resume the task after a continuation note',
    },
  })
}

function pluginOf(event: SessionEvent): string | undefined {
  if (event.type !== 'user/message' || event.data.source.kind !== 'plugin') return undefined
  return event.data.source.plugin
}

/** Whether the current turn owes one extra step after a text-only steer reply. */
export function needsSteeringContinuation(events: readonly SessionEvent[], turn: number): boolean {
  const start = events.findLastIndex(event => event.type === 'turn/start' && event.data.turn === turn)
  if (start < 0) return false
  let latestSteer = -1
  let latestContinuation = -1
  let latestTool = -1
  for (let index = start + 1; index < events.length; index += 1) {
    const event = events[index]!
    if (event.type === 'turn/end' && event.data.turn === turn) break
    const plugin = pluginOf(event)
    if (plugin === STEERING_NOTE_PLUGIN) latestSteer = index
    if (plugin === STEERING_CONTINUATION_PLUGIN) latestContinuation = index
    if (event.type === 'tool/call') latestTool = index
  }
  return latestSteer > latestContinuation && latestSteer > latestTool
}

/** Recover only the human-authored text, never the host-owned model instruction. */
export function steeringNoteText(value: SteeringNoteValue): string | undefined {
  if (value.source.kind !== 'plugin' || value.source.plugin !== STEERING_NOTE_PLUGIN) return undefined
  const note = value.content[1]
  return note?.type === 'text' ? note.text : undefined
}
