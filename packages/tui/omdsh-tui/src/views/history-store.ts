/** Durable JSONL input history shared across omdsh processes. */

import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs'
import { dirname } from 'node:path'

const READ_CHUNK_BYTES = 64 * 1024

/** One newest-first byte range, returned oldest-to-newest for compatibility. */
export interface HistoryPage {
  entries: string[]
  /** Older entries exist before this page. */
  hasMore: boolean
  /** Opaque byte cursor for the page immediately preceding this one. */
  previousCursor?: string
  /** Newer entries exist after this page. */
  hasNewer?: boolean
  /** Opaque byte cursor for the page immediately following this one. */
  nextCursor?: string
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
    if (pageLimit === 0) return { entries: [], hasMore: false, hasNewer: false }
    let fd: number | undefined
    try {
      fd = openSync(this.path, 'r')
      const size = fstatSync(fd).size
      let position = parseCursor(cursor, size)
      const pageEnd = position
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
      const hasNewer = pageEnd < size
      return {
        entries: newestFirst.reverse(),
        hasMore,
        ...(hasMore ? { previousCursor: String(previousOffset) } : {}),
        hasNewer,
        ...(hasNewer ? { nextCursor: String(pageEnd) } : {}),
      }
    } catch {
      return { entries: [], hasMore: false, hasNewer: false }
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd) } catch { /* best effort */ }
      }
    }
  }

  /** Read one page forwards from a cursor returned as `nextCursor`. */
  loadNextPage(cursor: string, limit = this.limit): HistoryPage {
    const pageLimit = Math.max(0, Math.floor(limit))
    if (pageLimit === 0) return { entries: [], hasMore: false, hasNewer: false }
    let fd: number | undefined
    try {
      fd = openSync(this.path, 'r')
      const size = fstatSync(fd).size
      const pageStart = parseCursor(cursor, size)
      let position = pageStart
      let pending = Buffer.alloc(0)
      const entries: string[] = []
      let nextOffset = pageStart

      while (position < size && entries.length < pageLimit) {
        const end = Math.min(size, position + READ_CHUNK_BYTES)
        const chunk = Buffer.allocUnsafe(end - position)
        const bytesRead = readSync(fd, chunk, 0, chunk.length, position)
        if (bytesRead === 0) break
        const data = pending.length === 0
          ? chunk.subarray(0, bytesRead)
          : Buffer.concat([pending, chunk.subarray(0, bytesRead)])
        const dataStart = position - pending.length
        let lineStart = 0
        for (let index = 0; index < data.length && entries.length < pageLimit; index += 1) {
          if (data[index] !== 0x0a) continue
          const parsed = parseHistoryLine(data.subarray(lineStart, index))
          nextOffset = dataStart + index + 1
          if (parsed !== undefined) entries.push(parsed)
          lineStart = index + 1
        }
        if (entries.length >= pageLimit) break
        pending = Buffer.from(data.subarray(lineStart))
        position = end
      }

      if (position >= size && entries.length < pageLimit && pending.length > 0) {
        const parsed = parseHistoryLine(pending)
        nextOffset = size
        if (parsed !== undefined) entries.push(parsed)
      }

      const hasMore = pageStart > 0
      const hasNewer = nextOffset < size
      return {
        entries,
        hasMore,
        ...(hasMore ? { previousCursor: String(pageStart) } : {}),
        hasNewer,
        ...(hasNewer ? { nextCursor: String(nextOffset) } : {}),
      }
    } catch {
      return { entries: [], hasMore: false, hasNewer: false }
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

/** Bounded exact navigator over durable history pages. */
export class HistoryCursorWindow {
  #page: HistoryPage
  #index = 0

  constructor(readonly store: HistoryStore) {
    this.#page = store.loadPage()
  }

  get index(): number { return this.#index }
  get entries(): readonly string[] { return this.#page.entries }
  get hasOlder(): boolean { return this.#page.hasMore }
  get newest(): string | undefined { return this.#page.entries.at(-1) }

  reset(): void {
    this.#page = this.store.loadPage()
    this.#index = 0
  }

  older(): string | undefined {
    if (this.#index < this.#page.entries.length) {
      this.#index += 1
      return this.#page.entries[this.#page.entries.length - this.#index]
    }
    while (this.#page.hasMore && this.#page.previousCursor !== undefined) {
      this.#page = this.store.loadPage(this.#page.previousCursor)
      if (this.#page.entries.length === 0) continue
      this.#index = 1
      return this.#page.entries.at(-1)
    }
    return undefined
  }

  newer(): string | undefined {
    if (this.#index === 0) return undefined
    if (this.#index > 1) {
      this.#index -= 1
      return this.#page.entries[this.#page.entries.length - this.#index]
    }
    while (this.#page.hasNewer && this.#page.nextCursor !== undefined) {
      this.#page = this.store.loadNextPage(this.#page.nextCursor)
      if (this.#page.entries.length === 0) continue
      this.#index = this.#page.entries.length
      return this.#page.entries[0]
    }
    this.#index = 0
    return undefined
  }
}
