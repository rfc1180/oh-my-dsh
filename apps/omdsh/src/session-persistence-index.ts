/** Product-owned acceleration hooks over the published rc.8 JSONL persistence backend. */
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { projectSessionHistoryV1, type SessionHistoryProjectionV1 } from './session-history-projection.ts'
import {
  DurableSessionIndex,
  type IndexedPersistence,
  type IndexedRecentSession,
  type IndexedSemanticCatalog,
  type IndexedViewportTail,
  type SessionPersistenceSnapshot,
} from './session-index-store.ts'

interface AcceleratedPrototype extends IndexedPersistence {
  config: { root: string; compression?: string }
  findLog: (id: string, signal?: AbortSignal) => Promise<string | undefined>
  list: (signal?: AbortSignal) => Promise<SessionHeader[]>
  inspect: (id: string, signal?: AbortSignal) => Promise<{ meta: SessionHeader; events: SessionEvent[] }>
  listSnapshots: (signal?: AbortSignal) => Promise<SessionPersistenceSnapshot[]>
  omdshRecentSessions?: (limit: number, signal?: AbortSignal) => Promise<IndexedRecentSession[]>
  omdshSessionCatalog?: (signal?: AbortSignal) => Promise<IndexedRecentSession[]>
  omdshSemanticSessionCatalog?: (signal?: AbortSignal) => Promise<IndexedSemanticCatalog>
  omdshHydrateSessionCatalog?: (signal?: AbortSignal) => Promise<IndexedRecentSession[]>
  omdshViewportTail?: (id: string, signal?: AbortSignal) => Promise<IndexedViewportTail | undefined>
  omdshRefreshViewportTail?: (id: string, knownNextSeq?: number, signal?: AbortSignal) => Promise<void>
  /** Versioned semantic DTO source for non-TypeScript production consumers. */
  omdshProjectSessionHistory?: (id: string, signal?: AbortSignal) => Promise<SessionHistoryProjectionV1>
}

let installed = false
const indexes = new WeakMap<object, DurableSessionIndex>()
const historyProjections = new WeakMap<object, Map<string, {
  readonly revision: string
  readonly projection: SessionHistoryProjectionV1
}>>()

interface HistoryProjectionPersistence {
  readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<string | undefined>
  inspect(id: string, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }>
}

/** Project once per exact durable revision and reject a journal race. */
export async function projectSessionHistoryAtRevision(
  persistence: HistoryProjectionPersistence,
  id: string,
  signal?: AbortSignal,
): Promise<SessionHistoryProjectionV1> {
  signal?.throwIfAborted()
  const before = await persistence.readStoredRevision(SessionId(id), signal)
  const cache = historyProjections.get(persistence) ?? new Map()
  historyProjections.set(persistence, cache)
  const cached = cache.get(id)
  if (before !== undefined && cached?.revision === String(before)) return cached.projection
  const inspected = await persistence.inspect(id, signal)
  signal?.throwIfAborted()
  const after = await persistence.readStoredRevision(SessionId(id), signal)
  if (before !== after) throw new Error(`session "${id}" changed during history projection`)
  const projection = projectSessionHistoryV1(inspected.meta, inspected.events)
  if (after !== undefined) cache.set(id, { revision: String(after), projection })
  return projection
}

function indexFor(persistence: AcceleratedPrototype): DurableSessionIndex {
  let index = indexes.get(persistence)
  if (index === undefined) {
    index = new DurableSessionIndex(persistence.config.root, persistence.config.compression ?? 'zstd', persistence)
    indexes.set(persistence, index)
  }
  return index
}

/** Install optional read-model hooks without changing Harness validation, repair, or resume. */
export function installSessionPersistenceIndex(): void {
  if (installed) return
  installed = true
  const prototype = JsonlSessionPersistence.prototype as unknown as AcceleratedPrototype
  const findLog = prototype.findLog
  const listSnapshots = prototype.listSnapshots

  prototype.findLog = async function (id, signal) {
    return await indexFor(this).locate(id, signal) ?? findLog.call(this, id, signal)
  }
  prototype.listSnapshots = function (signal) {
    return indexFor(this).listSnapshots(candidate => listSnapshots.call(this, candidate), signal)
  }
  prototype.list = async function (signal) {
    return (await this.listSnapshots(signal)).map(snapshot => snapshot.header)
  }
  prototype.omdshRecentSessions = function (limit, signal) {
    return indexFor(this).recent(candidate => listSnapshots.call(this, candidate), limit, signal)
  }
  prototype.omdshSessionCatalog = function (signal) {
    return indexFor(this).catalog(candidate => listSnapshots.call(this, candidate), signal)
  }
  prototype.omdshSemanticSessionCatalog = function (signal) {
    return indexFor(this).semanticCatalog(candidate => listSnapshots.call(this, candidate), signal)
  }
  prototype.omdshHydrateSessionCatalog = function (signal) {
    return indexFor(this).recent(candidate => listSnapshots.call(this, candidate), Number.MAX_SAFE_INTEGER, signal)
  }
  prototype.omdshViewportTail = function (id, signal) {
    return indexFor(this).viewportTail(id, signal)
  }
  prototype.omdshRefreshViewportTail = function (id, knownNextSeq, signal) {
    return indexFor(this).refreshViewportTail(id, candidate => listSnapshots.call(this, candidate), signal, knownNextSeq)
  }
  prototype.omdshProjectSessionHistory = async function (id, signal) {
    return projectSessionHistoryAtRevision(this, id, signal)
  }
}
