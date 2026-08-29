/** Full-screen durable session manager shared by /sessions and /resume. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TuiSessionManagerEntry, TuiSessionManagerSession } from '../definition.ts'
import type { Frame } from '../chrome/renderer.ts'
import { BOX, SPINNER, SYMBOL, type Theme } from '../chrome/theme.ts'
import { formatRelativeAge } from '../chrome/relative-time.ts'
import { padToWidth, truncateToWidth, visibleWidth, wrapText } from '../chrome/width.ts'
import type { KeyEvent } from '../input/keys.ts'

export type SessionManagerSort = 'recent' | 'created' | 'title'
export type SessionManagerStatus = 'all' | 'done' | 'interrupted' | 'blocked' | 'failed'

export interface SessionManagerState {
  readonly activeSessionId: string
  readonly sessions: readonly TuiSessionManagerEntry[]
  readonly selected: number
  readonly snapshot: TuiSessionManagerSession | undefined
  readonly query: string
  readonly searchActive: boolean
  readonly status: SessionManagerStatus
  readonly project: string | undefined
  readonly sort: SessionManagerSort
  readonly loading: boolean
  readonly hydrating: boolean
  readonly error: string | undefined
}

export type SessionManagerCommand =
  | { kind: 'update'; state: SessionManagerState }
  | { kind: 'inspect'; state: SessionManagerState; id: string }
  | { kind: 'refresh'; state: SessionManagerState }
  | { kind: 'copy'; state: SessionManagerState; text: string; label: string }
  | { kind: 'resume'; id: string }
  | { kind: 'close' }
  | { kind: 'ignore' }

const SortOrder: readonly SessionManagerSort[] = ['recent', 'created', 'title']
const StatusOrder: readonly SessionManagerStatus[] = ['all', 'done', 'interrupted', 'blocked', 'failed']

function sessionTime(session: TuiSessionManagerEntry): number {
  return session.updatedAt ?? session.createdAt
}

function projectKey(session: TuiSessionManagerEntry): string {
  return session.cwd?.replace(/\/+$/u, '') || 'unknown'
}

function projectName(session: TuiSessionManagerEntry): string {
  const project = projectKey(session)
  return project.split('/').at(-1) || project
}

export function sessionManagerProjects(state: SessionManagerState): string[] {
  const projects = [...new Set(state.sessions.map(projectKey))].sort((left, right) => left.localeCompare(right))
  const current = state.sessions.find(session => session.id === state.activeSessionId)
  if (current === undefined) return projects
  const activeProject = projectKey(current)
  return [activeProject, ...projects.filter(project => project !== activeProject)]
}

export function visibleManagerSessions(state: SessionManagerState): TuiSessionManagerEntry[] {
  const needle = state.query.trim().toLocaleLowerCase()
  const rows = state.sessions.filter((session) => {
    if (state.status !== 'all' && session.status !== state.status) return false
    if (state.project !== undefined && projectKey(session) !== state.project) return false
    if (needle === '') return true
    return [session.title, session.preview, session.id, session.cwd, session.status]
      .some(value => value?.toLocaleLowerCase().includes(needle) === true)
  })
  return [...rows].sort((left, right) => {
    if (state.sort === 'title') return left.title.localeCompare(right.title) || sessionTime(right) - sessionTime(left)
    if (state.sort === 'created') return right.createdAt - left.createdAt
    return sessionTime(right) - sessionTime(left)
  })
}

export function createSessionManagerState(activeSessionId: string): SessionManagerState {
  return {
    activeSessionId,
    sessions: [],
    selected: 0,
    snapshot: undefined,
    query: '',
    searchActive: false,
    status: 'all',
    project: undefined,
    sort: 'recent',
    loading: true,
    hydrating: false,
    error: undefined,
  }
}

export function setSessionManagerSessions(
  state: SessionManagerState,
  sessions: readonly TuiSessionManagerEntry[],
): SessionManagerState {
  const previous = visibleManagerSessions(state)[state.selected]?.id ?? state.snapshot?.id ?? state.activeSessionId
  const next = { ...state, sessions: sessions.map(session => ({ ...session })), loading: false, error: undefined }
  const rows = visibleManagerSessions(next)
  const selected = Math.max(0, rows.findIndex(session => session.id === previous))
  return { ...next, selected }
}

export function setSessionManagerSnapshot(
  state: SessionManagerState,
  snapshot: TuiSessionManagerSession,
): SessionManagerState {
  const { events: _events, ...entry } = snapshot
  const sessions = state.sessions.map(session => session.id === snapshot.id ? { ...session, ...entry } : session)
  const next = { ...state, sessions, snapshot, loading: false, error: undefined }
  const rows = visibleManagerSessions(next)
  return { ...next, selected: Math.max(0, rows.findIndex(session => session.id === snapshot.id)) }
}

export function setSessionManagerLoading(state: SessionManagerState, loading: boolean, error?: string): SessionManagerState {
  return { ...state, loading, ...(error === undefined ? { error: undefined } : { error }) }
}

export function setSessionManagerHydrating(state: SessionManagerState, hydrating: boolean): SessionManagerState {
  return { ...state, hydrating }
}

function selectedSession(state: SessionManagerState): TuiSessionManagerEntry | undefined {
  return visibleManagerSessions(state)[state.selected]
}

function moveSelection(state: SessionManagerState, delta: number): SessionManagerCommand {
  const rows = visibleManagerSessions(state)
  if (rows.length === 0) return { kind: 'ignore' }
  const selected = Math.max(0, Math.min(state.selected + delta, rows.length - 1))
  if (selected === state.selected) return { kind: 'update', state }
  const next = { ...state, selected, snapshot: rows[selected]?.id === state.snapshot?.id ? state.snapshot : undefined }
  return { kind: 'inspect', state: next, id: rows[selected]!.id }
}

function cycle<T>(items: readonly T[], current: T): T {
  const index = Math.max(0, items.indexOf(current))
  return items[(index + 1) % items.length] as T
}

function refilter(state: SessionManagerState, patch: Partial<SessionManagerState>): SessionManagerCommand {
  const next = { ...state, ...patch, selected: 0, snapshot: undefined }
  const first = visibleManagerSessions(next)[0]
  return first === undefined ? { kind: 'update', state: next } : { kind: 'inspect', state: next, id: first.id }
}

export function applySessionManagerEvent(state: SessionManagerState, event: KeyEvent, pageSize = 10): SessionManagerCommand {
  if (state.searchActive) {
    if (event.type === 'text') return refilter(state, { query: state.query + event.value })
    if (event.type !== 'key') return { kind: 'ignore' }
    if (event.id === 'escape') return { kind: 'update', state: { ...state, searchActive: false } }
    if (event.id === 'enter' || event.id === 'ctrl+j') return { kind: 'update', state: { ...state, searchActive: false } }
    if (event.id === 'backspace' || event.id === 'delete') return refilter(state, { query: state.query.slice(0, -1) })
    if (event.id === 'ctrl+c') return { kind: 'close' }
    return { kind: 'ignore' }
  }
  if (event.type === 'text') {
    if (event.value === '/') return { kind: 'update', state: { ...state, searchActive: true } }
    if (event.value === 'q') return { kind: 'close' }
    if (event.value === 'r') return { kind: 'refresh', state: { ...state, loading: true } }
    if (event.value === 's') return refilter(state, { sort: cycle(SortOrder, state.sort) })
    if (event.value === 'f') return refilter(state, { status: cycle(StatusOrder, state.status) })
    if (event.value === 'p') {
      const projects = sessionManagerProjects(state)
      const index = state.project === undefined ? -1 : projects.indexOf(state.project)
      return refilter(state, { project: index < 0 ? projects[0] : projects[index + 1] })
    }
    if (event.value === 'c') {
      const selected = selectedSession(state)
      return selected === undefined ? { kind: 'ignore' } : { kind: 'copy', state, text: selected.id, label: 'session id' }
    }
    return { kind: 'ignore' }
  }
  if (event.type !== 'key') return { kind: 'ignore' }
  if (event.id === 'escape' || event.id === 'ctrl+c') return { kind: 'close' }
  if (event.id === 'up' || event.id === 'shift+tab') return moveSelection(state, -1)
  if (event.id === 'down' || event.id === 'tab') return moveSelection(state, 1)
  if (event.id === 'pageUp') return moveSelection(state, -Math.max(1, pageSize))
  if (event.id === 'pageDown') return moveSelection(state, Math.max(1, pageSize))
  if (event.id === 'home') return moveSelection(state, -state.sessions.length)
  if (event.id === 'end') return moveSelection(state, state.sessions.length)
  if (event.id === 'enter' || event.id === 'ctrl+j') {
    const selected = selectedSession(state)
    return selected === undefined ? { kind: 'ignore' } : { kind: 'resume', id: selected.id }
  }
  return { kind: 'ignore' }
}

function fit(text: string, width: number): string {
  return padToWidth(truncateToWidth(text, Math.max(0, width)), Math.max(0, width))
}

function borderRow(theme: Theme, content: string, width: number): string {
  return theme.fg('border', BOX.vertical) + fit(content, Math.max(0, width - 2)) + theme.fg('border', BOX.vertical)
}

function topBorder(theme: Theme, title: string, width: number): string {
  const inner = Math.max(0, width - 2)
  const painted = theme.bold(theme.fg('accent', truncateToWidth(` ${title} `, inner)))
  return theme.fg('border', BOX.topLeft) + painted + theme.fg('border', BOX.horizontal.repeat(Math.max(0, inner - visibleWidth(painted))) + BOX.topRight)
}

function divider(theme: Theme, width: number): string {
  return theme.fg('border', BOX.teeRight + BOX.horizontal.repeat(Math.max(0, width - 2)) + BOX.teeLeft)
}

function bottomBorder(theme: Theme, width: number): string {
  return theme.fg('border', BOX.bottomLeft + BOX.horizontal.repeat(Math.max(0, width - 2)) + BOX.bottomRight)
}

function statusGlyph(session: TuiSessionManagerEntry, active: boolean, theme: Theme, spinnerFrame: number): string {
  if (active) return theme.fg('accent', SPINNER[spinnerFrame % SPINNER.length] ?? SYMBOL.running)
  if (session.status === 'done') return theme.fg('success', SYMBOL.success)
  if (session.status === 'failed') return theme.fg('error', SYMBOL.error)
  if (session.status === 'blocked') return theme.fg('warning', '◆')
  return theme.fg('dim', '●')
}

function listRows(state: SessionManagerState, theme: Theme, width: number, height: number, spinnerFrame: number): string[] {
  const sessions = visibleManagerSessions(state)
  if (sessions.length === 0) return [theme.fg('muted', state.loading ? '  Loading sessions…' : '  No sessions match the filters.')]
  const selected = Math.max(0, Math.min(state.selected, sessions.length - 1))
  const start = Math.max(0, Math.min(selected - Math.floor(height / 2), Math.max(0, sessions.length - height)))
  return sessions.slice(start, start + height).map((session, offset) => {
    const index = start + offset
    const active = session.id === state.activeSessionId
    const marker = index === selected ? theme.fg('accent', SYMBOL.cursor) : ' '
    const glyph = statusGlyph(session, active, theme, spinnerFrame)
    const suffix = `${formatRelativeAge(sessionTime(session))} · ${projectName(session)} · ${index + 1}/${sessions.length}`
    const bodyWidth = Math.max(1, width - 6 - visibleWidth(suffix))
    const body = truncateToWidth(session.title || session.id, bodyWidth)
    const row = `${marker} ${glyph} ${fit(body, bodyWidth)} ${theme.fg('dim', suffix)}`
    return index === selected ? theme.inverse(fit(row, width)) : fit(row, width)
  })
}

function eventText(event: SessionEvent): { role: string; text: string } | undefined {
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return undefined
  const data = event.data as unknown as {
    content?: readonly { type?: string; text?: string }[]
    message?: { content?: readonly { type?: string; text?: string }[] }
  }
  const content = data.content ?? data.message?.content ?? []
  const text = content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n').trim()
  if (text === '') return undefined
  return { role: event.type === 'user/message' ? 'You' : 'Assistant', text }
}

function previewRows(state: SessionManagerState, theme: Theme, width: number, height: number): string[] {
  const selected = selectedSession(state)
  if (selected === undefined) return [theme.fg('muted', '  Select a session.')]
  const snapshot = state.snapshot?.id === selected.id ? state.snapshot : undefined
  const values = [
    theme.bold('  ' + (snapshot?.title ?? selected.title)),
    '',
    theme.fg('dim', `  ID       ${selected.id}`),
    theme.fg('dim', `  Project  ${projectName(selected)}`),
    theme.fg('dim', `  Path     ${selected.cwd ?? 'unknown'}`),
    theme.fg('dim', `  Status   ${selected.id === state.activeSessionId ? 'active' : selected.status ?? 'unknown'}`),
    theme.fg('dim', `  Created  ${formatRelativeAge(selected.createdAt)}`),
    theme.fg('dim', `  Updated  ${formatRelativeAge(selected.updatedAt ?? selected.createdAt)}`),
    theme.fg('dim', `  Events   ${snapshot?.eventCount ?? selected.eventCount ?? 'unknown'}`),
  ]
  const messages = (snapshot?.events ?? []).map(eventText).filter((row): row is { role: string; text: string } => row !== undefined).slice(-4)
  if (messages.length === 0) {
    const preview = snapshot?.preview ?? selected.preview
    values.push('', ...(preview === undefined ? [theme.fg('muted', '  Loading preview…')] : wrapText(preview, Math.max(1, width - 4)).map(line => '  ' + line)))
  } else {
    values.push('', theme.bold('  Recent messages'))
    for (const message of messages) {
      values.push(theme.fg(message.role === 'You' ? 'accent' : 'muted', `  ${message.role}`))
      values.push(...wrapText(message.text, Math.max(1, width - 4)).slice(0, 3).map(line => '  ' + line))
    }
  }
  if (state.error !== undefined) values.push('', theme.fg('error', '  ' + state.error))
  return values.slice(0, height).map(line => truncateToWidth(line, width))
}

function combineColumns(left: readonly string[], leftWidth: number, right: readonly string[], rightWidth: number, theme: Theme, height: number): string[] {
  return Array.from({ length: height }, (_, index) => fit(left[index] ?? '', leftWidth) + theme.fg('borderMuted', BOX.vertical) + fit(right[index] ?? '', rightWidth))
}

export function renderSessionManager(
  state: SessionManagerState,
  theme: Theme,
  width: number,
  height: number,
  appName = 'omdsh',
  spinnerFrame = 0,
): Frame {
  const pageWidth = Math.max(1, width)
  const pageHeight = Math.max(1, height)
  if (pageWidth < 28 || pageHeight < 10) {
    return { lines: [theme.bold('Sessions'), theme.fg('warning', 'Terminal is too small.'), theme.fg('dim', 'Resize to at least 28×10 · Esc close')], cursorVisible: false }
  }
  const sessions = visibleManagerSessions(state)
  const selected = sessions[state.selected]
  const filter = [state.status, state.project ?? 'all projects', state.sort, `${sessions.length}/${state.sessions.length}`].join(' · ')
  const heading = state.searchActive ? theme.fg('accent', '/ ') + state.query : theme.bold(truncateToWidth(selected?.title ?? 'Sessions', Math.max(1, pageWidth - 8)))
  const lines = [
    topBorder(theme, `${appName} · Sessions`, pageWidth),
    borderRow(theme, ` ${heading}${theme.fg('dim', ` · ${filter}${state.loading ? ' · refreshing' : ''}${state.hydrating ? ' · indexing metadata' : ''}`)}`, pageWidth),
    divider(theme, pageWidth),
  ]
  const contentHeight = Math.max(1, pageHeight - 6)
  const innerWidth = Math.max(1, pageWidth - 2)
  let content: string[]
  if (innerWidth >= 84) {
    const leftWidth = Math.max(34, Math.min(52, Math.floor(innerWidth * 0.43)))
    const rightWidth = Math.max(1, innerWidth - leftWidth - 1)
    content = combineColumns(
      [theme.bold(theme.fg('accent', ` Sessions · ${sessions.length}`)), ...listRows(state, theme, leftWidth, contentHeight - 1, spinnerFrame)],
      leftWidth,
      [theme.bold(' Preview'), ...previewRows(state, theme, rightWidth, contentHeight - 1)],
      rightWidth,
      theme,
      contentHeight,
    )
  } else {
    content = [theme.bold(theme.fg('accent', ` Sessions · ${sessions.length}`)), ...listRows(state, theme, innerWidth, contentHeight - 1, spinnerFrame)]
  }
  while (content.length < contentHeight) content.push('')
  lines.push(...content.slice(0, contentHeight).map(line => borderRow(theme, line, pageWidth)))
  lines.push(divider(theme, pageWidth))
  const hints = state.searchActive
    ? 'Type to filter · Enter apply · Esc leave search · Ctrl+C close'
    : pageWidth >= 105
      ? '↑↓ move · Enter resume · / search · f status · p project · s sort · r refresh · c copy ID · q close'
      : 'Enter resume · / search · f/p filters · s sort · r refresh · c copy · q close'
  lines.push(borderRow(theme, ' ' + theme.fg('dim', hints), pageWidth), bottomBorder(theme, pageWidth))
  return {
    lines: lines.slice(0, pageHeight),
    cursor: state.searchActive ? { row: 1, column: Math.min(pageWidth - 2, 4 + visibleWidth(state.query)) } : { row: 0, column: 0 },
    cursorVisible: state.searchActive,
  }
}
