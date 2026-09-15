import { describe, expect, it } from 'vitest'
import { createSteeringNoteMessage, STEERING_NOTE_PLUGIN, steeringNoteText } from './steering-note.ts'

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
})
