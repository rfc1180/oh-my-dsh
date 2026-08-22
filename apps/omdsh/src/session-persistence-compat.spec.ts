import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { describe, expect, it } from 'vitest'
import { installRc7ZstdSessionCompatibility } from './session-persistence-compat.ts'

interface CompatibilityReader {
  readFirstZstdLine: (path: string, signal?: AbortSignal) => Promise<string | undefined>
  readZstdPrefix: (buffer: Buffer, signal?: AbortSignal) => Promise<{
    meta: { id: string }
    events: Array<{ type: string; seq: number }>
    tornMarker?: { truncateTo: number }
  }>
}

function reader(): CompatibilityReader {
  return Object.create(JsonlSessionPersistence.prototype) as CompatibilityReader
}

const Header = {
  type: 'session',
  version: 0,
  id: 'session-legacy-zstd',
  createdAt: 1,
  cwd: '/tmp/legacy-zstd',
  delegationDepth: 0,
  agentPreset: 'standard',
}

const FirstEvent = {
  type: 'turn/start',
  seq: 0,
  time: 2,
  data: { turn: 0 },
}

describe('rc.7 Zstandard session compatibility', () => {
  it('lists and reads a log whose first frame also contains events', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omdsh-legacy-zstd-'))
    const path = join(root, 'session.jsonl.zstd')
    const firstLine = JSON.stringify(Header)
    const legacyLog = zstdCompressSync(`${firstLine}\n${JSON.stringify(FirstEvent)}\n`)
    writeFileSync(path, legacyLog)

    try {
      installRc7ZstdSessionCompatibility()
      const persistence = reader()
      await expect(persistence.readFirstZstdLine(path)).resolves.toBe(firstLine)
      await expect(persistence.readZstdPrefix(legacyLog)).resolves.toMatchObject({
        meta: { id: Header.id },
        events: [{ type: FirstEvent.type, seq: FirstEvent.seq }],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps repair offsets in the original legacy file', async () => {
    installRc7ZstdSessionCompatibility()
    const firstFrame = zstdCompressSync(`${JSON.stringify(Header)}\n${JSON.stringify(FirstEvent)}\n`)
    const nextEvent = { type: 'turn/end', seq: 1, time: 3, data: { turn: 0, reason: { kind: 'completed' } } }
    const incompleteFrame = zstdCompressSync(`${JSON.stringify(nextEvent)}\n`).subarray(0, -4)

    const prefix = await reader().readZstdPrefix(Buffer.concat([firstFrame, incompleteFrame]))

    expect(prefix.tornMarker?.truncateTo).toBe(firstFrame.length)
  })
})
