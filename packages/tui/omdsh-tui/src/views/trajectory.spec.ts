import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createTheme } from '../chrome/theme.ts'
import { stripAnsi, visibleWidth } from '../chrome/width.ts'
import type { KeyEvent } from '../input/keys.ts'
import type { TuiTrajectorySession } from '../definition.ts'
import {
  applyTrajectoryEvent,
  buildTrajectoryRows,
  createTrajectoryState,
  filteredTrajectoryRows,
  orderTrajectorySessions,
  parseTrajectoryOptions,
  renderTrajectory,
  setTrajectorySessions,
  setTrajectorySnapshot,
} from './trajectory.ts'

const key = (id: string): KeyEvent => ({ type: 'key', id })
const typed = (value: string): KeyEvent => ({ type: 'text', value })
const event = (type: string, seq: number, time: number, data: unknown): SessionEvent => ({ type, seq, time, data }) as SessionEvent

const events: SessionEvent[] = [
  event('turn/start', 0, 1_000, { turn: 1 }),
  event('user/message', 1, 1_010, { source: { kind: 'user' }, content: [{ type: 'text', text: 'Ship the terminal trajectory' }] }),
  event('step/start', 2, 1_020, { turn: 1, step: 1 }),
  event('tool/call', 3, 1_030, { callId: 'call-1', name: 'bash', arguments: '{"command":"pnpm test"}' }),
  event('tool/result', 4, 1_080, {
    message: {
      source: { callId: 'call-1' },
      content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: '37 tests passed' }] }],
    },
  }),
  event('assistant/message', 5, 1_100, {
    message: { source: { provider: 'openai', model: 'gpt' }, content: [{ type: 'text', text: 'Implemented.' }] },
    usage: { inputTokens: 100, outputTokens: 20 },
  }),
  event('step/end', 6, 1_110, { turn: 1, step: 1 }),
  event('turn/end', 7, 1_120, { turn: 1, reason: { kind: 'completed' } }),
  event('llm/retry', 8, 1_130, { reason: 'temporary transport error' }),
]

function snapshot(): TuiTrajectorySession {
  return {
    id: 'root',
    title: 'Terminal trajectory',
    cwd: '/repo',
    updatedAt: 1_130,
    eventCount: events.length,
    events,
  }
}

function readyState() {
  const listed = setTrajectorySessions(createTrajectoryState('root'), [
    { id: 'other', title: 'Other root', updatedAt: 900 },
    { id: 'child', title: 'Review child', parentSession: 'root', delegationDepth: 1, updatedAt: 1_120 },
    { id: 'root', title: 'Terminal trajectory', updatedAt: 1_130 },
  ])
  return setTrajectorySnapshot(listed, snapshot())
}

describe('Trajectory projection', () => {
  it('parses screen aliases, filters, and explicit bounded history limits', () => {
    expect(parseTrajectoryOptions('screen errors 250')).toEqual({ mode: 'errors', limit: 250 })
    expect(parseTrajectoryOptions('tools')).toEqual({ mode: 'tools' })
    expect(() => parseTrajectoryOptions('unknown')).toThrow(/Usage: \/trajectory/u)
    expect(() => parseTrajectoryOptions('10001')).toThrow(/between 1 and 10000/u)
  })

  it('projects readable model, tool, turn, and failure rows', () => {
    const rows = buildTrajectoryRows(events)
    expect(rows.map(row => row.label)).toContain('You')
    expect(rows.find(row => row.label === 'bash')?.summary).toContain('pnpm test')
    expect(rows.find(row => row.label === 'Result')?.summary).toContain('37 tests passed')
    expect(rows.find(row => row.label === 'Assistant')?.summary).toContain('openai/gpt')
    expect(rows.find(row => row.label === 'Retry')?.error).toBe(true)
  })

  it('keeps descendants directly below their durable parent', () => {
    const ordered = orderTrajectorySessions([
      { id: 'child', title: 'Child', parentSession: 'root', updatedAt: 30 },
      { id: 'other', title: 'Other', updatedAt: 20 },
      { id: 'root', title: 'Root', updatedAt: 10 },
    ])
    expect(ordered.map(session => session.id)).toEqual(['other', 'root', 'child'])
  })

  it('cycles filters and applies an in-workspace search', () => {
    let state = readyState()
    const tools = applyTrajectoryEvent(state, typed('f'))
    expect(tools.kind).toBe('update')
    state = tools.kind === 'update' ? tools.state : state
    expect(state.mode).toBe('all')
    state = { ...state, mode: 'tools' }
    expect(filteredTrajectoryRows(state).map(row => row.label)).toEqual(['bash', 'Result'])

    const search = applyTrajectoryEvent(state, typed('/'))
    state = search.kind === 'update' ? search.state : state
    for (const value of 'passed') {
      const update = applyTrajectoryEvent(state, typed(value))
      state = update.kind === 'update' ? update.state : state
    }
    expect(filteredTrajectoryRows(state).map(row => row.label)).toEqual(['Result'])
    expect(applyTrajectoryEvent(state, key('ctrl+c'))).toEqual({ kind: 'close' })
  })
})

describe('renderTrajectory', () => {
  it('renders a bounded wide session tree, timeline, details, and hotkeys', () => {
    const frame = renderTrajectory(readyState(), createTheme(false), 120, 32, 'omdsh', 0)
    const output = frame.lines.map(stripAnsi).join('\n')
    expect(frame.lines).toHaveLength(32)
    expect(frame.lines.every(line => visibleWidth(line) <= 120)).toBe(true)
    expect(output).toContain('omdsh · Trajectory')
    expect(output).toContain('Sessions')
    expect(output).toContain('Review child')
    expect(output).toContain('Timeline')
    expect(output).toContain('Ship the terminal trajectory')
    expect(output).toContain('Tab panes')
  })

  it('switches to a focused session page at narrow widths', () => {
    const frame = renderTrajectory(readyState(), createTheme(false), 70, 22)
    const output = frame.lines.map(stripAnsi).join('\n')
    expect(frame.lines).toHaveLength(22)
    expect(output).toContain('Sessions')
    expect(output).toContain('Review child')
    expect(output).not.toContain('Timeline')
  })
})
