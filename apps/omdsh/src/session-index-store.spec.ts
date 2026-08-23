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
