/**
 * Optional terminal-host telemetry projection.
 *
 * The payload contains the complete metric set while status telemetry is
 * enabled. Supporting terminal hosts may surface it outside the fixed-width
 * TUI without enabling mouse mode.
 */

export const HOST_TELEMETRY_OSC = 16163
export const HOST_TELEMETRY_MAX_BYTES = 8 * 1024

export interface HostTelemetryPayload {
  version: 1
  source: 'omdsh'
  title: string
  groups: readonly string[]
}

export function hostTelemetryPayload(values: readonly string[]): HostTelemetryPayload {
  const groups: string[] = []
  for (const value of values.slice(0, 12)) {
    const group = value.slice(0, 240)
    const candidate: HostTelemetryPayload = {
      version: 1,
      source: 'omdsh',
      title: 'Session telemetry',
      groups: [...groups, group],
    }
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= HOST_TELEMETRY_MAX_BYTES) groups.push(group)
  }
  return {
    version: 1,
    source: 'omdsh',
    title: 'Session telemetry',
    groups,
  }
}

export function encodeHostTelemetryOsc(payload?: HostTelemetryPayload): string {
  const data = payload === undefined
    ? ''
    : Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  return `\u001B]${HOST_TELEMETRY_OSC};${data}\u001B\\`
}
