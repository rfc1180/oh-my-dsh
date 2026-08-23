/** Privacy-safe process startup milestones for diagnostics and benchmarks. */

import { channel } from 'node:diagnostics_channel'
import { performance } from 'node:perf_hooks'

export const STARTUP_DIAGNOSTICS_CHANNEL = 'omdsh.startup'

export const STARTUP_MILESTONES = [
  'loaderReady',
  'sessionStart',
  'targetAgentReady',
  'targetFrame',
  'inputReady',
  'recentReady',
  'modelReady',
  'skillsReady',
] as const

export type StartupMilestone = (typeof STARTUP_MILESTONES)[number]
export type StartupMode = 'new' | 'resume'

/** Contains timing and lifecycle labels only: never session ids, paths, prompts, or errors. */
export interface StartupTelemetryEvent {
  milestone: StartupMilestone
  mode: StartupMode
  elapsedMs: number
}

export interface StartupTelemetry {
  mark(milestone: StartupMilestone): void
}

/** Publish startup timing through diagnostics_channel, with opt-in JSON stderr tracing. */
export function createStartupTelemetry(
  mode: StartupMode,
  options: {
    now?: () => number
    publish?: (event: StartupTelemetryEvent) => void
    trace?: boolean
    write?: (line: string) => void
  } = {},
): StartupTelemetry {
  const now = options.now ?? (() => performance.now())
  const startedAt = now()
  const publish = options.publish ?? ((event: StartupTelemetryEvent) => {
    channel(STARTUP_DIAGNOSTICS_CHANNEL).publish(event)
  })
  const trace = options.trace ?? process.env.OMDSH_STARTUP_TRACE === '1'
  const write = options.write ?? ((line: string) => { process.stderr.write(line) })
  return {
    mark(milestone) {
      const event: StartupTelemetryEvent = {
        milestone,
        mode,
        elapsedMs: Math.max(0, now() - startedAt),
      }
      publish(event)
      if (trace) write(`[omdsh-startup] ${JSON.stringify(event)}\n`)
    },
  }
}
