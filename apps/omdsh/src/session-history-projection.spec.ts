import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  classifySessionV1,
  paginateSessionHistoryV1,
  projectSessionHistoryV1,
  SESSION_HISTORY_CLASSIFIER_VERSION,
} from './session-history-projection.ts'

function header(id = 'root', patch: Partial<SessionHeader> = {}): SessionHeader {
  return { id: SessionId(id), version: 0, createdAt: 1, delegationDepth: 0, ...patch }
}

function event(seq: number, type: string, data: unknown): SessionEvent {
  return { seq, time: seq + 10, type, data } as SessionEvent
}

function turnStart(seq: number, turn = 1): SessionEvent {
  return event(seq, 'turn/start', { turn })
}

function human(seq: number, text?: string, turn = 1, images = 0): SessionEvent {
  return event(seq, 'user/message', {
    id: `u-${seq}`, role: 'user', source: { kind: 'user' },
    content: [
      ...(text === undefined ? [] : [{ type: 'text', text }]),
      ...Array.from({ length: images }, () => ({ type: 'image', attachment: { id: 'secret-path-never-projected' } })),
    ],
    turn,
  })
}

function injected(seq: number, text: string): SessionEvent {
  return event(seq, 'user/message', {
    id: `p-${seq}`, role: 'user', source: { kind: 'plugin', plugin: 'test' }, content: [{ type: 'text', text }],
  })
}

function assistant(seq: number, text?: string, options: { turn?: number; step?: number; interrupted?: true; tool?: boolean } = {}): SessionEvent {
  const turn = options.turn ?? 1
  const step = options.step ?? 1
  return event(seq, 'assistant/message', {
    turn, step,
    message: {
      id: `a-${seq}`, role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' },
      content: options.tool === true
        ? [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"secret":true}' }]
        : [{ type: 'text', text: text ?? '' }],
    },
    ...(options.interrupted === true ? { interrupted: true } : {}),
  })
}

function turnEnd(seq: number, kind: string, turn = 1): SessionEvent {
  const reason = kind === 'aborted' ? { kind, reason: { kind: 'user' } } : { kind }
  return event(seq, 'turn/end', { turn, reason })
}

describe('Session History Projection v1 classification', () => {
  it('classifies a human root from local direct input only', () => {
    const classification = classifySessionV1(header(), [turnStart(0), injected(1, 'internal'), human(2, 'Hello')])
    expect(classification).toEqual(expect.objectContaining({
      audience: 'human', topology: 'root', provenance: 'native', bucket: 'human',
      confidence: 'high', classifierVersion: SESSION_HISTORY_CLASSIFIER_VERSION,
    }))
  })

  it('classifies an empty service root as internal instead of a human placeholder', () => {
    expect(classifySessionV1(header(), [])).toMatchObject({
      audience: 'internal', topology: 'root', provenance: 'native', bucket: 'internal',
    })
  })

  it('keeps subagent topology orthogonal to audience and routes it to the subagent bucket', () => {
    const classification = classifySessionV1(header('child', {
      origin: 'subagent', parentSession: SessionId('root'), delegationDepth: 1,
    }), [turnStart(0), human(1, 'child-local')])
    expect(classification).toMatchObject({ audience: 'internal', topology: 'subagent', bucket: 'subagent' })
  })

  it('does not treat inherited fork prompts as local human input', () => {
    const fork = header('fork', { parentSession: SessionId('root'), seedLength: 3 })
    const inherited = [turnStart(0), human(1, 'parent prompt'), turnEnd(2, 'completed')]
    expect(classifySessionV1(fork, inherited)).toMatchObject({ topology: 'fork', audience: 'internal', bucket: 'internal' })
    expect(classifySessionV1(fork, [...inherited, turnStart(3, 2), human(4, 'fork prompt', 2)]))
      .toMatchObject({ topology: 'fork', audience: 'human', bucket: 'human' })
  })
})

describe('Session History Projection v1 interactions', () => {
  it('publishes the last non-interrupted assistant message for a completed turn', () => {
    const projection = projectSessionHistoryV1(header(), [
      turnStart(0), human(1, 'Question'), assistant(2, 'Draft'), assistant(3, 'Final answer'), turnEnd(4, 'completed'),
    ])
    expect(projection.interactions).toEqual([expect.objectContaining({
      input: expect.objectContaining({ kind: 'input', content: { format: 'markdown', text: 'Question' } }),
      answer: expect.objectContaining({ confidence: 'explicit', content: { format: 'markdown', text: 'Final answer' } }),
      outcome: expect.objectContaining({ kind: 'completed' }),
    })])
  })

  it('keeps tool refs without exposing arguments or treating tool-only assistant messages as answers', () => {
    const projection = projectSessionHistoryV1(header(), [
      turnStart(0), human(1, 'Inspect'), assistant(2, undefined, { tool: true }),
      event(3, 'tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"token":"raw"}' }),
      event(4, 'tool/result', { turn: 1, step: 1, message: {}, meta: { raw: 'payload' } }),
      turnEnd(5, 'completed'),
    ])
    expect(projection.interactions[0]?.answer).toBeUndefined()
    expect(projection.interactions[0]?.technicalTrace).toEqual([
      expect.objectContaining({ type: 'tool/call', name: 'bash' }),
      expect.objectContaining({ type: 'tool/result', status: 'completed' }),
    ])
    expect(JSON.stringify(projection)).not.toContain('token')
    expect(JSON.stringify(projection)).not.toContain('payload')
  })

  it('does not publish an interrupted prefix as a final answer', () => {
    const projection = projectSessionHistoryV1(header(), [
      turnStart(0), human(1, 'Question'), assistant(2, 'partial', { interrupted: true }), turnEnd(3, 'aborted'),
    ])
    expect(projection.interactions[0]).toMatchObject({ outcome: { kind: 'interrupted' } })
    expect(projection.interactions[0]?.answer).toBeUndefined()
  })

  it('collapses duplicate delivery of the same direct input within one turn', () => {
    const projection = projectSessionHistoryV1(header(), [
      turnStart(0), human(1, 'Same prompt'), human(2, 'Same prompt'), assistant(3, 'Answer'), turnEnd(4, 'completed'),
    ])
    expect(projection.interactions).toHaveLength(1)
    expect(projection.interactions[0]).toMatchObject({
      input: { kind: 'input', content: { format: 'markdown', text: 'Same prompt' } },
      answer: { content: { format: 'markdown', text: 'Answer' } },
    })
  })

  it('keeps repeated text from different turns as separate interactions', () => {
    const projection = projectSessionHistoryV1(header(), [
      turnStart(0), human(1, 'Continue'), turnEnd(2, 'completed'),
      turnStart(3, 2), human(4, 'Continue', 2), turnEnd(5, 'completed', 2),
    ])
    expect(projection.interactions).toHaveLength(2)
  })

  it('infers a legacy answer only before the next direct human input', () => {
    const projection = projectSessionHistoryV1(header(), [
      human(0, 'First'), assistant(1, 'First answer'), injected(2, 'status'), human(3, 'Second'), assistant(4, 'Second answer'),
    ])
    expect(projection.classification).toMatchObject({ provenance: 'legacy', bucket: 'legacy' })
    expect(projection.interactions.map(row => row.answer)).toEqual([
      expect.objectContaining({ confidence: 'inferred', content: expect.objectContaining({ text: 'First answer' }) }),
      undefined,
    ])
  })

  it('represents an image-only prompt without leaking its attachment reference', () => {
    const projection = projectSessionHistoryV1(header(), [turnStart(0), human(1, undefined, 1, 1), turnEnd(2, 'completed')])
    expect(projection.title).toBe('Image')
    expect(projection.interactions[0]?.input.content).toEqual({ format: 'markdown', imageCount: 1 })
    expect(JSON.stringify(projection)).not.toContain('secret-path')
  })
})

describe('Session History Projection v1 pagination', () => {
  it('uses a stable exclusive cursor with an id tie-breaker', () => {
    const projections = ['c', 'a', 'b'].map(id => projectSessionHistoryV1(header(id), [turnStart(0), human(1, id), turnEnd(2, 'completed')]))
    const first = paginateSessionHistoryV1(projections, { limit: 2, bucket: 'human' })
    const second = paginateSessionHistoryV1(projections, { limit: 2, bucket: 'human', cursor: first.nextCursor })
    expect(first.items.map(item => item.sessionId)).toEqual(['a', 'b'])
    expect(second.items.map(item => item.sessionId)).toEqual(['c'])
    expect(second.nextCursor).toBeUndefined()
  })
})
