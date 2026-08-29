import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DurableSessionIndex,
  sessionFileRevision,
  type IndexedPersistence,
  type SessionPersistenceSnapshot,
} from './session-index-store.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'omdsh-index-'))
  roots.push(root)
  const header: SessionHeader = {
    id: SessionId('session-one'), version: 0, createdAt: 10, cwd: '/tmp/project', delegationDepth: 0,
  }
  const path = join(root, 'project', header.id, 'session.jsonl')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, 'journal-one')
  const events: SessionEvent[] = [
    { seq: 0, time: 11, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'First question' }] } },
    { seq: 1, time: 12, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ] as SessionEvent[]
  const reads: number[] = []
  const persistence: IndexedPersistence = {
    locate: () => ({ kind: 'jsonl', path }),
    readStoredRevision: async () => (await sessionFileRevision(path)) as never,
    readFrom: async (_id, fromSeq) => {
      reads.push(fromSeq)
      return { meta: header, events: events.filter(event => event.seq >= fromSeq) }
    },
  }
  const fallback = vi.fn(async (): Promise<SessionPersistenceSnapshot[]> => [{
    header, revision: (await sessionFileRevision(path)) as never,
  }])
  return { root, header, path, events, reads, persistence, fallback }
}

describe('DurableSessionIndex', () => {
  it('persists a 0600 locator and reuses an exact-revision summary checkpoint', async () => {
    const item = await fixture()
    const first = new DurableSessionIndex(item.root, 'none', item.persistence)
    await expect(first.recent(item.fallback, 8)).resolves.toEqual([expect.objectContaining({
      id: 'session-one', title: 'First question', status: 'done', eventCount: 2,
    })])
    expect(item.reads).toEqual([0])

    const indexPath = join(item.root, '.omdsh-session-index-v1.json')
    expect((await stat(indexPath)).mode & 0o777).toBe(0o600)
    const second = new DurableSessionIndex(item.root, 'none', item.persistence)
    await expect(second.locate('session-one')).resolves.toBe(item.path)
    await second.recent(item.fallback, 8)
    expect(item.reads).toEqual([0])
    expect(item.fallback).toHaveBeenCalledTimes(1)
  })

  it('returns the complete cached catalog without reopening journals', async () => {
    const item = await fixture()
    const index = new DurableSessionIndex(item.root, 'none', item.persistence)
    await index.recent(item.fallback, 8)
    item.reads.splice(0)

    await expect(index.catalog(item.fallback)).resolves.toEqual([expect.objectContaining({
      id: 'session-one', title: 'First question', eventCount: 2,
    })])
    expect(item.reads).toEqual([])
    expect(item.fallback).toHaveBeenCalledOnce()
  })

  it('coalesces concurrent startup index load and rebuild work', async () => {
    const item = await fixture()
    const index = new DurableSessionIndex(item.root, 'none', item.persistence)
    await Promise.all([
      index.recent(item.fallback, 8),
      index.refreshViewportTail(item.header.id, item.fallback),
    ])
    expect(item.fallback).toHaveBeenCalledTimes(1)
  })

  it('folds only the suffix after the journal revision changes', async () => {
    const item = await fixture()
    const index = new DurableSessionIndex(item.root, 'none', item.persistence)
    await index.recent(item.fallback, 8)
    item.events.push({
      seq: 2, time: 13, type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Latest question' }] },
    } as SessionEvent)
    await writeFile(item.path, 'journal-two-is-longer')

    await expect(index.recent(item.fallback, 8)).resolves.toEqual([expect.objectContaining({
      title: 'First question', preview: 'Latest question', eventCount: 3,
    })])
    expect(item.reads).toEqual([0, 2])
  })

  it('publishes only a checksum-valid viewport tail bound to the exact journal revision', async () => {
    const item = await fixture()
    const first = new DurableSessionIndex(item.root, 'none', item.persistence)
    await first.refreshViewportTail(item.header.id, item.fallback)

    const reopened = new DurableSessionIndex(item.root, 'none', item.persistence)
    await expect(reopened.viewportTail(item.header.id)).resolves.toEqual({
      id: item.header.id,
      revision: await sessionFileRevision(item.path),
      checkpointSeq: 0,
      eventCount: 2,
      events: item.events,
    })

    await writeFile(item.path, 'changed-journal-revision')
    await expect(reopened.viewportTail(item.header.id)).resolves.toBeUndefined()
  })

  it('refreshes a large viewport from only the bounded event suffix', async () => {
    const item = await fixture()
    item.events.splice(0, item.events.length, ...Array.from({ length: 2_000 }, (_, seq) => ({
      seq,
      time: seq + 1,
      type: seq === 976 ? 'turn/start' : 'test/event',
      data: seq === 976 ? { turn: 1 } : {},
    }) as SessionEvent))
    const index = new DurableSessionIndex(item.root, 'none', item.persistence)
    await index.refreshViewportTail(item.header.id, item.fallback, undefined, 2_000)

    expect(item.reads).toEqual([976])
    await expect(index.viewportTail(item.header.id)).resolves.toMatchObject({
      checkpointSeq: 976,
      eventCount: 2_000,
    })
  })

  it('rejects corrupt and identity-mismatched viewport snapshots without scanning the journal', async () => {
    const item = await fixture()
    await new DurableSessionIndex(item.root, 'none', item.persistence)
      .refreshViewportTail(item.header.id, item.fallback)
    const indexPath = join(item.root, '.omdsh-session-index-v1.json')
    const stored = JSON.parse(await readFile(indexPath, 'utf8')) as {
      entries: Record<string, { viewport: { id: string; events: Array<{ data: unknown }> } }>
    }
    stored.entries[item.header.id]!.viewport.id = 'another-session'
    stored.entries[item.header.id]!.viewport.events[0]!.data = { corrupt: true }
    await writeFile(indexPath, JSON.stringify(stored), { mode: 0o600 })
    const readsBefore = item.reads.length

    await expect(new DurableSessionIndex(item.root, 'none', item.persistence).viewportTail(item.header.id))
      .resolves.toBeUndefined()
    expect(item.reads).toHaveLength(readsBefore)
  })

  it('does not checkpoint a viewport across a revision race', async () => {
    const item = await fixture()
    let revisions = 0
    const racing: IndexedPersistence = {
      ...item.persistence,
      readStoredRevision: async () => `${await sessionFileRevision(item.path)}:${revisions++}`,
    }
    const index = new DurableSessionIndex(item.root, 'none', racing)
    await index.refreshViewportTail(item.header.id, item.fallback)
    await expect(index.viewportTail(item.header.id)).resolves.toBeUndefined()
  })

  it('fails closed to a validated rebuild for corrupt or over-permissive index files', async () => {
    const item = await fixture()
    await new DurableSessionIndex(item.root, 'none', item.persistence).recent(item.fallback, 8)
    const indexPath = join(item.root, '.omdsh-session-index-v1.json')
    await writeFile(indexPath, '{broken')
    await chmod(indexPath, 0o644)

    const recovered = new DurableSessionIndex(item.root, 'none', item.persistence)
    await expect(recovered.recent(item.fallback, 8)).resolves.toHaveLength(1)
    expect(item.fallback).toHaveBeenCalledTimes(2)
    expect(JSON.parse(await readFile(indexPath, 'utf8'))).toMatchObject({ schema: 1 })
    expect((await stat(indexPath)).mode & 0o777).toBe(0o600)
  })
})
