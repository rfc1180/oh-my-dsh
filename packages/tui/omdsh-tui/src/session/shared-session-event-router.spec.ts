import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  connectSharedSessionEvents,
  type SharedSessionEventSink,
} from './shared-session-event-router.ts'

type Listener = (...args: never[]) => void

function session(id: string, parentSession?: string): Session {
  return {
    id: SessionId(id),
    header: {
      id: SessionId(id),
      createdAt: 1,
      ...(parentSession === undefined ? {} : { parentSession: SessionId(parentSession) }),
    },
    events: [],
  } as unknown as Session
}

function sink(): SharedSessionEventSink {
  return {
    agentStatus: vi.fn(),
    sessionCreated: vi.fn(),
    sessionDisposed: vi.fn(),
    sessionEvent: vi.fn(),
  }
}

function sharedContext(sessions: readonly Session[]) {
  const listeners = new Map<string, Set<Listener>>()
  const off = vi.fn()
  const on = vi.fn((name: string, listener: Listener) => {
    let group = listeners.get(name)
    if (group === undefined) {
      group = new Set()
      listeners.set(name, group)
    }
    group.add(listener)
    return () => {
      group?.delete(listener)
      off(name)
    }
  })
  const sessionMap = new Map(sessions.map(value => [value.id, value]))
  const ctx = {
    on,
    get: (name: string) => name === 'sessions'
      ? { get: (id: SessionId) => sessionMap.get(id) }
      : undefined,
  } as unknown as Context
  const emit = (name: string, ...args: unknown[]) => {
    for (const listener of listeners.get(name) ?? []) listener(...args as never[])
  }
  return { ctx, on, off, emit }
}

const titleEvent = {
  type: 'session/title',
  seq: 0,
  time: 1,
  data: { title: 'title' },
} as SessionEvent

describe('shared session event router', () => {
  it('installs one listener set and routes roots and descendants only to their owning runtime', () => {
    const rootA = session('root-a')
    const childA = session('child-a', 'root-a')
    const grandchildA = session('grandchild-a', 'child-a')
    const rootB = session('root-b')
    const childB = session('child-b', 'root-b')
    const fixture = sharedContext([rootA, childA, grandchildA, rootB, childB])
    const sinkA = sink()
    const sinkB = sink()
    const routeA = connectSharedSessionEvents(fixture.ctx, sinkA)
    const routeB = connectSharedSessionEvents(fixture.ctx, sinkB)

    expect(fixture.on).toHaveBeenCalledTimes(4)
    routeA.bindRoot(rootA.id)
    routeB.bindRoot(rootB.id)

    fixture.emit('session/created', childA)
    fixture.emit('session/event', childA, titleEvent)
    fixture.emit('agent/status', {
      agent: { id: grandchildA.id, session: grandchildA, status: 'running' } as Agent,
      status: 'running',
    })
    fixture.emit('session/disposed', childB)

    expect(sinkA.sessionCreated).toHaveBeenCalledWith(childA)
    expect(sinkA.sessionEvent).toHaveBeenCalledWith(childA, titleEvent)
    expect(sinkA.agentStatus).toHaveBeenCalledOnce()
    expect(sinkA.sessionDisposed).not.toHaveBeenCalled()
    expect(sinkB.sessionCreated).not.toHaveBeenCalled()
    expect(sinkB.sessionEvent).not.toHaveBeenCalled()
    expect(sinkB.agentStatus).not.toHaveBeenCalled()
    expect(sinkB.sessionDisposed).toHaveBeenCalledWith(childB)

    routeA.dispose()
    routeB.dispose()
    expect(fixture.off).toHaveBeenCalledTimes(4)
  })

  it('broadcasts unknown lineage and drops cached descendants when a runtime switches roots', () => {
    const rootA = session('root-a')
    const childA = session('child-a', 'root-a')
    const rootC = session('root-c')
    const unknown = session('unknown', 'missing-parent')
    const fixture = sharedContext([rootA, childA, rootC])
    const sinkA = sink()
    const sinkB = sink()
    const routeA = connectSharedSessionEvents(fixture.ctx, sinkA)
    const routeB = connectSharedSessionEvents(fixture.ctx, sinkB)
    routeA.bindRoot(rootA.id)

    fixture.emit('session/event', childA, titleEvent)
    expect(sinkA.sessionEvent).toHaveBeenCalledTimes(1)
    expect(sinkB.sessionEvent).not.toHaveBeenCalled()

    routeA.bindRoot(rootC.id)
    fixture.emit('session/event', unknown, titleEvent)
    expect(sinkA.sessionEvent).toHaveBeenCalledTimes(2)
    expect(sinkB.sessionEvent).toHaveBeenCalledTimes(1)

    fixture.emit('session/event', rootC, titleEvent)
    expect(sinkA.sessionEvent).toHaveBeenCalledTimes(3)
    expect(sinkB.sessionEvent).toHaveBeenCalledTimes(1)

    routeA.dispose()
    routeB.dispose()
  })

  it('rejects duplicate root ownership and detaches the global listeners after the last runtime', () => {
    const root = session('root')
    const fixture = sharedContext([root])
    const routeA = connectSharedSessionEvents(fixture.ctx, sink())
    const routeB = connectSharedSessionEvents(fixture.ctx, sink())
    routeA.bindRoot(root.id)

    expect(() => { routeB.bindRoot(root.id) }).toThrow('already bound')
    routeA.unbindRoot()
    expect(() => { routeB.bindRoot(root.id) }).not.toThrow()

    routeA.dispose()
    expect(fixture.off).not.toHaveBeenCalled()
    routeB.dispose()
    expect(fixture.off).toHaveBeenCalledTimes(4)
  })
})
