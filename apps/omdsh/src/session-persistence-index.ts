/** Product-owned acceleration hooks over the published rc.8 JSONL persistence backend. */
import { JsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import {
  DurableSessionIndex,
  type IndexedPersistence,
  type IndexedRecentSession,
  type IndexedViewportTail,
  type SessionPersistenceSnapshot,
} from './session-index-store.ts'

interface AcceleratedPrototype extends IndexedPersistence {
  config: { root: string; compression?: string }
  findLog: (id: string, signal?: AbortSignal) => Promise<string | undefined>
  list: (signal?: AbortSignal) => Promise<SessionHeader[]>
  listSnapshots: (signal?: AbortSignal) => Promise<SessionPersistenceSnapshot[]>
  omdshRecentSessions?: (limit: number, signal?: AbortSignal) => Promise<IndexedRecentSession[]>
  omdshSessionCatalog?: (signal?: AbortSignal) => Promise<IndexedRecentSession[]>
  omdshViewportTail?: (id: string, signal?: AbortSignal) => Promise<IndexedViewportTail | undefined>
  omdshRefreshViewportTail?: (id: string, knownNextSeq?: number, signal?: AbortSignal) => Promise<void>
}

let installed = false
const indexes = new WeakMap<object, DurableSessionIndex>()

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
  prototype.omdshViewportTail = function (id, signal) {
    return indexFor(this).viewportTail(id, signal)
  }
  prototype.omdshRefreshViewportTail = function (id, knownNextSeq, signal) {
    return indexFor(this).refreshViewportTail(id, candidate => listSnapshots.call(this, candidate), signal, knownNextSeq)
  }
}
