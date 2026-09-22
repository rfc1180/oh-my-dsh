import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  connectSharedCatalogChanges,
  type SharedCatalogChangeSink,
} from './shared-catalog-change-router.ts'

type Listener = () => void

function fixture() {
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
  const ctx = { on } as unknown as Context
  const emit = (name: string) => {
    for (const listener of listeners.get(name) ?? []) listener()
  }
  return { ctx, on, off, emit, listeners }
}

function sink(): SharedCatalogChangeSink {
  return {
    commandsChanged: vi.fn(),
    skillsChanged: vi.fn(),
    toolsChanged: vi.fn(),
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
}

describe('shared catalog change router', () => {
  it('installs exactly one listener per catalog and fans a coalesced burst out to every live slot', async () => {
    const shared = fixture()
    const first = sink()
    const second = sink()
    const offFirst = connectSharedCatalogChanges(shared.ctx, first)
    const offSecond = connectSharedCatalogChanges(shared.ctx, second)

    expect(shared.on.mock.calls.map(call => call[0])).toEqual([
      'commands/change',
      'skills/change',
      'tools/change',
    ])
    expect([...shared.listeners.values()].map(group => group.size)).toEqual([1, 1, 1])

    shared.emit('commands/change')
    shared.emit('commands/change')
    shared.emit('skills/change')
    shared.emit('tools/change')
    shared.emit('tools/change')
    expect(first.commandsChanged).not.toHaveBeenCalled()

    await flushMicrotasks()
    for (const target of [first, second]) {
      expect(target.commandsChanged).toHaveBeenCalledOnce()
      expect(target.skillsChanged).toHaveBeenCalledOnce()
      expect(target.toolsChanged).toHaveBeenCalledOnce()
    }

    offFirst()
    offSecond()
  })

  it('isolates sink errors, skips detached sinks, and removes listeners only after the last sink', async () => {
    const shared = fixture()
    const broken = sink()
    const live = sink()
    vi.mocked(broken.commandsChanged).mockImplementation(() => { throw new Error('broken slot') })
    vi.mocked(broken.toolsChanged).mockRejectedValue(new Error('broken async slot'))
    const offBroken = connectSharedCatalogChanges(shared.ctx, broken)
    const offLive = connectSharedCatalogChanges(shared.ctx, live)

    shared.emit('commands/change')
    shared.emit('tools/change')
    await flushMicrotasks()
    expect(live.commandsChanged).toHaveBeenCalledOnce()
    expect(live.toolsChanged).toHaveBeenCalledOnce()

    shared.emit('skills/change')
    offBroken()
    await flushMicrotasks()
    expect(broken.skillsChanged).not.toHaveBeenCalled()
    expect(live.skillsChanged).toHaveBeenCalledOnce()
    expect(shared.off).not.toHaveBeenCalled()

    offLive()
    offLive()
    expect(shared.off).toHaveBeenCalledTimes(3)
    expect([...shared.listeners.values()].every(group => group.size === 0)).toBe(true)

    const replacement = sink()
    const offReplacement = connectSharedCatalogChanges(shared.ctx, replacement)
    expect(shared.on).toHaveBeenCalledTimes(6)
    offReplacement()
  })
})
