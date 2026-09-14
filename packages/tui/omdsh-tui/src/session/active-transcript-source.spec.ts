import { describe, expect, it, vi } from 'vitest'
import type { TuiSessionManagerSource } from '../definition.ts'
import { activeTranscriptSource } from './active-transcript-source.ts'

function manager(): TuiSessionManagerSource {
  return {
    activeSessionId: 'session-current',
    list: async () => [],
    inspect: async () => { throw new Error('raw inspection must not be used') },
    historyPage: vi.fn(async request => ({
      schemaVersion: 1,
      sessionId: request.id,
      counts: { conversation: 1, prompts: 1, answers: 1, technical: 3 },
      interactions: [{
        id: 'turn:1:2',
        input: {
          kind: 'input',
          content: { format: 'markdown', text: 'Direct request' },
          ref: { seq: 2, time: 2, type: 'user/message' },
        },
        answer: {
          content: { format: 'markdown', text: 'Final answer' },
          confidence: 'explicit',
          ref: { seq: 8, time: 8, type: 'assistant/message', turn: 1, step: 2 },
        },
        outcome: { kind: 'completed', ref: { seq: 9, time: 9, type: 'turn/end' } },
        technicalTrace: [
          { seq: 3, time: 3, type: 'assistant/reasoning' },
          { seq: 4, time: 4, type: 'tool/call', name: 'bash' },
          { seq: 5, time: 5, type: 'tool/result', status: 'completed' },
        ],
      }, {
        id: 'legacy:10',
        input: {
          kind: 'input',
          content: { format: 'markdown', text: 'Legacy request' },
          ref: { seq: 10, time: 10, type: 'user/message' },
        },
        answer: {
          content: { format: 'markdown', text: 'Inferred, not final' },
          confidence: 'inferred',
          ref: { seq: 11, time: 11, type: 'assistant/message' },
        },
        outcome: { kind: 'unknown' },
        technicalTrace: [],
      }],
      previousCursor: 'opaque-cursor',
      hasMore: true,
    })),
  }
}

describe('active transcript source', () => {
  it('projects only direct user content and the final assistant answer', async () => {
    const source = manager()
    const active = activeTranscriptSource(source, () => true)

    await expect(active.request({
      method: 'session.history.page.v2',
      sessionId: 'session-current',
      limit: 20,
    })).resolves.toEqual({
      schemaVersion: 2,
      sessionId: 'session-current',
      interactions: [{
        id: 'turn:1:2',
        user: { format: 'markdown', text: 'Direct request' },
        assistant: { format: 'markdown', text: 'Final answer' },
        assistantAnchor: { turn: 1, step: 2 },
      }, {
        id: 'legacy:10',
        user: { format: 'markdown', text: 'Legacy request' },
      }],
      previousCursor: 'opaque-cursor',
      hasMore: true,
    })
    expect(source.historyPage).toHaveBeenCalledWith(
      { id: 'session-current', limit: 20 },
      undefined,
    )
  })

  it('rejects malformed, wrong-session, and retired requests before projection', async () => {
    const managerSource = manager()
    let current = true
    const source = activeTranscriptSource(managerSource, () => current)

    await expect(source.request({
      method: 'session.history.page.v2',
      sessionId: 'session-other',
    })).rejects.toThrow('only the current active session')
    await expect(source.request({
      method: 'session.history.page.v2',
      sessionId: 'session-current',
      cursor: '',
    })).rejects.toThrow('Malformed')
    current = false
    await expect(source.request({
      method: 'session.history.page.v2',
      sessionId: 'session-current',
    })).rejects.toThrow('no longer current')
    expect(managerSource.historyPage).not.toHaveBeenCalled()
  })
})
