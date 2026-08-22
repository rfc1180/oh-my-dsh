/** Read-only compatibility for Zstandard session logs written before Harness rc.8. */
import { readFile } from 'node:fs/promises'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'

const LegacyHeaderError = 'corrupt Zstandard session log: first frame is not exactly one header line'
const ZstdMagic = 4247762216
const ChecksumOptions = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

interface PersistencePrototype {
  readFirstZstdLine: (path: string, signal?: AbortSignal) => Promise<string | undefined>
  readZstdPrefix: (buffer: Buffer, signal?: AbortSignal) => Promise<{
    meta: unknown
    events: unknown[]
    tornMarker?: { truncateTo: number; recoveredEvents: unknown[] }
  }>
}

let installed = false

function isLegacyHeaderError(error: unknown): error is Error {
  return error instanceof Error && error.message === LegacyHeaderError
}

function firstZstdFrameEnd(buffer: Buffer): number | undefined {
  let offset = 0
  if (buffer.length - offset < 4 || buffer.readUInt32LE(offset) !== ZstdMagic) return undefined
  offset += 4
  if (offset === buffer.length) return undefined

  const descriptor = buffer.readUInt8(offset)
  offset += 1
  if ((descriptor & 24) !== 0) return undefined
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 32) !== 0
  const checksum = (descriptor & 4) !== 0
  const dictionaryFlag = descriptor & 3
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
  if (buffer.length - offset < remainingHeaderBytes) return undefined
  offset += remainingHeaderBytes

  for (;;) {
    if (buffer.length - offset < 3) return undefined
    const blockHeader = buffer.readUIntLE(offset, 3)
    offset += 3
    const lastBlock = (blockHeader & 1) !== 0
    const blockType = (blockHeader >>> 1) & 3
    if (blockType === 3) return undefined
    const blockSize = blockHeader >>> 3
    const payloadBytes = blockType === 1 ? 1 : blockSize
    if (buffer.length - offset < payloadBytes) return undefined
    offset += payloadBytes
    if (lastBlock) break
  }

  if (!checksum) return offset
  return buffer.length - offset < 4 ? undefined : offset + 4
}

function legacyFirstFrame(buffer: Buffer): { plaintext: Buffer; frameEnd: number; headerEnd: number } | undefined {
  const frameEnd = firstZstdFrameEnd(buffer)
  if (frameEnd === undefined) return undefined
  const plaintext = zstdDecompressSync(buffer.subarray(0, frameEnd))
  const headerEnd = plaintext.indexOf(10) + 1
  if (headerEnd <= 0 || headerEnd === plaintext.length || plaintext.at(-1) !== 10) return undefined
  return { plaintext, frameEnd, headerEnd }
}

function splitLegacyFirstFrame(buffer: Buffer): { buffer: Buffer; offsetDelta: number } | undefined {
  const legacy = legacyFirstFrame(buffer)
  if (legacy === undefined) return undefined
  const header = zstdCompressSync(legacy.plaintext.subarray(0, legacy.headerEnd), ChecksumOptions)
  const events = zstdCompressSync(legacy.plaintext.subarray(legacy.headerEnd), ChecksumOptions)
  return {
    buffer: Buffer.concat([header, events, buffer.subarray(legacy.frameEnd)]),
    offsetDelta: header.length + events.length - legacy.frameEnd,
  }
}

/** Keep rc.7 logs immutable and adapt their combined first frame only while rc.8 reads it. */
export function installRc7ZstdSessionCompatibility(): void {
  if (installed) return
  installed = true

  const prototype = JsonlSessionPersistence.prototype as unknown as PersistencePrototype
  const readFirstZstdLine = prototype.readFirstZstdLine
  const readZstdPrefix = prototype.readZstdPrefix

  prototype.readFirstZstdLine = async function (path, signal) {
    try {
      return await readFirstZstdLine.call(this, path, signal)
    } catch (error) {
      if (!isLegacyHeaderError(error)) throw error
      const legacy = legacyFirstFrame(await readFile(path, { signal }))
      signal?.throwIfAborted()
      if (legacy === undefined) throw error
      return legacy.plaintext.subarray(0, legacy.headerEnd - 1).toString('utf8')
    }
  }

  prototype.readZstdPrefix = async function (buffer, signal) {
    try {
      return await readZstdPrefix.call(this, buffer, signal)
    } catch (error) {
      if (!isLegacyHeaderError(error)) throw error
      const compatible = splitLegacyFirstFrame(buffer)
      signal?.throwIfAborted()
      if (compatible === undefined) throw error
      const prefix = await readZstdPrefix.call(this, compatible.buffer, signal)
      if (prefix.tornMarker === undefined) return prefix
      return {
        ...prefix,
        tornMarker: {
          ...prefix.tornMarker,
          truncateTo: prefix.tornMarker.truncateTo - compatible.offsetDelta,
        },
      }
    }
  }
}
