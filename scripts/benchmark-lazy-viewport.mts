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
import { replayEvents } from '../packages/tui/omdsh-tui/src/views/event-views.ts'

const EVENT_COUNT = 100_000
const RUNS = 7
const root = await mkdtemp(join(tmpdir(), 'omdsh-viewport-benchmark-'))
const header: SessionHeader = {
  id: 'session-large' as SessionId,
  version: 0,
  createdAt: 1,
  cwd: '/synthetic/project',
  delegationDepth: 0,
}
const path = join(root, 'project', header.id, 'session.jsonl')
const events: SessionEvent[] = Array.from({ length: EVENT_COUNT / 4 }, (_, turn) => [
  { seq: turn * 4, time: turn * 4, type: 'turn/start', data: { turn } },
  { seq: turn * 4 + 1, time: turn * 4 + 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `question ${turn}` }] } },
  { seq: turn * 4 + 2, time: turn * 4 + 2, type: 'assistant/message', data: { turn, step: 1, message: { content: [{ type: 'text', text: `answer ${turn}` }] } } },
  { seq: turn * 4 + 3, time: turn * 4 + 3, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
] as unknown as SessionEvent[]).flat()

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

async function measure(label: string, operation: () => Promise<void>): Promise<void> {
  await operation()
  const samples: number[] = []
  for (let run = 0; run < RUNS; run += 1) {
    const start = performance.now()
    await operation()
    samples.push(performance.now() - start)
  }
  console.log(`${label.padEnd(48)} ${median(samples).toFixed(2).padStart(10)} ms`)
}

try {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, 'synthetic durable journal')
  const persistence: IndexedPersistence = {
    locate: () => ({ kind: 'jsonl', path }),
    readStoredRevision: async () => await sessionFileRevision(path),
    readFrom: async (_id, fromSeq) => ({ meta: header, events: events.filter(event => event.seq >= fromSeq) }),
  }
  const fallback = async (): Promise<SessionPersistenceSnapshot[]> => [{
    header,
    revision: await sessionFileRevision(path),
  }]
  const prepared = new DurableSessionIndex(root, 'none', persistence)
  await prepared.refreshViewportTail(header.id, fallback)
  const warm = new DurableSessionIndex(root, 'none', persistence)

  console.log('oh-my-dsh lazy viewport benchmark')
  console.log(`Node ${process.version} · ${EVENT_COUNT.toLocaleString()} validated events · median of ${RUNS}`)
  await measure('First display: exact snapshot + tail replay', async () => {
    const snapshot = await warm.viewportTail(header.id)
    if (snapshot === undefined) throw new Error('viewport snapshot unavailable')
    replayEvents(snapshot.events)
  })
  await measure('Full hydration: complete read + transcript replay', async () => {
    const full = await persistence.readFrom(header.id, 0)
    replayEvents(full.events)
  })
  const snapshot = await warm.viewportTail(header.id)
  console.log(`${'snapshot events / full events'.padEnd(48)} ${String(snapshot?.events.length ?? 0).padStart(5)} / ${EVENT_COUNT}`)
} finally {
  await rm(root, { recursive: true, force: true })
}
