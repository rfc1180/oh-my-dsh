import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createToolPresentationBridge } from './tool-presentation.ts'

function toolCall(seq: number, callId: string, name = 'owned-tool', args = '{}'): SessionEvent {
  return {
    type: 'tool/call', seq, time: seq, surfaceOp: 'append',
    data: { turn: 1, step: 1, callId, name, arguments: args },
  } as unknown as SessionEvent
}

function toolResult(seq: number, callId: string): SessionEvent {
  return {
    type: 'tool/result', seq, time: seq, surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `m${seq}`, role: 'user', source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: `raw ${seq}` }] }],
      },
    },
  } as unknown as SessionEvent
}

describe('ToolPresentationBridge', () => {
  it('uses the active scoped ToolDefinition for live calls and durable replay', () => {
    const call = {
      type: 'tool/call', seq: 1, time: 1, surfaceOp: 'append',
      data: { turn: 1, step: 1, callId: 'c1', name: 'owned-tool', arguments: '{"path":"a.ts"}' },
    } as unknown as SessionEvent
    const result = {
      type: 'tool/result', seq: 2, time: 2, surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'm1', role: 'user', source: { kind: 'tool', callId: 'c1' },
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'raw' }] }],
        },
        meta: { lines: 1 },
      },
    } as unknown as SessionEvent
    const agent = { session: { events: [call, result] } } as unknown as Agent
    const presentCall = vi.fn(() => ({ card: 'generic' as const, title: 'Read a.ts', kind: 'read' as const }))
    const presentResult = vi.fn(() => ({
      card: 'read' as const,
      path: 'a.ts',
      offset: 1,
      totalLines: 1,
      lines: [{ number: 1, text: 'hello' }],
    }))
    const get = vi.fn(() => ({ presentCall, presentResult }))
    const bridge = createToolPresentationBridge({ tools: { get } } as unknown as Context)

    expect(bridge.event(agent, call)).toEqual({ call: { card: 'generic', title: 'Read a.ts', kind: 'read' } })
    expect(bridge.event(agent, result)).toEqual({
      call: { card: 'generic', title: 'Read a.ts', kind: 'read' },
      result: { card: 'read', path: 'a.ts', offset: 1, totalLines: 1, lines: [{ number: 1, text: 'hello' }] },
    })
    expect(presentCall).toHaveBeenCalledWith({ path: 'a.ts' })
    expect(presentResult).toHaveBeenCalledWith({ path: 'a.ts' }, {
      content: [{ type: 'text', text: 'raw' }],
      isError: false,
      meta: { lines: 1 },
    })
    expect(bridge.session(agent, [call, result]).get(2)?.result).toMatchObject({ card: 'read', path: 'a.ts' })
    expect(get).toHaveBeenCalledWith('owned-tool', agent)
  })

  it('resolves a bounded-tail result from the authoritative session history', () => {
    const call = toolCall(1, 'before-tail', 'read', '{"path":"before.ts"}')
    const result = toolResult(50, 'before-tail')
    const agent = { session: { events: [call, result] } } as unknown as Agent
    const bridge = createToolPresentationBridge({
      tools: {
        get: () => ({
          presentCall: (args: unknown) => ({ card: 'generic' as const, title: String((args as { path: string }).path) }),
          presentResult: () => ({ card: 'generic' as const, title: 'done' }),
        }),
      },
    } as unknown as Context)

    expect(bridge.session(agent, [result])).toEqual(new Map([
      [50, { call: { card: 'generic', title: 'before.ts' }, result: { card: 'generic', title: 'done' } }],
    ]))
  })

  it('indexes authoritative calls once and caches definitions across many results', () => {
    const call = toolCall(1, 'shared', 'shared-tool')
    const results = Array.from({ length: 200 }, (_, index) => toolResult(index + 2, 'shared'))
    let indexedEventReads = 0
    const authoritativeEvents = new Proxy([call, ...results], {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) indexedEventReads += 1
        return Reflect.get(target, property, receiver)
      },
    })
    const agent = { session: { events: authoritativeEvents } } as unknown as Agent
    const get = vi.fn(() => ({
      presentResult: () => ({ card: 'generic' as const, title: 'done' }),
    }))
    const bridge = createToolPresentationBridge({ tools: { get } } as unknown as Context)

    const presentations = bridge.session(agent, results)

    expect(presentations.size).toBe(results.length)
    expect([...presentations.keys()]).toEqual(results.map(event => event.seq))
    expect(get).toHaveBeenCalledTimes(1)
    expect(indexedEventReads).toBeLessThanOrEqual(authoritativeEvents.length)
  })

  it('skips missing callIds and uses the latest authoritative duplicate callId', () => {
    const oldCall = toolCall(1, 'duplicate', 'old-tool')
    const newCall = toolCall(2, 'duplicate', 'new-tool')
    const duplicateResult = toolResult(3, 'duplicate')
    const missingResult = toolResult(4, 'missing')
    const agent = { session: { events: [oldCall, newCall, duplicateResult, missingResult] } } as unknown as Agent
    const get = vi.fn((name: string) => ({
      presentCall: () => ({ card: 'generic' as const, title: name }),
    }))
    const bridge = createToolPresentationBridge({ tools: { get } } as unknown as Context)

    expect(bridge.session(agent, [duplicateResult, missingResult])).toEqual(new Map([
      [3, { call: { card: 'generic', title: 'new-tool' } }],
    ]))
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('new-tool', agent)
  })

  it('isolates throwing call and result presenters during replay', () => {
    const resultOnlyCall = toolCall(1, 'result-only', 'result-only')
    const callOnlyCall = toolCall(2, 'call-only', 'call-only')
    const resultOnly = toolResult(3, 'result-only')
    const callOnly = toolResult(4, 'call-only')
    const agent = { session: { events: [resultOnlyCall, callOnlyCall, resultOnly, callOnly] } } as unknown as Agent
    const bridge = createToolPresentationBridge({
      tools: {
        get: (name: string) => name === 'result-only'
          ? {
              presentCall: () => { throw new Error('broken call') },
              presentResult: () => ({ card: 'generic' as const, title: 'result survived' }),
            }
          : {
              presentCall: () => ({ card: 'generic' as const, title: 'call survived' }),
              presentResult: () => { throw new Error('broken result') },
            },
      },
    } as unknown as Context)

    expect(bridge.session(agent, [resultOnly, callOnly])).toEqual(new Map([
      [3, { result: { card: 'generic', title: 'result survived' } }],
      [4, { call: { card: 'generic', title: 'call survived' } }],
    ]))
  })

  it('falls back safely when a tool has no presenter or a presenter throws', () => {
    const event = {
      type: 'tool/call', seq: 1, time: 1, surfaceOp: 'append',
      data: { turn: 1, step: 1, callId: 'c1', name: 'unknown', arguments: '{}' },
    } as unknown as SessionEvent
    const agent = { session: { events: [event] } } as unknown as Agent
    const missing = createToolPresentationBridge({ tools: { get: () => undefined } } as unknown as Context)
    const broken = createToolPresentationBridge({
      tools: { get: () => ({ presentCall: () => { throw new Error('broken') } }) },
    } as unknown as Context)

    expect(missing.event(agent, event)).toBeUndefined()
    expect(broken.event(agent, event)).toBeUndefined()
  })
})
