import { describe, expect, it } from 'vitest'
import {
  encodeHostTelemetryOsc,
  HOST_TELEMETRY_MAX_BYTES,
  HOST_TELEMETRY_OSC,
  hostTelemetryPayload,
} from './host-telemetry.ts'

describe('terminal host telemetry', () => {
  it('encodes a versioned UTF-8 metric projection in one OSC frame', () => {
    const payload = hostTelemetryPayload(['Cache 99%', 'Context 12% · 120K/1M'])
    const frame = encodeHostTelemetryOsc(payload)
    const prefix = `\u001B]${HOST_TELEMETRY_OSC};`

    expect(frame.startsWith(prefix)).toBe(true)
    expect(frame.endsWith('\u001B\\')).toBe(true)
    expect(JSON.parse(Buffer.from(frame.slice(prefix.length, -2), 'base64').toString('utf8'))).toEqual(payload)
  })

  it('uses an empty OSC payload to clear host chrome', () => {
    expect(encodeHostTelemetryOsc()).toBe(`\u001B]${HOST_TELEMETRY_OSC};\u001B\\`)
  })

  it('bounds host fields before encoding', () => {
    const groups = Array.from({ length: 13 }, (_, index) => `${index}:${'x'.repeat(300)}`)
    const payload = hostTelemetryPayload(groups)

    expect(payload.groups).toHaveLength(12)
    expect(payload.groups.every(group => group.length <= 240)).toBe(true)
  })

  it('keeps the decoded JSON within the host byte budget', () => {
    const payload = hostTelemetryPayload(Array.from({ length: 12 }, () => '界'.repeat(240)))

    expect(payload.groups.length).toBeLessThan(12)
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(HOST_TELEMETRY_MAX_BYTES)
  })
})
