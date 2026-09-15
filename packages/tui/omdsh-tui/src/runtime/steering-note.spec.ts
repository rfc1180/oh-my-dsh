import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  createSteeringContinuationMessage,
  createSteeringNoteMessage,
  needsSteeringContinuation,
  STEERING_CONTINUATION_PLUGIN,
  STEERING_NOTE_PLUGIN,
  steeringNoteText,
} from './steering-note.ts'

function event(type: string, data: unknown, seq: number): SessionEvent {
  return { type, data, seq, time: seq } as unknown as SessionEvent
}

describe('steering notes', () => {
  it('keeps the human note separate from host-owned continuation guidance', () => {
    const message = createSteeringNoteMessage('also check the mobile layout')

    expect(message.source).toEqual({
      kind: 'plugin',
      plugin: STEERING_NOTE_PLUGIN,
      form: 'notice',
      summary: 'Continuation note to the current task',
    })
    expect(message.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Keep the current task as the primary objective.'),
    })
    expect(message.content[0]).toMatchObject({
      text: expect.stringContaining('do not switch silently'),
    })
    expect(steeringNoteText(message)).toBe('also check the mobile layout')
  })

  it('does not classify unrelated plugin context as a human steering note', () => {
    expect(steeringNoteText({
      source: { kind: 'plugin', plugin: 'other-plugin' },
      content: [{ type: 'text', text: 'context' }],
    })).toBeUndefined()
  })

  it('owes one continuation after a text-only steer and pays it exactly once', () => {
    const steer = createSteeringNoteMessage('status?')
    const continuation = createSteeringContinuationMessage()
    const events = [
      event('turn/start', { turn: 7 }, 1),
      event('user/message', steer, 2),
      event('assistant/message', { turn: 7, step: 2, message: { content: [] } }, 3),
    ]

    expect(needsSteeringContinuation(events, 7)).toBe(true)
    expect(continuation.source).toMatchObject({ kind: 'plugin', plugin: STEERING_CONTINUATION_PLUGIN })
    expect(needsSteeringContinuation([...events, event('user/message', continuation, 4)], 7)).toBe(false)
  })

  it('does not add a continuation when work already resumed after steer', () => {
    const events = [
      event('turn/start', { turn: 8 }, 1),
      event('user/message', createSteeringNoteMessage('also check tests'), 2),
      event('tool/call', { callId: 'call-1', name: 'test', arguments: {} }, 3),
    ]

    expect(needsSteeringContinuation(events, 8)).toBe(false)
  })
})
