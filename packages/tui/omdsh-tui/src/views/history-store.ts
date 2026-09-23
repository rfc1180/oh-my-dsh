/** Durable JSONL input history shared across omdsh processes. */

import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs'
import { dirname } from 'node:path'

const READ_CHUNK_BYTES = 64 * 1024

/** One newest-first byte range, returned oldest-to-newest for compatibility. */
export interface HistoryPage {
  entries: string[]
  hasMore: boolean
  /** Opaque byte cursor for the page immediately preceding this one. */
  previousCursor?: string
}

function parseCursor(cursor: string | undefined, size: number): number {
  if (cursor === undefined) return size
  const offset = Number(cursor)
  return Number.isSafeInteger(offset) ? Math.max(0, Math.min(size, offset)) : size
}

function parseHistoryLine(line: Buffer): string | undefined {
  if (line.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(line.toString('utf8'))
    return typeof parsed === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

export class HistoryStore {
  constructor(readonly path: string, readonly limit = 1000) {}

  /** Compatibility helper: load only the latest bounded page. */
  load(): string[] {
    return this.loadPage().entries
  }

  /** Read one page backwards without materializing the complete JSONL file. */
  loadPage(cursor?: string, limit = this.limit): HistoryPage {
    const pageLimit = Math.max(0, Math.floor(limit))
    if (pageLimit === 0) return { entries: [], hasMore: false }
    let fd: number | undefined
    try {
      fd = openSync(this.path, 'r')
      const size = fstatSync(fd).size
      let position = parseCursor(cursor, size)
      const newestFirst: string[] = []
      let suffix = Buffer.alloc(0)
      let previousOffset = position

      while (position > 0 && newestFirst.length < pageLimit) {
        const start = Math.max(0, position - READ_CHUNK_BYTES)
        const chunk = Buffer.allocUnsafe(position - start)
        const bytesRead = readSync(fd, chunk, 0, chunk.length, start)
        const data = bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead)
        let segmentEnd = data.length
        for (let index = data.length - 1; index >= 0 && newestFirst.length < pageLimit; index -= 1) {
          if (data[index] !== 0x0a) continue
          const part = data.subarray(index + 1, segmentEnd)
          const line = suffix.length === 0 ? part : Buffer.concat([part, suffix])
          const lineStart = start + index + 1
          const parsed = parseHistoryLine(line)
          if (parsed !== undefined) {
            newestFirst.push(parsed)
            previousOffset = lineStart
          }
          suffix = Buffer.alloc(0)
          segmentEnd = index
        }
        if (newestFirst.length >= pageLimit) break
        const prefix = data.subarray(0, segmentEnd)
        suffix = suffix.length === 0 ? Buffer.from(prefix) : Buffer.concat([prefix, suffix])
        position = start
      }

      if (position === 0 && newestFirst.length < pageLimit && suffix.length > 0) {
        const parsed = parseHistoryLine(suffix)
        if (parsed !== undefined) {
          newestFirst.push(parsed)
          previousOffset = 0
        }
      }

      const hasMore = newestFirst.length >= pageLimit && previousOffset > 0
      return {
        entries: newestFirst.reverse(),
        hasMore,
        ...(hasMore ? { previousCursor: String(previousOffset) } : {}),
      }
    } catch {
      return { entries: [], hasMore: false }
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd) } catch { /* best effort */ }
      }
    }
  }

  add(text: string): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      appendFileSync(this.path, JSON.stringify(text) + '\n', { encoding: 'utf8', mode: 0o600 })
    } catch { /* convenience state must not break input in a read-only home */ }
  }
}
