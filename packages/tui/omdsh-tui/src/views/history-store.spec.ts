import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HistoryCursorWindow, HistoryStore } from './history-store.ts'

describe('HistoryStore', () => {
  it('round-trips multiline prompts as JSONL', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'omdsh-history-')), 'history.jsonl')
    const store = new HistoryStore(path)
    store.add('one\ntwo')
    expect(store.load()).toEqual(['one\ntwo'])
    expect(readFileSync(path, 'utf8')).toContain('\\n')
  })

  it('pages backwards by byte cursor without losing entries older than 1000', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'omdsh-history-pages-')), 'history.jsonl')
    const expected = Array.from({ length: 2_507 }, (_, index) => `prompt ${index} λ`)
    writeFileSync(path, expected.map(entry => JSON.stringify(entry)).join('\n') + '\n')
    const store = new HistoryStore(path, 1_000)

    const pages: string[][] = []
    let cursor: string | undefined
    do {
      const page = store.loadPage(cursor)
      pages.unshift(page.entries)
      cursor = page.previousCursor
      if (!page.hasMore) break
    } while (true)

    expect(pages.flat()).toEqual(expected)
    expect(store.load()).toEqual(expected.slice(-1_000))
  })

  it('round-trips 7000 unique entries newest-to-oldest-to-newest without gaps or duplicates', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'omdsh-history-roundtrip-')), 'history.jsonl')
    const expected = Array.from({ length: 7_000 }, (_, index) => `unique-${String(index).padStart(4, '0')}`)
    writeFileSync(path, expected.map(entry => JSON.stringify(entry)).join('\n') + '\n')
    const window = new HistoryCursorWindow(new HistoryStore(path, 137))
    const older: string[] = []
    let value: string | undefined

    while ((value = window.older()) !== undefined) {
      older.push(value)
      expect(window.entries.length).toBeLessThanOrEqual(137)
    }
    expect(older).toEqual([...expected].reverse())

    const newer: string[] = []
    while (window.index > 0) {
      value = window.newer()
      if (value !== undefined) newer.push(value)
      expect(window.entries.length).toBeLessThanOrEqual(137)
    }
    expect(newer).toEqual(expected.slice(1))
    expect(window.index).toBe(0)
  })
})
