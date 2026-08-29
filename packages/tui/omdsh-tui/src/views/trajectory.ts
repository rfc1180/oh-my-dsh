/**
 * Full-screen Trajectory workspace.
 *
 * The data source stays outside the renderer; this module owns only immutable
 * interaction state, event projection, filtering, and terminal layout.
 * @module @agi-fans/dsh-tui
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  TuiTrajectoryMode,
  TuiTrajectoryOptions,
  TuiTrajectorySession,
  TuiTrajectorySessionSummary,
} from '../definition.ts'
import type { Frame } from '../chrome/renderer.ts'
import { BOX, SPINNER, SYMBOL, type Theme } from '../chrome/theme.ts'
import { padToWidth, truncateToWidth, visibleWidth, wrapText } from '../chrome/width.ts'
import type { KeyEvent } from '../input/keys.ts'

export type TrajectoryFocus = 'sessions' | 'timeline' | 'details'
export type TrajectoryTone = 'normal' | 'muted' | 'success' | 'warning' | 'error' | 'accent'

interface EventLike {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data?: unknown
}

export type TrajectoryLane = 'conversation' | 'execution' | 'orchestration'

export interface TrajectoryEventRow {
  readonly event: SessionEvent
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly category: 'turn' | 'model' | 'message' | 'tool' | 'workflow' | 'goal' | 'system' | 'error'
  readonly lane: TrajectoryLane
  readonly tone: TrajectoryTone
  readonly glyph: string
  readonly label: string
  readonly summary: string
  readonly error: boolean
  readonly tool: boolean
  readonly problem: boolean
  readonly change?: string | undefined
  readonly turnId?: string | undefined
  readonly stepId?: string | undefined
  readonly callId?: string | undefined
  readonly runId?: string | undefined
  readonly defaultVisible: boolean
  readonly searchText: string
}

export interface TrajectoryState {
  readonly activeSessionId: string
  readonly sessions: readonly TuiTrajectorySessionSummary[]
  readonly selectedSession: number
  readonly snapshot?: TuiTrajectorySession
  readonly rows: readonly TrajectoryEventRow[]
  readonly selectedEvent: number
  readonly focus: TrajectoryFocus
  readonly mode: TuiTrajectoryMode
  readonly query: string
  readonly searchActive: boolean
  readonly follow: boolean
  readonly loading: boolean
  readonly error?: string | undefined
  readonly detailScroll: number
  readonly limit: number
  readonly updatedAt?: number
}

export type TrajectoryCommand =
  | { kind: 'update'; state: TrajectoryState }
  | { kind: 'inspect'; state: TrajectoryState; id: string }
  | { kind: 'refresh'; state: TrajectoryState }
  | { kind: 'copy'; state: TrajectoryState; text: string; label: string }
  | { kind: 'close' }
  | { kind: 'ignore' }

const MODES: readonly TuiTrajectoryMode[] = ['overview', 'flow', 'runs', 'tools', 'changes', 'problems', 'raw']
const MODE_ALIASES: Readonly<Record<string, TuiTrajectoryMode>> = {
  summary: 'overview',
  all: 'raw',
  errors: 'problems',
}
const DEFAULT_LIMIT = 2_000
const MAX_LIMIT = 10_000

/** Parse the current-conversation `/trajectory [mode] [limit]` vocabulary. */
export function parseTrajectoryOptions(rawInput = ''): TuiTrajectoryOptions {
  const words = rawInput.trim().split(/\s+/u).filter(Boolean)
  if (words[0] === 'screen' || words[0] === 'browse') words.shift()
  let mode: TuiTrajectoryMode = 'overview'
  let limit: number | undefined
  for (const word of words) {
    const canonical = MODE_ALIASES[word] ?? (MODES.includes(word as TuiTrajectoryMode) ? word as TuiTrajectoryMode : undefined)
    if (canonical !== undefined) {
      mode = canonical
      continue
    }
    if (/^\d+$/u.test(word)) {
      const parsed = Number(word)
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
        throw new Error(`Trajectory limit must be between 1 and ${MAX_LIMIT}`)
      }
      limit = parsed
      continue
    }
    throw new Error('Usage: /trajectory [overview|flow|runs|tools|changes|problems|raw] [limit]')
  }
  return { mode, ...(limit === undefined ? {} : { limit }) }
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' ? value as Readonly<Record<string, unknown>> : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function compact(value: unknown, limit = 180): string {
  const normalized = text(value).replace(/\s+/gu, ' ').trim()
  return normalized.length <= limit ? normalized : normalized.slice(0, Math.max(0, limit - 1)) + '…'
}

function jsonForSearch(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return text(value)
  }
}

function safeJson(value: unknown): string {
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(value, (_key, candidate: unknown) => {
      if (typeof candidate === 'string' && candidate.length > 8_000) return candidate.slice(0, 7_999) + '…'
      if (candidate !== null && typeof candidate === 'object') {
        if (seen.has(candidate)) return '[circular]'
        seen.add(candidate)
      }
      return candidate
    }, 2)
  } catch {
    return text(value)
  }
}

function safeEventJson(value: unknown): string {
  const scrub = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.filter(item => record(item).type !== 'reasoning').map(scrub)
    if (candidate === null || typeof candidate !== 'object') return candidate
    const output: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(candidate)) {
      if (/reasoning|thinking/iu.test(key)) continue
      output[key] = scrub(nested)
    }
    return output
  }
  return safeJson(scrub(value))
}

function contentText(value: unknown, reasoning = false): string {
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const raw of value) {
    const block = record(raw)
    if (block.type === 'text') parts.push(text(block.text))
    else if (block.type === 'image') parts.push('[image]')
    else if (block.type === 'reasoning' && reasoning) parts.push('thinking: ' + text(block.text))
    else if (block.type === 'tool-result') parts.push(contentText(block.content, reasoning))
  }
  return compact(parts.filter(Boolean).join(' '), 300)
}

function duration(milliseconds: number | undefined): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return ''
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = Math.floor((milliseconds % 60_000) / 1_000)
  return `${minutes}m${String(seconds).padStart(2, '0')}s`
}

function clock(milliseconds: number): string {
  const date = new Date(milliseconds)
  if (!Number.isFinite(date.getTime())) return '--:--:--'
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(part => String(part).padStart(2, '0')).join(':')
}

function relativeTime(milliseconds: number): string {
  const safe = Math.max(0, milliseconds)
  const minutes = Math.floor(safe / 60_000)
  const seconds = Math.floor((safe % 60_000) / 1_000)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function usageSummary(value: unknown): string {
  const usage = record(value)
  const fields = [
    number(usage.inputTokens) === undefined ? undefined : `↑${usage.inputTokens}`,
    number(usage.outputTokens) === undefined ? undefined : `↓${usage.outputTokens}`,
    number(usage.cacheReadTokens) ? `cache:${usage.cacheReadTokens}` : undefined,
  ].filter((field): field is string => field !== undefined)
  return fields.join(' ')
}

function eventData(event: EventLike): Readonly<Record<string, unknown>> {
  return record(event.data)
}

function toolResult(event: EventLike): { callId: string; failed: boolean; output: string } {
  const data = eventData(event)
  const message = record(data.message)
  const source = record(message.source)
  const first = record(Array.isArray(message.content) ? message.content[0] : undefined)
  return {
    callId: text(first.toolCallId || source.callId),
    failed: first.isError === true || data.error !== undefined,
    output: contentText(first.content),
  }
}

function isProblemEvent(event: EventLike): boolean {
  if (event.type === 'tool/result') return toolResult(event).failed
  const data = eventData(event)
  if (event.type === 'assistant/message') return data.interrupted === true
  if (event.type === 'llm/retry' || event.type === 'llm/retry-started') return true
  if (event.type === 'turn/end') {
    const reason = record(data.reason)
    const outcome = text(reason.kind || data.reason).toLocaleLowerCase()
    return outcome !== '' && outcome !== 'completed'
  }
  return /error|failed|abort|interrupt|reject|max[-_/ ]?tokens|retry/iu.test(event.type)
}

function isToolEvent(event: EventLike): boolean {
  return event.type.startsWith('tool/') || event.type.startsWith('tool-workflow/') || event.type.startsWith('subagent/')
}

function laneFor(event: EventLike): TrajectoryLane {
  if (event.type.startsWith('tool/') || event.type.startsWith('command/')) return 'execution'
  if (/^(?:tool-workflow|subagent|workflow|agent|goal|todo|compaction|inbox|llm\/retry)/u.test(event.type)) return 'orchestration'
  return 'conversation'
}

function explicitIds(event: EventLike): Pick<TrajectoryEventRow, 'turnId' | 'stepId' | 'callId' | 'runId'> {
  const data = eventData(event)
  const message = record(data.message)
  const source = record(message.source)
  const first = record(Array.isArray(message.content) ? message.content[0] : undefined)
  const turnId = text(data.turnId || data.turn)
  const stepId = text(data.stepId || data.step)
  const callId = text(data.callId || data.toolCallId || first.toolCallId || source.callId)
  const runId = text(data.runId)
  return {
    ...(turnId === '' ? {} : { turnId }),
    ...(stepId === '' ? {} : { stepId }),
    ...(callId === '' ? {} : { callId }),
    ...(runId === '' ? {} : { runId }),
  }
}

function confirmedChange(event: EventLike): string | undefined {
  if (event.type !== 'tool/result') return undefined
  const data = eventData(event)
  const message = record(data.message)
  const content = Array.isArray(message.content) ? message.content.map(record) : []
  const first = content[0] ?? {}
  const nestedContent = Array.isArray(first.content) ? first.content.map(record) : []
  const metadata = [data.metadata, message.metadata, first.metadata, ...nestedContent.map(block => block.metadata)].map(record)
  const summaries: string[] = []
  for (const value of metadata) {
    const diff = text(value.diff || value.patch)
    if (diff !== '') summaries.push(compact(diff, 240))
    const changes = Array.isArray(value.changes) ? value.changes : Array.isArray(value.filesChanged) ? value.filesChanged : []
    for (const item of changes) {
      const change = record(item)
      const path = text(change.path || change.file)
      const status = text(change.status || change.kind || change.operation)
      if (path !== '') summaries.push([status, path].filter(Boolean).join(' '))
    }
  }
  return summaries.length === 0 ? undefined : summaries.join(' · ')
}

interface Timings {
  readonly turns: Map<string, number>
  readonly steps: Map<string, number>
  readonly calls: Map<string, number>
  readonly workflows: Map<string, number>
  readonly compactions: Map<string, number>
}

function timingKey(...parts: unknown[]): string {
  return parts.map(text).join(':')
}

function eventProjection(event: EventLike, timings: Timings): Omit<TrajectoryEventRow, 'event' | 'searchText'> | undefined {
  const data = eventData(event)
  const failed = isProblemEvent(event)
  const change = confirmedChange(event)
  const base = {
    seq: event.seq,
    time: event.time,
    type: event.type,
    lane: laneFor(event),
    error: failed,
    problem: failed,
    tool: isToolEvent(event),
    ...(change === undefined ? {} : { change }),
    ...explicitIds(event),
  }
  switch (event.type) {
    case 'turn/start': {
      timings.turns.set(text(data.turn), event.time)
      return { ...base, category: 'turn', tone: 'accent', glyph: '▶', label: `Turn ${text(data.turn)}`, summary: 'started', defaultVisible: true }
    }
    case 'turn/end': {
      const reason = record(data.reason)
      const took = duration(event.time - (timings.turns.get(text(data.turn)) ?? event.time))
      const outcome = text(reason.kind || data.reason || 'ended')
      return { ...base, category: failed ? 'error' : 'turn', tone: failed ? 'error' : 'success', glyph: failed ? SYMBOL.error : SYMBOL.success, label: `Turn ${text(data.turn)}`, summary: [outcome, took].filter(Boolean).join(' · '), defaultVisible: true }
    }
    case 'step/start':
      timings.steps.set(timingKey(data.turn, data.step), event.time)
      return { ...base, category: 'model', tone: 'muted', glyph: '◇', label: `Step ${text(data.step)}`, summary: 'model request started', defaultVisible: true }
    case 'step/end': {
      const took = duration(event.time - (timings.steps.get(timingKey(data.turn, data.step)) ?? event.time))
      return { ...base, category: 'model', tone: 'success', glyph: SYMBOL.success, label: `Step ${text(data.step)}`, summary: took, defaultVisible: true }
    }
    case 'user/message': {
      const source = record(data.source)
      const message = record(data.message)
      return { ...base, category: 'message', tone: source.kind === 'user' ? 'accent' : 'muted', glyph: '◆', label: source.kind === 'user' ? 'You' : `Input:${text(source.kind || record(message.source).kind)}`, summary: contentText(data.content || message.content), defaultVisible: source.kind === 'user' }
    }
    case 'assistant/message': {
      const message = record(data.message)
      const source = record(message.source)
      const route = [source.provider, source.model].map(text).filter(Boolean).join('/')
      const usage = usageSummary(data.usage)
      const body = contentText(message.content)
      return { ...base, category: failed ? 'error' : 'message', tone: failed ? 'warning' : 'normal', glyph: failed ? SYMBOL.warning : '●', label: 'Assistant', summary: [route, usage, body].filter(Boolean).join(' · '), defaultVisible: true }
    }
    case 'tool/call': {
      const callId = text(data.callId)
      timings.calls.set(callId, event.time)
      return { ...base, category: 'tool', tone: 'accent', glyph: '↳', label: text(data.name || 'tool'), summary: compact(data.arguments), defaultVisible: true }
    }
    case 'tool/result': {
      const result = toolResult(event)
      const took = duration(event.time - (timings.calls.get(result.callId) ?? event.time))
      return { ...base, category: result.failed ? 'error' : 'tool', tone: result.failed ? 'error' : 'success', glyph: result.failed ? SYMBOL.error : SYMBOL.success, label: 'Result', summary: [result.callId, took, result.output].filter(Boolean).join(' · '), defaultVisible: true }
    }
    case 'request/context':
      return { ...base, category: 'model', tone: 'muted', glyph: '◌', label: 'Route', summary: [data.provider, data.model].map(text).filter(Boolean).join(' / '), defaultVisible: true }
    case 'todo/write': {
      const todos = Array.isArray(data.todos) ? data.todos.map(record) : []
      const done = todos.filter(item => item.status === 'completed').length
      const active = todos.filter(item => item.status === 'in_progress').length
      return { ...base, category: 'goal', tone: active > 0 ? 'accent' : 'success', glyph: '☷', label: 'Todos', summary: `${done}/${todos.length} done${active > 0 ? ` · ${active} active` : ''}`, defaultVisible: true }
    }
    case 'goal/change': {
      const goal = record(data.goal)
      return { ...base, category: 'goal', tone: text(goal.phase || data.phase) === 'blocked' ? 'warning' : 'accent', glyph: '◎', label: 'Goal', summary: [goal.phase || data.phase, compact(goal.objective || data.objective)].map(text).filter(Boolean).join(' · '), defaultVisible: true }
    }
    case 'tool-workflow/run-start': {
      const runId = text(data.runId)
      timings.workflows.set(runId, event.time)
      return { ...base, category: 'workflow', tone: 'accent', glyph: '▶', label: 'Workflow', summary: text(data.name || runId || 'started'), defaultVisible: true }
    }
    case 'tool-workflow/run-end': {
      const stop = record(data.stopReason)
      const outcome = text(stop.kind || data.stopReason || 'ended')
      const took = duration(event.time - (timings.workflows.get(text(data.runId)) ?? event.time))
      return { ...base, category: outcome === 'completed' ? 'workflow' : 'error', tone: outcome === 'completed' ? 'success' : 'error', glyph: outcome === 'completed' ? SYMBOL.success : SYMBOL.error, label: 'Workflow', summary: [outcome, took].filter(Boolean).join(' · '), defaultVisible: true }
    }
    case 'tool-workflow/agent-start':
    case 'subagent/descriptor':
      return { ...base, category: 'workflow', tone: 'accent', glyph: '↳', label: 'Agent', summary: compact(data.label || data.childId || data.id), defaultVisible: true }
    case 'tool-workflow/agent-end': {
      const outcome = record(data.outcome)
      const status = text(outcome.reason || outcome.status || data.outcome || 'ended')
      return { ...base, category: status === 'completed' ? 'workflow' : 'error', tone: status === 'completed' ? 'success' : 'error', glyph: status === 'completed' ? SYMBOL.success : SYMBOL.error, label: 'Agent', summary: status, defaultVisible: true }
    }
    case 'compaction/start':
      timings.compactions.set(text(data.compactionId), event.time)
      return { ...base, category: 'system', tone: 'warning', glyph: '◫', label: 'Compaction', summary: 'started', defaultVisible: true }
    case 'compaction/summary':
      return { ...base, category: 'system', tone: 'muted', glyph: '◫', label: 'Compaction', summary: `${text(data.shadowedTokenCount || '?')} shadow tokens · ${contentText(data.summary)}`, defaultVisible: true }
    case 'compaction/end': {
      const took = duration(event.time - (timings.compactions.get(text(data.compactionId)) ?? event.time))
      return { ...base, category: data.error === undefined ? 'system' : 'error', tone: data.error === undefined ? 'success' : 'error', glyph: data.error === undefined ? SYMBOL.success : SYMBOL.error, label: 'Compaction', summary: [took, compact(data.error)].filter(Boolean).join(' · '), defaultVisible: true }
    }
    case 'llm/retry':
    case 'llm/retry-started':
      return { ...base, category: 'error', tone: 'warning', glyph: SYMBOL.warning, label: 'Retry', summary: compact(data.reason || data.error || jsonForSearch(data)), defaultVisible: true }
    case 'session/end-seed':
      return { ...base, category: 'system', tone: 'muted', glyph: '↻', label: 'Resume', summary: 'new process boundary', defaultVisible: true }
    default:
      return { ...base, category: failed ? 'error' : 'system', tone: failed ? 'error' : 'muted', glyph: failed ? SYMBOL.error : '·', label: event.type, summary: compact(jsonForSearch(data)), defaultVisible: failed }
  }
}

/** Project a durable event log once; render frames only filter this cache. */
export function buildTrajectoryRows(events: readonly SessionEvent[]): TrajectoryEventRow[] {
  const timings: Timings = {
    turns: new Map(),
    steps: new Map(),
    calls: new Map(),
    workflows: new Map(),
    compactions: new Map(),
  }
  const rows: TrajectoryEventRow[] = []
  for (const raw of events) {
    const event = raw as EventLike
    const projected = eventProjection(event, timings)
    if (projected === undefined) continue
    rows.push({
      ...projected,
      event: raw,
      searchText: `${projected.type} ${projected.label} ${projected.summary} ${jsonForSearch(event.data)}`.toLocaleLowerCase(),
    })
  }
  return rows
}

function sessionTime(session: TuiTrajectorySessionSummary): number {
  return session.updatedAt ?? session.createdAt ?? 0
}

/** Root-first ordering with each descendant immediately below its parent. */
export function orderTrajectorySessions(sessions: readonly TuiTrajectorySessionSummary[]): TuiTrajectorySessionSummary[] {
  const unique = new Map(sessions.map(session => [session.id, session]))
  const children = new Map<string, TuiTrajectorySessionSummary[]>()
  const roots: TuiTrajectorySessionSummary[] = []
  for (const session of unique.values()) {
    if (session.parentSession !== undefined && unique.has(session.parentSession)) {
      const rows = children.get(session.parentSession) ?? []
      rows.push(session)
      children.set(session.parentSession, rows)
    } else {
      roots.push(session)
    }
  }
  const recent = (left: TuiTrajectorySessionSummary, right: TuiTrajectorySessionSummary): number => sessionTime(right) - sessionTime(left)
  roots.sort(recent)
  for (const rows of children.values()) rows.sort(recent)
  const ordered: TuiTrajectorySessionSummary[] = []
  const append = (session: TuiTrajectorySessionSummary, seen: Set<string>): void => {
    if (seen.has(session.id)) return
    seen.add(session.id)
    ordered.push(session)
    for (const child of children.get(session.id) ?? []) append(child, seen)
  }
  const seen = new Set<string>()
  for (const root of roots) append(root, seen)
  for (const session of unique.values()) append(session, seen)
  return ordered
}

export function createTrajectoryState(activeSessionId: string, options: TuiTrajectoryOptions = {}): TrajectoryState {
  const limit = Math.max(1, Math.min(MAX_LIMIT, options.limit ?? DEFAULT_LIMIT))
  return {
    activeSessionId,
    sessions: [],
    selectedSession: 0,
    rows: [],
    selectedEvent: 0,
    focus: 'sessions',
    mode: options.mode ?? 'overview',
    query: '',
    searchActive: false,
    follow: true,
    loading: true,
    detailScroll: 0,
    limit,
  }
}

export function setTrajectorySessions(
  state: TrajectoryState,
  sessions: readonly TuiTrajectorySessionSummary[],
): TrajectoryState {
  const ordered = orderTrajectorySessions(sessions)
  const currentId = state.sessions[state.selectedSession]?.id || state.snapshot?.id || state.activeSessionId
  const selectedSession = Math.max(0, ordered.findIndex(session => session.id === currentId))
  return { ...state, sessions: ordered, selectedSession, loading: state.snapshot === undefined, error: undefined }
}

export function setTrajectorySnapshot(state: TrajectoryState, snapshot: TuiTrajectorySession): TrajectoryState {
  const { events: _events, ...summary } = snapshot
  const sessions = orderTrajectorySessions([
    ...state.sessions.filter(session => session.id !== snapshot.id),
    summary,
  ])
  const selectedSession = Math.max(0, sessions.findIndex(session => session.id === snapshot.id))
  const previous = selectedRow(state)
  const rows = buildTrajectoryRows(snapshot.events)
  const visible = filteredTrajectoryRows({ ...state, snapshot, sessions, selectedSession, rows })
  const stableIndex = previous === undefined ? -1 : visible.findIndex(row => row.seq === previous.seq && row.type === previous.type)
  const selectedEvent = state.follow || visible.length === 0
    ? Math.max(0, visible.length - 1)
    : stableIndex >= 0
      ? stableIndex
      : Math.max(0, Math.min(state.selectedEvent, visible.length - 1))
  return {
    ...state,
    sessions,
    selectedSession,
    snapshot,
    rows,
    selectedEvent,
    loading: false,
    error: undefined,
    detailScroll: state.follow ? 0 : state.detailScroll,
    updatedAt: Date.now(),
  }
}

export function appendTrajectoryEvent(state: TrajectoryState, sessionId: string, event: SessionEvent): TrajectoryState {
  if (state.snapshot?.id !== sessionId) return state
  const last = state.snapshot.events.at(-1) as EventLike | undefined
  const next = event as EventLike
  if (last !== undefined && last.seq >= next.seq) return state
  const snapshot: TuiTrajectorySession = {
    ...state.snapshot,
    events: [...state.snapshot.events, event],
    eventCount: state.snapshot.events.length + 1,
    updatedAt: next.time,
  }
  if (next.type === 'assistant/chunk') return { ...state, snapshot, updatedAt: Date.now() }
  return setTrajectorySnapshot(state, snapshot)
}

export function setTrajectoryLoading(state: TrajectoryState, loading: boolean, error?: string): TrajectoryState {
  return { ...state, loading, ...(error === undefined ? { error: undefined } : { error }) }
}

function modeMatches(row: TrajectoryEventRow, mode: TuiTrajectoryMode): boolean {
  if (mode === 'tools') return row.tool
  if (mode === 'changes') return row.change !== undefined
  if (mode === 'problems') return row.problem
  if (mode === 'runs') return row.lane === 'orchestration'
  if (mode === 'raw' || mode === 'flow') return true
  return row.defaultVisible
}

/** Current bounded event result after mode and fuzzy text filtering. */
export function filteredTrajectoryRows(state: TrajectoryState): TrajectoryEventRow[] {
  const query = state.query.trim().toLocaleLowerCase()
  const matching = state.rows.filter(row => modeMatches(row, state.mode) && (query === '' || row.searchText.includes(query)))
  return matching.slice(-state.limit)
}

function moveSession(state: TrajectoryState, delta: number): TrajectoryCommand {
  if (state.sessions.length === 0) return { kind: 'ignore' }
  const selectedSession = Math.max(0, Math.min(state.sessions.length - 1, state.selectedSession + delta))
  const id = state.sessions[selectedSession]?.id
  if (id === undefined || selectedSession === state.selectedSession) return { kind: 'ignore' }
  const next = { ...state, selectedSession, loading: true, error: undefined, detailScroll: 0 }
  return { kind: 'inspect', state: next, id }
}

function moveEvent(state: TrajectoryState, delta: number): TrajectoryState {
  const rows = filteredTrajectoryRows(state)
  if (rows.length === 0) return state
  const selectedEvent = Math.max(0, Math.min(rows.length - 1, state.selectedEvent + delta))
  return { ...state, selectedEvent, follow: selectedEvent === rows.length - 1, detailScroll: 0 }
}

function selectedRow(state: TrajectoryState): TrajectoryEventRow | undefined {
  const rows = filteredTrajectoryRows(state)
  return rows[Math.max(0, Math.min(state.selectedEvent, rows.length - 1))]
}

function nextFocus(focus: TrajectoryFocus, direction: 1 | -1): TrajectoryFocus {
  const order: readonly TrajectoryFocus[] = ['sessions', 'timeline', 'details']
  const index = order.indexOf(focus)
  return order[(index + direction + order.length) % order.length] ?? 'timeline'
}

/** Resolve a 1-based SGR coordinate to a visible pane, including blank pane rows. */
export function trajectoryPaneAt(state: TrajectoryState, width: number, height: number, column: number, row: number): TrajectoryFocus | undefined {
  if (width < 28 || height < 10 || column <= 1 || column >= width || row < 4) return undefined
  const contentHeight = Math.max(1, height - 6)
  const y = row - 4
  if (y < 0 || y >= contentHeight) return undefined
  const innerWidth = Math.max(1, width - 2)
  if (innerWidth >= 92) {
    const leftWidth = Math.max(26, Math.min(38, Math.floor(innerWidth * 0.28)))
    const x = column - 2
    if (x < leftWidth) return 'sessions'
    if (x === leftWidth) return undefined
    const timelineHeight = Math.max(5, Math.floor(contentHeight * 0.58))
    return y < timelineHeight ? 'timeline' : y === timelineHeight ? undefined : 'details'
  }
  if (state.focus === 'sessions') return 'sessions'
  const detailHeight = state.focus === 'details' ? Math.max(5, Math.floor(contentHeight * 0.5)) : Math.max(4, Math.floor(contentHeight * 0.34))
  const timelineHeight = Math.max(3, contentHeight - detailHeight - 1)
  return y < timelineHeight ? 'timeline' : y === timelineHeight ? undefined : 'details'
}

/** Apply one input event without touching persistence or the terminal. */
export function applyTrajectoryEvent(state: TrajectoryState, event: KeyEvent, width = 0, height = 0): TrajectoryCommand {
  if (event.type === 'mouse') {
    const pane = trajectoryPaneAt(state, width, height, event.column, event.row)
    if (pane === undefined) return { kind: 'ignore' }
    const focused = { ...state, focus: pane }
    const direction = event.action === 'wheel-up' ? 'up' : 'down'
    const moved = applyTrajectoryEvent(focused, { type: 'key', id: direction }, width, height)
    return moved.kind === 'ignore' ? { kind: 'update', state: focused } : moved
  }
  if (state.searchActive) {
    if (event.type === 'key' && (event.id === 'escape' || event.id === 'enter' || event.id === 'ctrl+j')) {
      return { kind: 'update', state: { ...state, searchActive: false, selectedEvent: 0, follow: false } }
    }
    if (event.type === 'key' && event.id === 'ctrl+c') return { kind: 'close' }
    if (event.type === 'key' && event.id === 'backspace') {
      return { kind: 'update', state: { ...state, query: state.query.slice(0, -1), selectedEvent: 0, follow: false } }
    }
    if (event.type === 'text') {
      return { kind: 'update', state: { ...state, query: state.query + event.value, selectedEvent: 0, follow: false } }
    }
    return { kind: 'ignore' }
  }
  if (event.type === 'text') {
    if (event.value === '/') return { kind: 'update', state: { ...state, searchActive: true, query: '', focus: 'timeline' } }
    if (event.value === 'q') return { kind: 'close' }
    if (/^[1-7]$/u.test(event.value)) {
      const mode = MODES[Number(event.value) - 1] ?? 'overview'
      return { kind: 'update', state: { ...state, mode, selectedEvent: 0, follow: true, detailScroll: 0 } }
    }
    if (event.value === 'f') {
      const index = MODES.indexOf(state.mode)
      const mode = MODES[(index + 1) % MODES.length] ?? 'overview'
      return { kind: 'update', state: { ...state, mode, selectedEvent: 0, follow: true, detailScroll: 0 } }
    }
    if (event.value === 'l') {
      const rows = filteredTrajectoryRows(state)
      return { kind: 'update', state: { ...state, follow: !state.follow, selectedEvent: state.follow ? state.selectedEvent : Math.max(0, rows.length - 1) } }
    }
    if (event.value === 'r') return { kind: 'refresh', state: { ...state, loading: true, error: undefined } }
    if (event.value === 'c') {
      const row = selectedRow(state)
      return row === undefined
        ? { kind: 'ignore' }
        : { kind: 'copy', state, text: safeEventJson(row.event), label: `event #${row.seq}` }
    }
    return { kind: 'ignore' }
  }
  if (event.type !== 'key') return { kind: 'ignore' }
  if (event.id === 'escape' || event.id === 'ctrl+c') return { kind: 'close' }
  if (event.id === 'tab' || event.id === 'right') return { kind: 'update', state: { ...state, focus: nextFocus(state.focus, 1) } }
  if (event.id === 'shift+tab' || event.id === 'left') return { kind: 'update', state: { ...state, focus: nextFocus(state.focus, -1) } }
  if (event.id === 'enter' || event.id === 'ctrl+j') {
    if (state.focus === 'sessions') {
      const id = state.sessions[state.selectedSession]?.id
      return id === undefined ? { kind: 'ignore' } : { kind: 'inspect', state: { ...state, loading: true }, id }
    }
    return { kind: 'update', state: { ...state, focus: state.focus === 'timeline' ? 'details' : 'timeline' } }
  }
  const page = 10
  if (state.focus === 'sessions') {
    if (event.id === 'up') return moveSession(state, -1)
    if (event.id === 'down') return moveSession(state, 1)
    if (event.id === 'pageUp') return moveSession(state, -page)
    if (event.id === 'pageDown') return moveSession(state, page)
    if (event.id === 'home') return moveSession(state, -state.sessions.length)
    if (event.id === 'end') return moveSession(state, state.sessions.length)
  } else if (state.focus === 'timeline') {
    if (event.id === 'up') return { kind: 'update', state: moveEvent(state, -1) }
    if (event.id === 'down') return { kind: 'update', state: moveEvent(state, 1) }
    if (event.id === 'pageUp') return { kind: 'update', state: moveEvent(state, -page) }
    if (event.id === 'pageDown') return { kind: 'update', state: moveEvent(state, page) }
    if (event.id === 'home') return { kind: 'update', state: { ...state, selectedEvent: 0, follow: false, detailScroll: 0 } }
    if (event.id === 'end') {
      const rows = filteredTrajectoryRows(state)
      return { kind: 'update', state: { ...state, selectedEvent: Math.max(0, rows.length - 1), follow: true, detailScroll: 0 } }
    }
  } else {
    if (event.id === 'up') return { kind: 'update', state: { ...state, detailScroll: Math.max(0, state.detailScroll - 1) } }
    if (event.id === 'down') return { kind: 'update', state: { ...state, detailScroll: state.detailScroll + 1 } }
    if (event.id === 'pageUp') return { kind: 'update', state: { ...state, detailScroll: Math.max(0, state.detailScroll - page) } }
    if (event.id === 'pageDown') return { kind: 'update', state: { ...state, detailScroll: state.detailScroll + page } }
    if (event.id === 'home') return { kind: 'update', state: { ...state, detailScroll: 0 } }
  }
  return { kind: 'ignore' }
}

function paintTone(theme: Theme, tone: TrajectoryTone, value: string): string {
  if (tone === 'normal') return value
  if (tone === 'muted') return theme.fg('muted', value)
  return theme.fg(tone, value)
}

function fit(value: string, width: number): string {
  return padToWidth(truncateToWidth(value, Math.max(0, width)), Math.max(0, width))
}

function borderRow(theme: Theme, value: string, width: number): string {
  const inner = Math.max(0, width - 2)
  return theme.fg('border', BOX.vertical) + fit(value, inner) + theme.fg('border', BOX.vertical)
}

function topBorder(theme: Theme, title: string, width: number): string {
  const inner = Math.max(0, width - 2)
  const painted = theme.bold(theme.fg('accent', truncateToWidth(` ${title} `, inner)))
  const fill = Math.max(0, inner - visibleWidth(painted))
  return theme.fg('border', BOX.topLeft) + painted + theme.fg('border', BOX.horizontal.repeat(fill) + BOX.topRight)
}

function divider(theme: Theme, width: number): string {
  return theme.fg('border', BOX.teeRight + BOX.horizontal.repeat(Math.max(0, width - 2)) + BOX.teeLeft)
}

function bottomBorder(theme: Theme, width: number): string {
  return theme.fg('border', BOX.bottomLeft + BOX.horizontal.repeat(Math.max(0, width - 2)) + BOX.bottomRight)
}

function statusGlyph(session: TuiTrajectorySessionSummary, active: boolean, theme: Theme, spinnerFrame: number): string {
  if (active && (session.status === undefined || session.status === 'running')) {
    return theme.fg('accent', SPINNER[spinnerFrame % SPINNER.length] ?? SYMBOL.running)
  }
  if (/error|failed|aborted/iu.test(session.status ?? '')) return theme.fg('error', SYMBOL.error)
  if (/completed|done/iu.test(session.status ?? '')) return theme.fg('success', SYMBOL.success)
  return theme.fg('dim', session.parentSession === undefined ? '●' : '○')
}

function sessionLabel(session: TuiTrajectorySessionSummary): string {
  const depth = Math.max(0, session.delegationDepth ?? (session.parentSession === undefined ? 0 : 1))
  const branch = depth === 0 ? 'root ' : session.origin === 'subagent' ? 'agent ' : 'child '
  return `${'  '.repeat(Math.min(depth, 4))}${depth > 0 ? '└─ ' : ''}${branch}${session.title || session.id}`
}

function sessionRows(state: TrajectoryState, theme: Theme, width: number, height: number, spinnerFrame: number): string[] {
  if (height <= 0) return []
  if (state.sessions.length === 0) {
    return [theme.fg('muted', state.loading ? '  Loading durable sessions…' : '  No durable sessions.')]
  }
  const selected = Math.max(0, Math.min(state.selectedSession, state.sessions.length - 1))
  const start = Math.max(0, Math.min(selected - Math.floor(height / 2), Math.max(0, state.sessions.length - height)))
  const end = Math.min(state.sessions.length, start + height)
  const rows: string[] = []
  for (let index = start; index < end; index += 1) {
    const session = state.sessions[index]
    if (session === undefined) continue
    const active = session.id === state.activeSessionId
    const current = session.id === state.snapshot?.id
    const marker = index === selected && state.focus === 'sessions' ? theme.fg('accent', SYMBOL.cursor) : ' '
    const glyph = statusGlyph(session, active, theme, spinnerFrame)
    const suffix = [current ? 'open' : undefined, active ? 'live' : undefined, session.eventCount === undefined ? undefined : `${session.eventCount}`]
      .filter((value): value is string => value !== undefined).join(' · ')
    const bodyWidth = Math.max(1, width - 5 - (suffix === '' ? 0 : visibleWidth(suffix) + 2))
    const body = truncateToWidth(sessionLabel(session), bodyWidth)
    const fill = Math.max(1, width - visibleWidth(marker) - visibleWidth(glyph) - 2 - visibleWidth(body) - (suffix === '' ? 0 : visibleWidth(suffix)))
    const row = `${marker} ${glyph} ${body}${' '.repeat(fill)}${theme.fg('dim', suffix)}`
    rows.push(index === selected ? theme.inverse(row) : row)
  }
  if (state.sessions.length > height && rows.length > 0) {
    const position = theme.fg('dim', `${selected + 1}/${state.sessions.length}`)
    rows[rows.length - 1] = fit((rows[rows.length - 1] ?? '') + ' ' + position, width)
  }
  return rows.map(row => truncateToWidth(row, width))
}

function aggregateUsage(rows: readonly TrajectoryEventRow[]): string {
  let input = 0
  let output = 0
  let cache = 0
  for (const row of rows) {
    if (row.type !== 'assistant/message') continue
    const usage = record(eventData(row.event as EventLike).usage)
    input += number(usage.inputTokens) ?? 0
    output += number(usage.outputTokens) ?? 0
    cache += number(usage.cacheReadTokens) ?? 0
  }
  return [`in:${input}`, `out:${output}`, cache > 0 ? `cache:${cache}` : undefined].filter((value): value is string => value !== undefined).join(' · ')
}

function overviewRows(state: TrajectoryState, theme: Theme, width: number, height: number): string[] {
  if (height <= 0) return []
  const selected = selectedRow(state)
  const problems = state.rows.filter(row => row.problem).length
  const tools = state.rows.filter(row => row.tool).length
  const status = state.snapshot?.status ?? (state.loading ? 'refreshing' : 'snapshot')
  const lines = [
    truncateToWidth(`  Status: ${status} · ${state.rows.length} events · ${tools} tool events · ${problems} problems`, width),
    truncateToWidth(`  Usage: ${aggregateUsage(state.rows)} · sequence order (time is shown in details)`, width),
  ]
  const labelWidth = Math.min(15, Math.max(12, Math.floor(width * 0.2)))
  const barWidth = Math.max(1, width - labelWidth - 3)
  const lanes: readonly [TrajectoryLane, string, string][] = [
    ['conversation', 'Conversation', 'C'],
    ['execution', 'Execution', 'E'],
    ['orchestration', 'Orchestration', 'O'],
  ]
  for (const [lane, label, symbol] of lanes) {
    const cells = Array.from({ length: barWidth }, () => '─')
    for (let index = 0; index < state.rows.length; index += 1) {
      const row = state.rows[index]
      if (row?.lane !== lane) continue
      const cell = state.rows.length <= 1 ? 0 : Math.round(index * (barWidth - 1) / (state.rows.length - 1))
      cells[cell] = row.problem ? '!' : symbol
    }
    if (selected?.lane === lane) {
      const index = state.rows.findIndex(row => row.seq === selected.seq && row.type === selected.type)
      const cell = state.rows.length <= 1 ? 0 : Math.round(Math.max(0, index) * (barWidth - 1) / Math.max(1, state.rows.length - 1))
      cells[cell] = '◆'
    }
    const painted = cells.map(cell => cell === '◆' ? theme.fg('accent', cell) : cell === '!' ? theme.fg('error', cell) : theme.fg('dim', cell)).join('')
    lines.push(`${fit(theme.bold(label), labelWidth)} ${painted}`)
  }
  if (selected !== undefined) lines.push(truncateToWidth(`  Selected #${selected.seq} ${selected.type} · ${selected.summary}`, width))
  return lines.slice(0, height)
}

function flowRail(row: TrajectoryEventRow): string {
  const turn = row.turnId === undefined ? '' : `T${row.turnId}`
  const step = row.stepId === undefined ? '' : `S${row.stepId}`
  const call = row.callId === undefined ? '' : `C:${row.callId}`
  const run = row.runId === undefined ? '' : `R:${row.runId}`
  const ids = [turn, step, call, run].filter(Boolean).join('/')
  const joint = row.type.endsWith('/start') ? '┌' : row.type.endsWith('/end') ? '└' : ids === '' ? '·' : '│'
  return `${joint}${ids === '' ? ' flat' : ids}`
}

function eventRows(state: TrajectoryState, theme: Theme, width: number, height: number): string[] {
  if (height <= 0) return []
  if (state.mode === 'overview') return overviewRows(state, theme, width, height)
  const rows = filteredTrajectoryRows(state)
  if (rows.length === 0) {
    const message = state.loading ? 'Loading session events…' : state.error ?? 'No events match this view.'
    return [theme.fg(state.error === undefined ? 'muted' : 'error', '  ' + message)]
  }
  const selected = Math.max(0, Math.min(state.selectedEvent, rows.length - 1))
  const start = state.follow
    ? Math.max(0, rows.length - height)
    : Math.max(0, Math.min(selected - Math.floor(height / 2), Math.max(0, rows.length - height)))
  const end = Math.min(rows.length, start + height)
  const origin = number(record(state.snapshot?.events[0]).time) ?? rows[0]?.time ?? 0
  const visible: string[] = []
  for (let index = start; index < end; index += 1) {
    const row = rows[index]
    if (row === undefined) continue
    const active = index === selected
    const marker = active && state.focus === 'timeline' ? theme.fg('accent', SYMBOL.cursor) : ' '
    const elapsed = theme.fg('dim', relativeTime(row.time - origin))
    const glyph = paintTone(theme, row.tone, row.glyph)
    const railText = state.mode === 'flow' ? flowRail(row) : ''
    const labelText = railText === '' ? row.label : `${railText} ${row.label}`
    const labelWidth = Math.min(state.mode === 'flow' ? 28 : 18, Math.max(10, Math.floor(width * (state.mode === 'flow' ? 0.38 : 0.22))))
    const label = fit(paintTone(theme, row.tone, labelText), labelWidth)
    const summaryText = state.mode === 'changes' ? row.change ?? '' : row.summary
    const summaryWidth = Math.max(0, width - 2 - 6 - 2 - labelWidth - 1)
    const summary = truncateToWidth(paintTone(theme, row.tone === 'accent' ? 'normal' : row.tone, summaryText), summaryWidth)
    const line = `${marker} ${elapsed} ${glyph} ${label} ${summary}`
    visible.push(active ? theme.inverse(fit(line, width)) : fit(line, width))
  }
  return visible
}

function detailRows(state: TrajectoryState, theme: Theme, width: number, height: number): string[] {
  if (height <= 0) return []
  const row = selectedRow(state)
  if (row === undefined) return [theme.fg('muted', '  Select an event to inspect its payload.')]
  const heading = `${row.glyph} #${row.seq} · ${row.type} · ${clock(row.time)}`
  const raw = safeEventJson(row.event)
  const body = raw.split('\n').flatMap(line => wrapText(line, Math.max(1, width - 2)).map(part => '  ' + part))
  const maxStart = Math.max(0, body.length - Math.max(0, height - 1))
  const start = Math.max(0, Math.min(state.detailScroll, maxStart))
  const visible = body.slice(start, start + Math.max(0, height - 1)).map(line => theme.fg('muted', truncateToWidth(line, width)))
  if (start > 0 && visible.length > 0) visible[0] = theme.fg('dim', `  … ${start} earlier lines`)
  if (start + visible.length < body.length && visible.length > 0) visible[visible.length - 1] = theme.fg('dim', `  … ${body.length - start - visible.length} later lines`)
  return [paintTone(theme, row.tone, '  ' + heading), ...visible]
}

function panelHeader(label: string, active: boolean, meta: string, theme: Theme, width: number): string {
  const title = active ? theme.bold(theme.fg('accent', label)) : theme.bold(label)
  const suffix = meta === '' ? '' : theme.fg('dim', ' · ' + meta)
  return truncateToWidth(' ' + title + suffix, width)
}

function combineColumns(left: readonly string[], leftWidth: number, right: readonly string[], rightWidth: number, theme: Theme, height: number): string[] {
  const rows: string[] = []
  for (let index = 0; index < height; index += 1) {
    const lhs = fit(left[index] ?? '', leftWidth)
    const rhs = fit(right[index] ?? '', rightWidth)
    rows.push(lhs + theme.fg('borderMuted', BOX.vertical) + rhs)
  }
  return rows
}

/** Render the full-height responsive workspace. */
export function renderTrajectory(
  state: TrajectoryState,
  theme: Theme,
  width: number,
  height: number,
  appName = 'omdsh',
  spinnerFrame = 0,
): Frame {
  const pageWidth = Math.max(1, width)
  const pageHeight = Math.max(1, height)
  if (pageWidth < 28 || pageHeight < 10) {
    const lines = [
      theme.bold('Trajectory'),
      theme.fg('warning', 'Terminal is too small for the Trajectory workspace.'),
      theme.fg('dim', 'Resize to at least 28×10 · Esc close'),
    ]
    return { lines, cursor: { row: 0, column: 0 }, cursorVisible: false }
  }
  const selectedSession = state.sessions[state.selectedSession]
  const selectedTitle = state.snapshot?.title ?? selectedSession?.title ?? state.activeSessionId
  const filtered = filteredTrajectoryRows(state)
  const status = [
    state.mode,
    `${filtered.length}/${state.rows.length} events`,
    state.follow ? 'follow' : 'paused',
    state.loading ? 'refreshing' : undefined,
  ].filter((value): value is string => value !== undefined).join(' · ')
  const search = state.searchActive
    ? theme.fg('accent', '/ ') + state.query
    : theme.bold(truncateToWidth(selectedTitle, Math.max(1, pageWidth - 8))) + theme.fg('dim', ` · ${status}`)
  const lines: string[] = [
    topBorder(theme, `${appName} · Trajectory`, pageWidth),
    borderRow(theme, ' ' + search, pageWidth),
    divider(theme, pageWidth),
  ]
  const footerRows = 3
  const contentHeight = Math.max(1, pageHeight - lines.length - footerRows)
  const innerWidth = Math.max(1, pageWidth - 2)
  const wide = innerWidth >= 92

  let content: string[]
  if (wide) {
    const leftWidth = Math.max(26, Math.min(38, Math.floor(innerWidth * 0.28)))
    const rightWidth = Math.max(1, innerWidth - leftWidth - 1)
    const timelineHeight = Math.max(5, Math.floor(contentHeight * 0.58))
    const detailHeight = Math.max(1, contentHeight - timelineHeight - 1)
    const sessions = [
      panelHeader(state.mode === 'runs' ? 'Runs · root → descendants' : 'Conversation', state.focus === 'sessions', `${state.sessions.length} ${state.sessions.length === 1 ? 'run' : 'runs'}`, theme, leftWidth),
      ...sessionRows(state, theme, leftWidth, Math.max(0, contentHeight - 1), spinnerFrame),
    ]
    const timeline = [
      panelHeader('Timeline', state.focus === 'timeline', status, theme, rightWidth),
      ...eventRows(state, theme, rightWidth, Math.max(0, timelineHeight - 1)),
    ]
    while (timeline.length < timelineHeight) timeline.push('')
    timeline.push(theme.fg('borderMuted', BOX.horizontal.repeat(rightWidth)))
    timeline.push(panelHeader('Details', state.focus === 'details', '', theme, rightWidth))
    timeline.push(...detailRows(state, theme, rightWidth, Math.max(0, detailHeight - 1)))
    content = combineColumns(sessions, leftWidth, timeline, rightWidth, theme, contentHeight)
  } else if (state.focus === 'sessions') {
    content = [
      panelHeader(state.mode === 'runs' ? 'Runs · root → descendants' : 'Conversation', true, `${state.sessions.length} ${state.sessions.length === 1 ? 'run' : 'runs'}`, theme, innerWidth),
      ...sessionRows(state, theme, innerWidth, Math.max(0, contentHeight - 1), spinnerFrame),
    ]
  } else {
    const detailHeight = state.focus === 'details' ? Math.max(5, Math.floor(contentHeight * 0.5)) : Math.max(4, Math.floor(contentHeight * 0.34))
    const timelineHeight = Math.max(3, contentHeight - detailHeight - 1)
    content = [
      panelHeader('Timeline', state.focus === 'timeline', status, theme, innerWidth),
      ...eventRows(state, theme, innerWidth, Math.max(0, timelineHeight - 1)),
    ]
    while (content.length < timelineHeight) content.push('')
    content.push(theme.fg('borderMuted', BOX.horizontal.repeat(innerWidth)))
    content.push(panelHeader('Details', state.focus === 'details', '', theme, innerWidth))
    content.push(...detailRows(state, theme, innerWidth, Math.max(0, detailHeight - 1)))
  }
  content = content.slice(0, contentHeight)
  while (content.length < contentHeight) content.push('')
  lines.push(...content.map(line => borderRow(theme, line, pageWidth)))
  lines.push(divider(theme, pageWidth))
  const hints = state.searchActive
    ? 'Type to filter · Enter apply · Esc leave search · Ctrl+C close'
    : pageWidth >= 112
      ? 'Tab · ↑↓/wheel move · 1 overview · 2 flow · 3 runs · 4 tools · 5 changes · 6 problems · 7 raw · / search · f next · l follow · r refresh · c copy · q close'
      : '1 overview · 2 flow · 3 runs · 4 tools · 5 changes · 6 problems · 7 raw · / search · q close'
  lines.push(borderRow(theme, ' ' + theme.fg('dim', hints), pageWidth), bottomBorder(theme, pageWidth))
  return {
    lines: lines.slice(0, pageHeight),
    cursor: state.searchActive
      ? { row: 1, column: Math.min(pageWidth - 2, 4 + visibleWidth(state.query)) }
      : { row: 0, column: 0 },
    cursorVisible: state.searchActive,
  }
}
