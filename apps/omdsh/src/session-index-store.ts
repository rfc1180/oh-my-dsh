/** Durable omdsh read model for cheap session discovery over rc.8 persistence. */
import { createHash, randomUUID } from 'node:crypto'
import { chmod, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type {} from '@deepseek-ai/dsh-session-title'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'

export interface SessionPersistenceSnapshot {
  header: SessionHeader
  revision: string
}

const INDEX_SCHEMA = 1
const INDEX_FILENAME = '.omdsh-session-index-v1.json'
const VIEWPORT_SCHEMA = 1
// The viewport is the fast first paint: a suffix of the journal, taken from the end back,
// shown while the rest is still loading. Its byte budget is what the reader sees
// immediately, so it must cover a long conversation instead of a fraction of one — at the
// original 512 KiB an ordinary session arrived truncated and said so itself
// ("history truncated (7610 earlier events omitted)"). 8 MiB covers a long dialogue while
// keeping the first paint bounded; the event cap is a backstop for pathological journals
// with many tiny events, and it is far above what the byte budget admits in practice.
// Everything older than the window is loaded on demand without a bound, so the transcript
// is not limited by this number — only its first paint is.
const VIEWPORT_EVENT_LIMIT = 200_000
const VIEWPORT_BYTE_LIMIT = 8 * 1_024 * 1_024
const STATUS_VALUES = new Set(['done', 'failed', 'blocked', 'interrupted'])

export interface IndexedRecentSession {
  id: string
  title: string
  preview?: string
  cwd?: string
  createdAt: number
  updatedAt: number
  eventCount: number
  turns?: number
  status?: 'done' | 'failed' | 'blocked' | 'interrupted'
}

export interface IndexedSemanticSession extends IndexedRecentSession {
  scope: 'human' | 'internal' | 'subagent' | 'legacy'
  turns: number
  canResume: boolean
}

export interface IndexedSemanticCatalog {
  sessions: IndexedSemanticSession[]
  stale: boolean
}

interface SummaryProjection {
  firstMessage?: string
  lastMessage?: string
  title?: string
  status?: IndexedRecentSession['status']
  openTurn: boolean
  updatedAt: number
  eventCount: number
  turnCount?: number
  localHumanMessageCount?: number
  hasTurnLifecycle?: boolean
}

interface ProjectionCheckpoint {
  revision: string
  nextSeq: number
  projection: SummaryProjection
}

export interface IndexedViewportTail {
  readonly id: string
  readonly revision: string
  readonly checkpointSeq: number
  readonly eventCount: number
  readonly events: readonly SessionEvent[]
  /** The snapshot starts inside an older semantic boundary rather than at session start. */
  readonly partial?: boolean
  /** Exact sequence-prefix length omitted from this display-only snapshot. */
  readonly omittedEvents?: number
}

interface ViewportTailSnapshot extends IndexedViewportTail {
  schema: number
  generation: string
  digest: string
  events: SessionEvent[]
}

interface IndexEntry {
  header: SessionHeader
  path: string
  revision: string
  checkpoint?: ProjectionCheckpoint
  viewport?: ViewportTailSnapshot
}

interface PersistedIndex {
  schema: number
  generation: string
  projectDirectories: Record<string, string>
  entries: Record<string, IndexEntry>
}

export interface IndexedPersistence {
  locate(header: SessionHeader): { kind: string; path: string } | undefined
  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }>
  readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<string | undefined>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHeader(value: unknown): value is SessionHeader {
  if (!isObject(value)) return false
  return typeof value.id === 'string' && value.id !== ''
    && Number.isSafeInteger(value.version) && Number(value.version) >= 0
    && Number.isSafeInteger(value.createdAt) && Number(value.createdAt) >= 0
    && Number.isSafeInteger(value.delegationDepth) && Number(value.delegationDepth) >= 0
    && (value.cwd === undefined || typeof value.cwd === 'string')
    && (value.parentSession === undefined || typeof value.parentSession === 'string')
    && (value.seedLength === undefined || (Number.isSafeInteger(value.seedLength) && Number(value.seedLength) >= 0))
    && (value.origin === undefined || value.origin === 'subagent')
    && (value.agentPreset === undefined || typeof value.agentPreset === 'string')
}

function isProjection(value: unknown): value is SummaryProjection {
  if (!isObject(value)) return false
  return (value.firstMessage === undefined || typeof value.firstMessage === 'string')
    && (value.lastMessage === undefined || typeof value.lastMessage === 'string')
    && (value.title === undefined || typeof value.title === 'string')
    && (value.status === undefined || (typeof value.status === 'string' && STATUS_VALUES.has(value.status)))
    && typeof value.openTurn === 'boolean'
    && Number.isSafeInteger(value.updatedAt) && Number(value.updatedAt) >= 0
    && Number.isSafeInteger(value.eventCount) && Number(value.eventCount) >= 0
    && (value.turnCount === undefined || (Number.isSafeInteger(value.turnCount) && Number(value.turnCount) >= 0))
    && (value.localHumanMessageCount === undefined || (Number.isSafeInteger(value.localHumanMessageCount) && Number(value.localHumanMessageCount) >= 0))
    && (value.hasTurnLifecycle === undefined || typeof value.hasTurnLifecycle === 'boolean')
}

function isSnapshotEvent(value: unknown): value is SessionEvent {
  if (!isObject(value)) return false
  return typeof value.type === 'string' && value.type !== ''
    && Number.isSafeInteger(value.seq) && Number(value.seq) >= 0
    && Number.isSafeInteger(value.time) && Number(value.time) >= 0
    && isObject(value.data)
}

function viewportPayload(snapshot: Omit<ViewportTailSnapshot, 'digest'>): string {
  return JSON.stringify(snapshot)
}

function viewportDigest(snapshot: Omit<ViewportTailSnapshot, 'digest'>): string {
  return createHash('sha256').update(viewportPayload(snapshot)).digest('hex')
}

function viewportEventsWithinByteLimit(events: readonly unknown[]): boolean {
  return Buffer.byteLength(JSON.stringify(events), 'utf8') <= VIEWPORT_BYTE_LIMIT
}

function boundedViewportEvents(events: readonly SessionEvent[]): SessionEvent[] {
  let bytes = 2 // JSON array brackets
  let start = events.length
  while (start > 0 && events.length - start < VIEWPORT_EVENT_LIMIT) {
    const event = events[start - 1]
    if (event === undefined) break
    const eventBytes = Buffer.byteLength(JSON.stringify(event), 'utf8') + (start < events.length ? 1 : 0)
    if (bytes + eventBytes > VIEWPORT_BYTE_LIMIT) break
    bytes += eventBytes
    start -= 1
  }
  const bounded = events.slice(start)
  if (bounded.length === 0) return []

  // Prefer a replayable semantic boundary when one exists inside the bounded
  // suffix. A single event larger than the byte budget is not cached; durable
  // history remains authoritative and will be loaded normally.
  const boundary = bounded.findIndex(event => event.type === 'turn/start' || event.type === 'user/message')
  return structuredClone(boundary > 0 ? bounded.slice(boundary) : bounded)
}

function buildViewportTail(
  generation: string,
  id: string,
  revision: string,
  eventCount: number,
  events: readonly SessionEvent[],
): ViewportTailSnapshot | undefined {
  if (events.length === 0) return undefined
  const tail = boundedViewportEvents(events)
  const first = tail[0]
  if (first === undefined) return undefined
  const omittedEvents = Math.max(0, first.seq)
  const payload: Omit<ViewportTailSnapshot, 'digest'> = {
    schema: VIEWPORT_SCHEMA,
    generation,
    id,
    revision,
    checkpointSeq: first.seq,
    eventCount,
    events: tail,
    ...(omittedEvents === 0 ? {} : { partial: true, omittedEvents }),
  }
  return { ...payload, digest: viewportDigest(payload) }
}

function eventText(event: SessionEvent, localFromSeq: number): string | undefined {
  if (event.seq < localFromSeq || event.type !== 'user/message' || event.data.source.kind !== 'user') return undefined
  const text = event.data.content
    .filter((block): block is Extract<(typeof event.data.content)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .replace(/\s+/gu, ' ')
    .trim()
  if (text !== '') return text
  const images = event.data.content.filter(block => block.type === 'image').length
  return images === 0 ? undefined : images === 1 ? 'Image' : `${images} images`
}

function foldEvents(base: SummaryProjection | undefined, events: readonly SessionEvent[], localFromSeq: number): SummaryProjection {
  const projection: SummaryProjection = base === undefined
    ? {
        openTurn: false,
        updatedAt: 0,
        eventCount: 0,
        turnCount: 0,
        localHumanMessageCount: 0,
        hasTurnLifecycle: false,
      }
    : structuredClone(base)
  projection.turnCount ??= 0
  projection.localHumanMessageCount ??= 0
  projection.hasTurnLifecycle ??= false
  for (const event of events) {
    projection.eventCount += 1
    projection.updatedAt = Math.max(projection.updatedAt, event.time)
    const text = eventText(event, localFromSeq)
    if (text !== undefined) {
      projection.localHumanMessageCount += 1
      projection.firstMessage ??= text
      projection.lastMessage = text
    }
    if (event.type === 'session/title') projection.title = event.data.title
    if (event.type === 'turn/start') {
      projection.openTurn = true
      projection.hasTurnLifecycle = true
    }
    if (event.type === 'turn/end') {
      projection.openTurn = false
      projection.hasTurnLifecycle = true
      projection.turnCount += 1
      const reason = event.data.reason.kind
      projection.status = reason === 'completed' ? 'done'
        : reason === 'error' ? 'failed'
          : reason === 'blocked' || reason === 'max-tokens' ? 'blocked' : 'interrupted'
    }
  }
  return projection
}

function projectRecent(header: SessionHeader, projection: SummaryProjection): IndexedRecentSession | undefined {
  const first = projection.firstMessage
  if (first === undefined) return undefined
  const title = projection.title ?? first
  return {
    id: header.id,
    title,
    ...(projection.lastMessage === undefined || projection.lastMessage === title ? {} : { preview: projection.lastMessage }),
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    createdAt: header.createdAt,
    updatedAt: projection.updatedAt || header.createdAt,
    eventCount: projection.eventCount,
    turns: projection.turnCount ?? 0,
    ...(projection.openTurn ? { status: 'interrupted' as const }
      : projection.status === undefined ? {} : { status: projection.status }),
  }
}

function statRevision(identity: Awaited<ReturnType<typeof stat>>): string {
  const bigint = identity as unknown as { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }
  return [bigint.dev, bigint.ino, bigint.size, bigint.mtimeNs, bigint.ctimeNs].join(':')
}

/** Source-compatible copy of rc.8's opaque file revision, used only after bigint stat. */
export async function sessionFileRevision(path: string): Promise<string> {
  return statRevision(await stat(path, { bigint: true }) as never)
}

async function directoryRevision(path: string): Promise<string> {
  const identity = await stat(path, { bigint: true }) as unknown as { dev: bigint; ino: bigint; mtimeNs: bigint; ctimeNs: bigint }
  return [identity.dev, identity.ino, identity.mtimeNs, identity.ctimeNs].join(':')
}

/** Persistent catalog plus revision-bound recent-session projection checkpoints. */
export class DurableSessionIndex {
  readonly #root: string
  readonly #indexPath: string
  readonly #generation: string
  readonly #viewportGeneration: string
  readonly #persistence: IndexedPersistence
  #loaded: PersistedIndex | undefined
  #loadPromise: Promise<PersistedIndex | undefined> | undefined
  #currentPromise: Promise<PersistedIndex> | undefined
  #writeChain: Promise<void> = Promise.resolve()

  constructor(root: string, compression: string, persistence: IndexedPersistence) {
    this.#root = resolve(root)
    this.#indexPath = resolve(this.#root, INDEX_FILENAME)
    this.#generation = `omdsh-session-index:${INDEX_SCHEMA}:${this.#root}:${compression}`
    this.#viewportGeneration = `omdsh-viewport-tail:${VIEWPORT_SCHEMA}:${this.#root}:${compression}`
    this.#persistence = persistence
  }

  /** O(1) id lookup after one durable-index load; callers still validate the candidate through rc.8. */
  async locate(id: string, signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted()
    const index = await this.#load()
    const entry = index?.entries[id]
    if (entry === undefined) return undefined
    try {
      await stat(entry.path)
      signal?.throwIfAborted()
      return entry.path
    } catch {
      return undefined
    }
  }

  /** Cheap exact-revision catalog. Invalid or stale state rebuilds through the backend's validated scanner. */
  async listSnapshots(
    fallback: (signal?: AbortSignal) => Promise<SessionPersistenceSnapshot[]>,
    signal?: AbortSignal,
  ): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted()
    let index = await this.#load()
    if (index === undefined || !await this.#catalogCurrent(index, signal)) {
      index = await this.#rebuild(fallback, signal)
    }
    const snapshots: SessionPersistenceSnapshot[] = []
    try {
      for (const entry of Object.values(index.entries)) {
        signal?.throwIfAborted()
        const revision = await sessionFileRevision(entry.path)
        // Any changed artifact goes back through rc.8's bounded header scanner;
        // the sidecar never vouches for metadata after journal bytes change.
        if (revision !== entry.revision) {
          index = await this.#rebuild(fallback, signal)
          return Object.values(index.entries).map(candidate => ({
            header: structuredClone(candidate.header), revision: candidate.revision,
          }))
        }
        snapshots.push({ header: structuredClone(entry.header), revision })
      }
    } catch {
      index = await this.#rebuild(fallback, signal)
      return Object.values(index.entries).map(entry => ({
        header: structuredClone(entry.header),
        revision: entry.revision,
      }))
    }
    return snapshots
  }

  /** Read the last persisted human-session summaries without checking or scanning the session store. */
  async cachedRecent(limit: number, signal?: AbortSignal): Promise<IndexedRecentSession[]> {
    signal?.throwIfAborted()
    const index = await this.#load()
    if (index === undefined) return []
    const rows: IndexedRecentSession[] = []
    for (const entry of Object.values(index.entries)
      .filter(candidate => candidate.header.origin !== 'subagent')
      .sort((left, right) => right.header.createdAt - left.header.createdAt)) {
      signal?.throwIfAborted()
      if (entry.checkpoint === undefined) continue
      const projected = projectRecent(entry.header, entry.checkpoint.projection)
      if (projected !== undefined) rows.push(projected)
      if (rows.length >= limit) break
    }
    return rows
  }

  /** Read checkpoint-classified human sessions without opening journals or inventing placeholders. */
  async catalog(
    fallback: (signal?: AbortSignal) => Promise<SessionPersistenceSnapshot[]>,
    signal?: AbortSignal,
  ): Promise<IndexedRecentSession[]> {
    const index = await this.#currentIndex(fallback, signal)
    return Object.values(index.entries)
      .filter(entry => entry.header.origin !== 'subagent')
      .sort((left, right) => right.header.createdAt - left.header.createdAt)
      .flatMap(entry => {
        if (entry.checkpoint === undefined) return []
        const projected = projectRecent(entry.header, entry.checkpoint.projection)
        return projected === undefined ? [] : [projected]
      })
  }

  /** Classify the complete catalog from bounded checkpoints without exposing journal events. */
  async semanticCatalog(
    fallback: (signal?: AbortSignal) => Promise<SessionPersistenceSnapshot[]>,
    signal?: AbortSignal,
  ): Promise<IndexedSemanticCatalog> {
    const index = await this.#currentIndex(fallback, signal)
    const entries = Object.values(index.entries)
    const stale = entries.some(entry => entry.checkpoint === undefined
      || entry.checkpoint.projection.turnCount === undefined
      || entry.checkpoint.projection.localHumanMessageCount === undefined
      || entry.checkpoint.projection.hasTurnLifecycle === undefined)
    const sessions = entries.map(entry => {
      const projection = entry.checkpoint?.projection
      const human = (projection?.localHumanMessageCount ?? (projection?.firstMessage === undefined ? 0 : 1)) > 0
      const scope: IndexedSemanticSession['scope'] = entry.header.origin === 'subagent'
        ? 'subagent'
        : projection?.hasTurnLifecycle === false && projection.eventCount > 0
          ? 'legacy'
          : human ? 'human' : 'internal'
      const title = projection?.title ?? projection?.firstMessage ?? entry.header.id
      return {
        id: entry.header.id,
        title,
        ...(projection?.lastMessage === undefined || projection.lastMessage === title
          ? {} : { preview: projection.lastMessage }),
        ...(entry.header.cwd === undefined ? {} : { cwd: entry.header.cwd }),
        createdAt: entry.header.createdAt,
        updatedAt: projection?.updatedAt || entry.header.createdAt,
        eventCount: projection?.eventCount ?? 0,
        turns: projection?.turnCount ?? 0,
        ...(projection?.openTurn === true ? { status: 'interrupted' as const }
          : projection?.status === undefined ? {} : { status: projection.status }),
        scope,
        canResume: scope !== 'subagent',
      }
    })
    return { sessions, stale }
  }

  /** Read at most `limit` summaries, refolding only suffixes past exact persisted checkpoints. */
  async recent(
    fallback: (signal?: AbortSignal) => Promise<SessionPersistenceSnapshot[]>,
    limit: number,
    signal?: AbortSignal,
  ): Promise<IndexedRecentSession[]> {
    let index = await this.#currentIndex(fallback, signal)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const entries = Object.values(index.entries)
          .filter(entry => entry.header.origin !== 'subagent')
          .sort((left, right) => right.header.createdAt - left.header.createdAt)
        const rows: IndexedRecentSession[] = []
        let changed = false
        let pendingWrites = 0
        for (const entry of entries) {
          signal?.throwIfAborted()
          // Recent needs exact revisions only for rows it may return. Avoid the
          // old all-catalog stat pass over hundreds of unrelated journals.
          const revision = await sessionFileRevision(entry.path)
          let checkpoint = entry.checkpoint
          if (checkpoint !== undefined && (
            checkpoint.projection.turnCount === undefined
            || checkpoint.projection.localHumanMessageCount === undefined
            || checkpoint.projection.hasTurnLifecycle === undefined
          )) checkpoint = undefined
          if (checkpoint?.revision !== revision) {
            const fromSeq = checkpoint?.nextSeq ?? 0
            const before = await this.#persistence.readStoredRevision(entry.header.id, signal)
            if (String(before) !== revision) throw new Error(`session "${entry.header.id}" changed before projection read`)
            const suffix = await this.#persistence.readFrom(entry.header.id, fromSeq, signal)
            if (suffix.meta.id !== entry.header.id) throw new Error(`session "${entry.header.id}" suffix identity mismatch`)
            const after = await this.#persistence.readStoredRevision(entry.header.id, signal)
            if (String(after) !== revision) throw new Error(`session "${entry.header.id}" changed during projection read`)
            const projection = foldEvents(checkpoint?.projection, suffix.events, entry.header.seedLength ?? 0)
            let nextSeq = fromSeq
            for (const event of suffix.events) nextSeq = Math.max(nextSeq, event.seq + 1)
            checkpoint = { revision, nextSeq, projection }
            entry.checkpoint = checkpoint
            entry.revision = revision
            changed = true
            pendingWrites += 1
            if (pendingWrites >= 32) {
              await this.#queueWrite(index)
              pendingWrites = 0
            }
          }
          const row = projectRecent(entry.header, checkpoint.projection)
          if (row !== undefined) rows.push(row)
          if (rows.length >= limit) break
        }
        if (changed) await this.#queueWrite(index)
        return rows
      } catch (error) {
        if (attempt > 0 || signal?.aborted === true) throw error
        index = await this.#rebuild(fallback, signal)
      }
    }
    return []
  }

  /** Return only a checksum-valid snapshot still bound to the exact durable journal revision. */
  async viewportTail(id: string, signal?: AbortSignal): Promise<IndexedViewportTail | undefined> {
    signal?.throwIfAborted()
    const index = await this.#load()
    const viewport = index?.entries[id]?.viewport
    if (viewport === undefined) return undefined
    const current = await this.#persistence.readStoredRevision(id as SessionId, signal)
    if (String(current) !== viewport.revision) return undefined
    if (viewport.id !== id) return undefined
    return {
      id: viewport.id,
      revision: viewport.revision,
      checkpointSeq: viewport.checkpointSeq,
      eventCount: viewport.eventCount,
      events: structuredClone(viewport.events),
      ...(viewport.partial === true ? { partial: true } : {}),
      ...(viewport.omittedEvents === undefined ? {} : { omittedEvents: viewport.omittedEvents }),
    }
  }

  /** Refresh one display-only tail only when its session is already present in the persisted cache. */
  async refreshCachedViewportTail(
    id: string,
    signal?: AbortSignal,
    knownNextSeq?: number,
  ): Promise<void> {
    const index = await this.#load()
    if (index === undefined) return
    await this.#refreshViewportTailIn(index, id, signal, knownNextSeq)
  }

  /** Refresh one display-only tail from rc.8's validated physical read after Agent hydration. */
  async refreshViewportTail(
    id: string,
    fallback: (signal?: AbortSignal) => Promise<SessionPersistenceSnapshot[]>,
    signal?: AbortSignal,
    knownNextSeq?: number,
  ): Promise<void> {
    const index = await this.#currentIndex(fallback, signal)
    await this.#refreshViewportTailIn(index, id, signal, knownNextSeq)
  }

  async #refreshViewportTailIn(
    index: PersistedIndex,
    id: string,
    signal?: AbortSignal,
    knownNextSeq?: number,
  ): Promise<void> {
    const entry = index.entries[id]
    if (entry === undefined) return
    const boundedNextSeq = Number.isSafeInteger(knownNextSeq) && Number(knownNextSeq) >= 0
      ? Number(knownNextSeq)
      : entry.checkpoint?.nextSeq
    const fromSeq = Math.max(0, (boundedNextSeq ?? 0) - VIEWPORT_EVENT_LIMIT)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      signal?.throwIfAborted()
      const before = await this.#persistence.readStoredRevision(id as SessionId, signal)
      if (before === undefined) return
      const inspected = await this.#persistence.readFrom(id as SessionId, fromSeq, signal)
      if (inspected.meta.id !== id) return
      const after = await this.#persistence.readStoredRevision(id as SessionId, signal)
      if (before !== after) continue
      const eventCount = inspected.events.reduce(
        (count, event) => Math.max(count, event.seq + 1),
        boundedNextSeq ?? 0,
      )
      const viewport = buildViewportTail(this.#viewportGeneration, id, String(after), eventCount, inspected.events)
      if (viewport === undefined) delete entry.viewport
      else entry.viewport = viewport
      entry.revision = String(after)
      await this.#queueWrite(index)
      return
    }
  }

  async #currentIndex(
    fallback: (signal?: AbortSignal) => Promise<SessionPersistenceSnapshot[]>,
    signal?: AbortSignal,
  ): Promise<PersistedIndex> {
    if (this.#currentPromise !== undefined) return this.#currentPromise
    const pending = (async () => {
      const index = await this.#load()
      return index !== undefined && await this.#catalogCurrent(index, signal)
        ? index
        : this.#rebuild(fallback, signal)
    })()
    this.#currentPromise = pending
    try {
      return await pending
    } finally {
      if (this.#currentPromise === pending) this.#currentPromise = undefined
    }
  }

  #load(): Promise<PersistedIndex | undefined> {
    if (this.#loaded !== undefined) return Promise.resolve(this.#loaded)
    if (this.#loadPromise !== undefined) return this.#loadPromise
    this.#loadPromise = (async () => {
      try {
        const identity = await stat(this.#indexPath)
        if (!identity.isFile() || (identity.mode & 0o077) !== 0) return undefined
        const parsed: unknown = JSON.parse(await readFile(this.#indexPath, 'utf8'))
        this.#loaded = this.#validate(parsed)
      } catch {
        this.#loaded = undefined
      }
      return this.#loaded
    })()
    return this.#loadPromise
  }

  #validate(value: unknown): PersistedIndex | undefined {
    if (!isObject(value) || value.schema !== INDEX_SCHEMA || value.generation !== this.#generation
      || !isObject(value.projectDirectories) || !isObject(value.entries)) return undefined
    const projectDirectories: Record<string, string> = {}
    for (const [path, revision] of Object.entries(value.projectDirectories)) {
      if (typeof revision !== 'string' || dirname(path) !== this.#root) return undefined
      projectDirectories[path] = revision
    }
    const entries: Record<string, IndexEntry> = {}
    for (const [id, raw] of Object.entries(value.entries)) {
      if (!isObject(raw) || !isHeader(raw.header) || raw.header.id !== id
        || typeof raw.path !== 'string' || typeof raw.revision !== 'string') return undefined
      const expected = this.#persistence.locate(raw.header)
      if (expected?.kind !== 'jsonl' || resolve(raw.path) !== resolve(expected.path)) return undefined
      let checkpoint: ProjectionCheckpoint | undefined
      if (raw.checkpoint !== undefined) {
        if (!isObject(raw.checkpoint) || typeof raw.checkpoint.revision !== 'string'
          || !Number.isSafeInteger(raw.checkpoint.nextSeq) || Number(raw.checkpoint.nextSeq) < 0
          || !isProjection(raw.checkpoint.projection)) return undefined
        checkpoint = raw.checkpoint as unknown as ProjectionCheckpoint
      }
      let viewport: ViewportTailSnapshot | undefined
      if (raw.viewport !== undefined) {
        if (!isObject(raw.viewport) || raw.viewport.schema !== VIEWPORT_SCHEMA
          || raw.viewport.generation !== this.#viewportGeneration || raw.viewport.id !== id
          || typeof raw.viewport.revision !== 'string' || typeof raw.viewport.digest !== 'string'
          || !Number.isSafeInteger(raw.viewport.checkpointSeq) || Number(raw.viewport.checkpointSeq) < 0
          || !Number.isSafeInteger(raw.viewport.eventCount) || Number(raw.viewport.eventCount) < 0
          || (raw.viewport.partial !== undefined && raw.viewport.partial !== true)
          || (raw.viewport.omittedEvents !== undefined
            && (!Number.isSafeInteger(raw.viewport.omittedEvents) || Number(raw.viewport.omittedEvents) < 1))
          || !Array.isArray(raw.viewport.events) || raw.viewport.events.length > VIEWPORT_EVENT_LIMIT
          || !raw.viewport.events.every(isSnapshotEvent)
          || !viewportEventsWithinByteLimit(raw.viewport.events)) return undefined
        const payload: Omit<ViewportTailSnapshot, 'digest'> = {
          schema: VIEWPORT_SCHEMA,
          generation: this.#viewportGeneration,
          id,
          revision: raw.viewport.revision,
          checkpointSeq: Number(raw.viewport.checkpointSeq),
          eventCount: Number(raw.viewport.eventCount),
          events: structuredClone(raw.viewport.events),
          ...(raw.viewport.partial === true ? { partial: true } : {}),
          ...(raw.viewport.omittedEvents === undefined ? {} : { omittedEvents: Number(raw.viewport.omittedEvents) }),
        }
        if (viewportDigest(payload) !== raw.viewport.digest
          || payload.events[0]?.seq !== payload.checkpointSeq
          || (payload.omittedEvents !== undefined && payload.omittedEvents !== payload.checkpointSeq)
          || (payload.partial === true) !== (payload.omittedEvents !== undefined)) return undefined
        viewport = { ...payload, digest: raw.viewport.digest }
      }
      entries[id] = {
        header: structuredClone(raw.header), path: resolve(raw.path), revision: raw.revision,
        ...(checkpoint === undefined ? {} : { checkpoint }),
        ...(viewport === undefined ? {} : { viewport }),
      }
    }
    return { schema: INDEX_SCHEMA, generation: this.#generation, projectDirectories, entries }
  }

  async #catalogCurrent(index: PersistedIndex, signal?: AbortSignal): Promise<boolean> {
    try {
      const roots = (await readdir(this.#root, { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => resolve(this.#root, entry.name))
        .sort()
      const expected = Object.keys(index.projectDirectories).sort()
      if (roots.length !== expected.length || roots.some((path, offset) => path !== expected[offset])) return false
      for (const path of roots) {
        signal?.throwIfAborted()
        if (await directoryRevision(path) !== index.projectDirectories[path]) return false
      }
      return true
    } catch {
      return false
    }
  }

  async #rebuild(
    fallback: (signal?: AbortSignal) => Promise<SessionPersistenceSnapshot[]>,
    signal?: AbortSignal,
  ): Promise<PersistedIndex> {
    const snapshots = await fallback(signal)
    const previous = this.#loaded?.entries ?? {}
    const entries: Record<string, IndexEntry> = {}
    const projects = new Set<string>()
    for (const snapshot of snapshots) {
      signal?.throwIfAborted()
      const location = this.#persistence.locate(snapshot.header)
      if (location?.kind !== 'jsonl') throw new Error(`session "${snapshot.header.id}" has no JSONL location`)
      const path = resolve(location.path)
      projects.add(dirname(dirname(path)))
      const prior = previous[snapshot.header.id]
      entries[snapshot.header.id] = {
        header: structuredClone(snapshot.header), path, revision: String(snapshot.revision),
        ...(prior?.checkpoint === undefined ? {} : { checkpoint: prior.checkpoint }),
        ...(prior?.viewport === undefined ? {} : { viewport: prior.viewport }),
      }
    }
    const projectDirectories: Record<string, string> = {}
    for (const path of projects) projectDirectories[path] = await directoryRevision(path)
    const index: PersistedIndex = { schema: INDEX_SCHEMA, generation: this.#generation, projectDirectories, entries }
    this.#loaded = index
    if (snapshots.length > 0) await this.#queueWrite(index)
    return index
  }

  #queueWrite(index: PersistedIndex): Promise<void> {
    const snapshot = JSON.stringify(index)
    this.#writeChain = this.#writeChain.catch(() => {}).then(async () => {
      const temporary = `${this.#indexPath}.${process.pid}.${randomUUID()}.tmp`
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(snapshot, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await rename(temporary, this.#indexPath)
        await chmod(this.#indexPath, 0o600)
        const directory = await open(this.#root, 'r')
        try { await directory.sync() } finally { await directory.close() }
      } catch (error) {
        await unlink(temporary).catch(() => {})
        throw error
      }
    })
    return this.#writeChain
  }
}
