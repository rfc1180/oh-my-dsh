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
const VIEWPORT_EVENT_LIMIT = 1_024
const STATUS_VALUES = new Set(['done', 'failed', 'blocked', 'interrupted'])

export interface IndexedRecentSession {
  id: string
  title: string
  preview?: string
  createdAt: number
  updatedAt: number
  eventCount: number
  status?: 'done' | 'failed' | 'blocked' | 'interrupted'
}

interface SummaryProjection {
  firstMessage?: string
  lastMessage?: string
  title?: string
  status?: IndexedRecentSession['status']
  openTurn: boolean
  updatedAt: number
  eventCount: number
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

function buildViewportTail(
  generation: string,
  id: string,
  revision: string,
  events: readonly SessionEvent[],
): ViewportTailSnapshot | undefined {
  if (events.length === 0) return undefined
  const candidateStart = Math.max(0, events.length - VIEWPORT_EVENT_LIMIT)
  let start = events.findIndex((event, index) => index >= candidateStart && event.type === 'turn/start')
  if (start < candidateStart) {
    start = events.findIndex((event, index) => index >= candidateStart && event.type === 'user/message')
  }
  if (start < candidateStart) return undefined
  const tail = structuredClone(events.slice(start))
  const first = tail[0]
  if (first === undefined) return undefined
  const payload: Omit<ViewportTailSnapshot, 'digest'> = {
    schema: VIEWPORT_SCHEMA,
    generation,
    id,
    revision,
    checkpointSeq: first.seq,
    eventCount: events.length,
    events: tail,
  }
  return { ...payload, digest: viewportDigest(payload) }
}

function eventText(event: SessionEvent): string | undefined {
  if (event.type !== 'user/message' || event.data.source.kind !== 'user') return undefined
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

function foldEvents(base: SummaryProjection | undefined, events: readonly SessionEvent[]): SummaryProjection {
  const projection: SummaryProjection = base === undefined
    ? { openTurn: false, updatedAt: 0, eventCount: 0 }
    : structuredClone(base)
  for (const event of events) {
    projection.eventCount += 1
    projection.updatedAt = Math.max(projection.updatedAt, event.time)
    const text = eventText(event)
    if (text !== undefined) {
      projection.firstMessage ??= text
      projection.lastMessage = text
    }
    if (event.type === 'session/title') projection.title = event.data.title
    if (event.type === 'turn/start') projection.openTurn = true
    if (event.type === 'turn/end') {
      projection.openTurn = false
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
    createdAt: header.createdAt,
    updatedAt: projection.updatedAt || header.createdAt,
    eventCount: projection.eventCount,
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
  #loadAttempted = false
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

  /** Read at most `limit` summaries, refolding only suffixes past exact persisted checkpoints. */
  async recent(
    fallback: (signal?: AbortSignal) => Promise<SessionPersistenceSnapshot[]>,
    limit: number,
    signal?: AbortSignal,
  ): Promise<IndexedRecentSession[]> {
    const snapshots = (await this.listSnapshots(fallback, signal))
      .filter(snapshot => snapshot.header.origin !== 'subagent')
      .sort((left, right) => right.header.createdAt - left.header.createdAt)
    const index = this.#loaded
    if (index === undefined) throw new Error('session index was not loaded')
    const rows: IndexedRecentSession[] = []
    let changed = false
    for (const snapshot of snapshots) {
      signal?.throwIfAborted()
      const entry = index.entries[snapshot.header.id]
      if (entry === undefined) throw new Error(`session index lost "${snapshot.header.id}"`)
      const revision = String(snapshot.revision)
      let checkpoint = entry.checkpoint
      if (checkpoint?.revision !== revision) {
        const fromSeq = checkpoint?.nextSeq ?? 0
        const before = await this.#persistence.readStoredRevision(snapshot.header.id, signal)
        if (String(before) !== revision) throw new Error(`session "${snapshot.header.id}" changed before projection read`)
        const suffix = await this.#persistence.readFrom(snapshot.header.id, fromSeq, signal)
        if (suffix.meta.id !== snapshot.header.id) throw new Error(`session "${snapshot.header.id}" suffix identity mismatch`)
        const after = await this.#persistence.readStoredRevision(snapshot.header.id, signal)
        if (String(after) !== revision) throw new Error(`session "${snapshot.header.id}" changed during projection read`)
        const projection = foldEvents(checkpoint?.projection, suffix.events)
        const nextSeq = suffix.events.length === 0
          ? fromSeq
          : Math.max(fromSeq, ...suffix.events.map(event => event.seq + 1))
        checkpoint = { revision, nextSeq, projection }
        entry.checkpoint = checkpoint
        entry.revision = revision
        changed = true
      }
      const row = projectRecent(snapshot.header, checkpoint.projection)
      if (row !== undefined) rows.push(row)
      if (rows.length >= limit) break
    }
    if (changed) await this.#queueWrite(index)
    return rows
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
    }
  }

  /** Refresh one display-only tail from rc.8's validated physical read after Agent hydration. */
  async refreshViewportTail(
    id: string,
    fallback: (signal?: AbortSignal) => Promise<SessionPersistenceSnapshot[]>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.listSnapshots(fallback, signal)
    const index = this.#loaded
    const entry = index?.entries[id]
    if (index === undefined || entry === undefined) return
    for (let attempt = 0; attempt < 2; attempt += 1) {
      signal?.throwIfAborted()
      const before = await this.#persistence.readStoredRevision(id as SessionId, signal)
      if (before === undefined) return
      const inspected = await this.#persistence.readFrom(id as SessionId, 0, signal)
      if (inspected.meta.id !== id) return
      const after = await this.#persistence.readStoredRevision(id as SessionId, signal)
      if (before !== after) continue
      const viewport = buildViewportTail(this.#viewportGeneration, id, String(after), inspected.events)
      if (viewport === undefined) delete entry.viewport
      else entry.viewport = viewport
      entry.revision = String(after)
      await this.#queueWrite(index)
      return
    }
  }

  async #load(): Promise<PersistedIndex | undefined> {
    if (this.#loadAttempted) return this.#loaded
    this.#loadAttempted = true
    try {
      const identity = await stat(this.#indexPath)
      if (!identity.isFile() || (identity.mode & 0o077) !== 0) return undefined
      const parsed: unknown = JSON.parse(await readFile(this.#indexPath, 'utf8'))
      this.#loaded = this.#validate(parsed)
    } catch {
      this.#loaded = undefined
    }
    return this.#loaded
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
          || !Array.isArray(raw.viewport.events) || raw.viewport.events.length > VIEWPORT_EVENT_LIMIT
          || !raw.viewport.events.every(isSnapshotEvent)) return undefined
        const payload: Omit<ViewportTailSnapshot, 'digest'> = {
          schema: VIEWPORT_SCHEMA,
          generation: this.#viewportGeneration,
          id,
          revision: raw.viewport.revision,
          checkpointSeq: Number(raw.viewport.checkpointSeq),
          eventCount: Number(raw.viewport.eventCount),
          events: structuredClone(raw.viewport.events),
        }
        if (viewportDigest(payload) !== raw.viewport.digest
          || payload.events[0]?.seq !== payload.checkpointSeq) return undefined
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
