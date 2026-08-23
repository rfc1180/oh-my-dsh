import { channel } from 'node:diagnostics_channel'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { TuiService } from '../definition.ts'
import { run } from './runner.ts'
import { STARTUP_DIAGNOSTICS_CHANNEL, type StartupTelemetryEvent } from './startup-telemetry.ts'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('runner startup critical path', () => {
  it('opens the requested durable target and reaches input before optional hydration', async () => {
    const hydration = deferred()
    const observed: StartupTelemetryEvent[] = []
    const diagnostics = channel(STARTUP_DIAGNOSTICS_CHANNEL)
    const subscriber = (event: unknown) => { observed.push(event as StartupTelemetryEvent) }
    diagnostics.subscribe(subscriber)
    const calls: string[] = []
    const controller = {
      agent: undefined,
      start: vi.fn(async (resumeId, _signal, mark) => {
        calls.push(`start:${String(resumeId)}`)
        mark('targetAgentReady')
        calls.push('target-frame')
        mark('targetFrame')
        void hydration.promise.then(() => {
          mark('recentReady')
          mark('modelReady')
          mark('skillsReady')
        })
      }),
      interruptVisible: () => false,
      editLatestFollowup: async () => undefined,
    }
    const tui = {
      commandOutput: vi.fn(),
      onInterrupt: () => () => {},
      onQueueEdit: () => () => {},
      onRewind: () => () => {},
      readInput: vi.fn(async () => { calls.push('input-read'); return null }),
    } as unknown as TuiService
    const services: Record<string, unknown> = {
      loader: { await: async () => {} },
      omdshSession: controller,
      cmdlineArgs: { get: () => ['--resume', 'durable-target'] },
      appExit: vi.fn(),
    }
    const ctx = { get: (name: string) => services[name] } as unknown as Context

    try {
      await run(ctx, tui)
      expect(controller.start).toHaveBeenCalledTimes(1)
      expect(calls).toEqual(['start:durable-target', 'target-frame', 'input-read'])
      expect(observed.map(event => event.milestone)).toEqual([
        'loaderReady', 'sessionStart', 'targetAgentReady', 'targetFrame', 'inputReady',
      ])
      hydration.resolve()
      await hydration.promise
      await Promise.resolve()
      expect(observed.map(event => event.milestone)).toEqual([
        'loaderReady', 'sessionStart', 'targetAgentReady', 'targetFrame', 'inputReady',
        'recentReady', 'modelReady', 'skillsReady',
      ])
    } finally {
      diagnostics.unsubscribe(subscriber)
    }
  })
})
