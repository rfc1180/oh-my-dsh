import { describe, expect, it, vi } from 'vitest'
import { createStartupTelemetry } from './startup-telemetry.ts'

describe('startup telemetry', () => {
  it('publishes ordered timing labels without accepting user data', () => {
    const events: unknown[] = []
    const writes: string[] = []
    const now = vi.fn()
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(12)
      .mockReturnValueOnce(19)
    const telemetry = createStartupTelemetry('resume', {
      now,
      publish: event => { events.push(event) },
      trace: true,
      write: line => { writes.push(line) },
    })

    telemetry.mark('targetAgentReady')
    telemetry.mark('inputReady')

    expect(events).toEqual([
      { milestone: 'targetAgentReady', mode: 'resume', elapsedMs: 2 },
      { milestone: 'inputReady', mode: 'resume', elapsedMs: 9 },
    ])
    expect(writes.join('')).not.toMatch(/session-|\/Users|prompt|error/u)
  })
})
