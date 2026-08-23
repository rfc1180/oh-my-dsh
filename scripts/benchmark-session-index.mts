import { performance } from 'node:perf_hooks'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import {
  DurableSessionIndex,
  sessionFileRevision,
  type IndexedPersistence,
  type SessionPersistenceSnapshot,
} from '../apps/omdsh/src/session-index-store.ts'

const SESSION_COUNT = 10_000
const LARGE_EVENT_COUNT = 100_000
const root = await mkdtemp(join(tmpdir(), 'omdsh-index-benchmark-'))
const project = join(root, 'synthetic-project')
const headers: SessionHeader[] = []
const paths = new Map<string, string>()

async function measure<T>(label: string, operation: () => Promise<T>): Promise<T> {
  const start = performance.now()
  const result = await operation()
  console.log(`${label.padEnd(48)} ${(performance.now() - start).toFixed(2).padStart(10)} ms`)
  return result
}

try {
  console.log('oh-my-dsh session-index benchmark')
  console.log(`Node ${process.version} · ${SESSION_COUNT.toLocaleString()} sessions · ${LARGE_EVENT_COUNT.toLocaleString()} events`)
  for (let offset = 0; offset < SESSION_COUNT; offset += 250) {
    await Promise.all(Array.from({ length: Math.min(250, SESSION_COUNT - offset) }, async (_, delta) => {
      const number = offset + delta
      const header: SessionHeader = {
        id: `session-${number}` as SessionId, version: 0, createdAt: SESSION_COUNT - number,
        cwd: '/synthetic/project', delegationDepth: 0,
      }
      const path = join(project, header.id, 'session.jsonl')
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, String(number))
      headers.push(header)
      paths.set(header.id, path)
    }))
  }
  headers.sort((left, right) => right.createdAt - left.createdAt)
  const events: SessionEvent[] = Array.from({ length: LARGE_EVENT_COUNT }, (_, seq) => ({
    seq, time: seq + 1, type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: `message ${seq}` }] },
  } as SessionEvent))
  let suffixReads = 0
  const persistence: IndexedPersistence = {
    locate: header => ({ kind: 'jsonl', path: paths.get(header.id)! }),
    readStoredRevision: async id => (await sessionFileRevision(paths.get(id)!)) as never,
    readFrom: async (id, fromSeq) => {
      suffixReads += 1
      return { meta: headers.find(header => header.id === id)!, events: events.slice(fromSeq) }
    },
  }
  const fallback = async (): Promise<SessionPersistenceSnapshot[]> => Promise.all(headers.map(async header => ({
    header, revision: (await sessionFileRevision(paths.get(header.id)!)) as never,
  })))

  const cold = new DurableSessionIndex(root, 'none', persistence)
  await measure('Cold catalog + 100k-event summary checkpoint', () => cold.recent(fallback, 8))
  const warm = new DurableSessionIndex(root, 'none', persistence)
  await measure('Warm 10k catalog recent summaries (no inspect)', () => warm.recent(fallback, 8))
  await measure('10k indexed locator lookups', async () => {
    for (const header of headers) await warm.locate(header.id)
  })
  console.log(`physical suffix reads`.padEnd(48), String(suffixReads).padStart(10))
} finally {
  await rm(root, { recursive: true, force: true })
}
