import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TuiSessionManagerEntry } from '../definition.ts'
import { createTheme } from '../chrome/theme.ts'
import { stripAnsi, visibleWidth } from '../chrome/width.ts'
import type { KeyEvent } from '../input/keys.ts'
import {
  applySessionManagerEvent,
  createSessionManagerState,
  renderSessionManager,
  setSessionManagerSessions,
  setSessionManagerSnapshot,
  visibleManagerSessions,
} from './session-manager.ts'

const key = (id: string): KeyEvent => ({ type: 'key', id })
const typed = (value: string): KeyEvent => ({ type: 'text', value })

const rows: TuiSessionManagerEntry[] = [
  { id: 'session-a', title: 'Alpha deploy', preview: 'Ship alpha', cwd: '/work/alpha', createdAt: 10, updatedAt: 40, eventCount: 8, status: 'done' },
  { id: 'session-b', title: 'Beta research', preview: 'Read beta docs', cwd: '/work/beta', createdAt: 30, updatedAt: 35, eventCount: 5, status: 'interrupted' },
  { id: 'session-c', title: 'Gamma repair', cwd: '/work/alpha', createdAt: 20, updatedAt: 20, eventCount: 3, status: 'failed' },
]

function readyState() {
  return setSessionManagerSessions(createSessionManagerState('session-b'), rows)
}

describe('Session Manager state', () => {
  it('filters by search, status, and project and supports all sort modes', () => {
    const state = readyState()
    expect(visibleManagerSessions(state).map(row => row.id)).toEqual(['session-a', 'session-b', 'session-c'])
    expect(visibleManagerSessions({ ...state, query: 'beta' }).map(row => row.id)).toEqual(['session-b'])
    expect(visibleManagerSessions({ ...state, status: 'failed' }).map(row => row.id)).toEqual(['session-c'])
    expect(visibleManagerSessions({ ...state, project: 'alpha' }).map(row => row.id)).toEqual(['session-a', 'session-c'])
    expect(visibleManagerSessions({ ...state, sort: 'created' }).map(row => row.id)).toEqual(['session-b', 'session-c', 'session-a'])
    expect(visibleManagerSessions({ ...state, sort: 'title' }).map(row => row.id)).toEqual(['session-a', 'session-b', 'session-c'])
  })

  it('clamps navigation and emits only safe resume, copy, refresh, and close actions', () => {
    const state = { ...readyState(), selected: 0 }
    expect(applySessionManagerEvent(state, key('up'))).toMatchObject({ kind: 'update', state: { selected: 0 } })
    expect(applySessionManagerEvent(state, key('enter'))).toEqual({ kind: 'resume', id: 'session-a' })
    expect(applySessionManagerEvent(state, typed('c'))).toMatchObject({ kind: 'copy', text: 'session-a' })
    expect(applySessionManagerEvent(state, typed('r'))).toMatchObject({ kind: 'refresh' })
    expect(applySessionManagerEvent(state, key('delete'))).toEqual({ kind: 'ignore' })
    expect(applySessionManagerEvent(state, typed('q'))).toEqual({ kind: 'close' })
  })

  it('searches without closing on Escape and keeps selection by id after refresh', () => {
    let state = readyState()
    const search = applySessionManagerEvent(state, typed('/'))
    expect(search).toMatchObject({ kind: 'update', state: { searchActive: true } })
    if (search.kind !== 'update') throw new Error('search did not open')
    const filtered = applySessionManagerEvent(search.state, typed('gamma'))
    expect(filtered).toMatchObject({ kind: 'inspect', id: 'session-c' })
    if (filtered.kind !== 'inspect') throw new Error('search did not filter')
    expect(applySessionManagerEvent(filtered.state, key('escape'))).toMatchObject({ kind: 'update', state: { searchActive: false } })

    state = { ...state, selected: 1 }
    expect(setSessionManagerSessions(state, [...rows].reverse()).sessions).toHaveLength(3)
  })
})

describe('Session Manager rendering', () => {
  it('renders a bounded two-panel workspace with exact preview metadata', () => {
    const events = [{
      type: 'user/message', seq: 1, time: 1,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect the durable preview' }] },
    }] as SessionEvent[]
    const state = setSessionManagerSnapshot(readyState(), { ...rows[0]!, events })
    const frame = renderSessionManager(state, createTheme(false), 120, 30, 'omdsh')
    const text = stripAnsi(frame.lines.join('\n'))
    expect(frame.lines).toHaveLength(30)
    expect(frame.lines.every(line => visibleWidth(line) === 120)).toBe(true)
    expect(text).toContain('omdsh · Sessions')
    expect(text).toContain('Preview')
    expect(text).toContain('Inspect the durable preview')
    expect(text).toContain('Enter resume')
  })

  it('falls back to a single list on narrow terminals', () => {
    const frame = renderSessionManager(readyState(), createTheme(false), 70, 20)
    const text = stripAnsi(frame.lines.join('\n'))
    expect(frame.lines).toHaveLength(20)
    expect(text).toContain('Sessions · 3')
    expect(text).not.toContain(' Preview')
  })
})
