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
  trajectoryPaneAt,
} from './trajectory.ts'

const key = (id: string): KeyEvent => ({ type: 'key', id })
const typed = (value: string): KeyEvent => ({ type: 'text', value })
const event = (type: string, seq: number, time: number, data: unknown): SessionEvent => ({ type, seq, time, data }) as SessionEvent

const events: SessionEvent[] = [
  event('turn/start', 0, 1_000, { turn: 1 }),
  event('user/message', 1, 1_010, { turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: 'Ship the terminal trajectory' }] }),
  event('step/start', 2, 1_020, { turn: 1, step: 1 }),
  event('tool/call', 3, 1_030, { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"pnpm test"}' }),
  event('tool/result', 4, 1_080, {
    message: {
      source: { callId: 'call-1' },
      content: [{
        type: 'tool-result',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: '37 tests passed' }],
        metadata: { changes: [{ status: 'modified', path: 'src/trajectory.ts' }] },
      }],
    },
  }),
  event('assistant/message', 5, 1_100, {
    turn: 1,
    step: 1,
    message: { source: { provider: 'openai', model: 'gpt' }, content: [{ type: 'text', text: 'Implemented.' }, { type: 'reasoning', text: 'private chain' }] },
    usage: { inputTokens: 100, outputTokens: 20 },
  }),
  event('step/end', 6, 1_110, { turn: 1, step: 1 }),
  event('turn/end', 7, 1_120, { turn: 1, reason: { kind: 'completed' } }),
  event('llm/retry', 8, 1_130, { reason: 'temporary transport error' }),
  event('assistant/chunk', 9, 1_140, { reasoning: 'must stay private', chunk: { type: 'reasoning', text: 'hidden' } }),
]

function snapshot(sourceEvents = events): TuiTrajectorySession {
  return {
    id: 'root',
    title: 'Terminal trajectory',
    cwd: '/repo',
    updatedAt: sourceEvents.at(-1)?.time,
    eventCount: sourceEvents.length,
    events: sourceEvents,
  }
}

function readyState() {
  const listed = setTrajectorySessions(createTrajectoryState('root'), [
    { id: 'other', title: 'Other root', updatedAt: 900 },
    { id: 'child', title: 'Review child', origin: 'subagent', parentSession: 'root', delegationDepth: 1, updatedAt: 1_120 },
    { id: 'root', title: 'Terminal trajectory', updatedAt: 1_130 },
  ])
  return setTrajectorySnapshot(listed, snapshot())
}

/** Two steps where a read result grows the prompt from 4.1K to 90.9K tokens. */
const growthEvents: SessionEvent[] = [
  event('turn/start', 0, 1_000, { turn: 1 }),
  event('step/start', 1, 1_010, { turn: 1, step: 1 }),
  event('tool/call', 2, 1_020, { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"src/bridge.go"}' }),
  event('tool/result', 3, 1_060, { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'baseline body' }] }] } }),
  event('assistant/message', 4, 1_100, {
    turn: 1,
    step: 1,
    message: { source: { provider: 'openai', model: 'gpt' }, content: [{ type: 'text', text: 'baseline' }] },
    usage: { inputTokens: 4_000, outputTokens: 100 },
  }),
  event('step/end', 5, 1_110, { turn: 1, step: 1 }),
  event('step/start', 6, 1_120, { turn: 1, step: 2 }),
  event('tool/call', 7, 1_130, { turn: 1, step: 2, callId: 'c2', name: 'read', arguments: '{"file_path":"bridge.go"}' }),
  event('tool/result', 8, 1_200, { message: { content: [{ type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'huge body' }] }] } }),
  event('assistant/message', 9, 1_300, {
    turn: 1,
    step: 2,
    message: { source: { provider: 'openai', model: 'gpt' }, content: [{ type: 'text', text: 'grown' }] },
    usage: { inputTokens: 90_000, outputTokens: 900 },
  }),
  event('step/end', 10, 1_310, { turn: 1, step: 2 }),
]

function growthState(mode: 'flow' | 'overview' | 'raw' = 'flow') {
  return setTrajectorySnapshot(createTrajectoryState('root', { mode }), snapshot(growthEvents))
}

describe('Trajectory projection', () => {
  it('parses canonical modes, legacy aliases, and bounded limits', () => {
    const modes = ['overview', 'flow', 'runs', 'tools', 'changes', 'problems', 'raw'] as const
    for (const mode of modes) expect(parseTrajectoryOptions(mode)).toEqual({ mode })
    expect(parseTrajectoryOptions('screen errors 250')).toEqual({ mode: 'problems', limit: 250 })
    expect(parseTrajectoryOptions('summary')).toEqual({ mode: 'overview' })
    expect(parseTrajectoryOptions('all')).toEqual({ mode: 'raw' })
    expect(() => parseTrajectoryOptions('unknown')).toThrow(/Usage: \/trajectory/u)
    expect(() => parseTrajectoryOptions('10001')).toThrow(/between 1 and 10000/u)
  })

  it('projects explicit rails, safe confirmed changes, problems, and raw chunks', () => {
    const rows = buildTrajectoryRows(events)
    expect(rows.find(row => row.type === 'tool/lifecycle')).toMatchObject({
      lane: 'execution',
      label: 'bash',
      callId: 'call-1',
      status: 'completed',
      durationMs: 50,
      sourceSeqs: [3, 4],
    })
    expect(rows.find(row => row.type === 'tool/lifecycle')?.change).toContain('modified src/trajectory.ts')
    expect(rows.find(row => row.label === 'Retry')).toMatchObject({ problem: true, lane: 'orchestration' })
    expect(rows.some(row => row.type === 'assistant/chunk')).toBe(true)
    expect(rows.find(row => row.type === 'assistant/message')?.summary).not.toContain('private chain')
  })

  it('keeps problem classification explicit instead of guessing from event names', () => {
    const rows = buildTrajectoryRows([
      event('llm/retry', 1, 1, { reason: 'busy' }),
      event('assistant/message', 2, 2, { interrupted: true, message: { content: [] } }),
      event('not-an-error-looking-name', 3, 3, {}),
      event('turn/end', 4, 4, { turn: 1, reason: { kind: 'max-tokens' } }),
    ])
    expect(rows.filter(row => row.problem).map(row => row.seq)).toEqual([1, 2, 4])
  })

  it('shows changes only from whitelisted tool-result metadata', () => {
    const rows = buildTrajectoryRows([
      event('tool/result', 1, 1, { message: { content: [{ type: 'tool-result', toolCallId: 'a', content: [{ type: 'text', text: 'wrote file' }] }] }, guessedDiff: 'not trusted' }),
      event('tool/result', 2, 2, { metadata: { patch: '@@ -old +new' }, message: { content: [{ type: 'tool-result', toolCallId: 'b', content: [] }] } }),
      event('tool/result', 3, 3, { meta: { changes: [{ status: 'modified', path: 'src/current.ts' }] }, message: { content: [{ type: 'tool-result', toolCallId: 'c', content: [] }] } }),
    ])
    expect(rows[0]?.change).toBeUndefined()
    expect(rows[1]?.change).toContain('@@ -old +new')
    expect(rows[2]?.change).toContain('modified src/current.ts')
  })

  it('keeps Raw one-to-one while human modes use exact semantic lifecycle rows', () => {
    const source = [
      event('tool/call', 1, 1_000, { callId: 'c1', name: 'bash', arguments: '{"command":"pnpm test"}' }),
      event('tool/result', 2, 1_250, { message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '144 passed' }] }] } }),
      event('tool/result', 3, 1_300, { message: { content: [{ type: 'tool-result', toolCallId: 'orphan', content: [] }] } }),
    ]
    const state = setTrajectorySnapshot(createTrajectoryState('root', { mode: 'tools' }), snapshot(source))
    expect(state.rawRows.map(row => row.type)).toEqual(['tool/call', 'tool/result', 'tool/result'])
    expect(state.rows[0]).toMatchObject({ type: 'tool/lifecycle', label: 'bash', durationMs: 250, sourceSeqs: [1, 2] })
    expect(state.rows[1]?.diagnostic).toContain('unmatched tool end')
    expect(filteredTrajectoryRows({ ...state, query: 'status:completed tool:bash' })).toHaveLength(1)
  })

  it('measures context growth against the previous assistant step and names its tool', () => {
    const rows = buildTrajectoryRows(growthEvents)
    expect(rows.find(row => row.seq === 4)?.growthTokens).toBeUndefined()
    expect(rows.find(row => row.seq === 9)).toMatchObject({
      growthTokens: 86_800,
      growthSource: 'read bridge.go',
    })
  })

  it('counts prompt-side cache buckets in the step context size', () => {
    const rows = buildTrajectoryRows([
      event('assistant/message', 0, 1, { usage: { inputTokens: 1_000, outputTokens: 100 } }),
      event('tool/call', 1, 2, { callId: 'c1', name: 'bash', arguments: '{"command":"pnpm test"}' }),
      event('assistant/message', 2, 3, { usage: { inputTokens: 2_000, cacheReadTokens: 50_000, cacheWriteTokens: 1_000, outputTokens: 500 } }),
    ])
    expect(rows.find(row => row.seq === 2)).toMatchObject({
      growthTokens: 52_400,
      growthSource: 'bash pnpm test',
    })
  })

  it('leaves small or proportionally tiny growth without an annotation', () => {
    const small = buildTrajectoryRows([
      event('tool/call', 0, 1, { callId: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' }),
      event('assistant/message', 1, 2, { usage: { inputTokens: 4_000, outputTokens: 100 } }),
      event('tool/call', 2, 3, { callId: 'c2', name: 'read', arguments: '{"file_path":"b.ts"}' }),
      event('assistant/message', 3, 4, { usage: { inputTokens: 4_500, outputTokens: 100 } }),
    ])
    expect(small.find(row => row.seq === 3)?.growthTokens).toBeUndefined()
    // 3K inside a 200K prompt is real growth, but not one worth a row annotation.
    const diluted = buildTrajectoryRows([
      event('tool/call', 0, 1, { callId: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' }),
      event('assistant/message', 1, 2, { usage: { inputTokens: 200_000, outputTokens: 100 } }),
      event('tool/call', 2, 3, { callId: 'c2', name: 'read', arguments: '{"file_path":"b.ts"}' }),
      event('assistant/message', 3, 4, { usage: { inputTokens: 203_000, outputTokens: 100 } }),
    ])
    expect(diluted.find(row => row.seq === 3)?.growthTokens).toBeUndefined()
  })

  it('keeps steps without usage or without a preceding tool stable', () => {
    const rows = buildTrajectoryRows([
      event('tool/call', 0, 1, { callId: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' }),
      event('assistant/message', 1, 2, { usage: { inputTokens: 4_000, outputTokens: 100 } }),
      event('assistant/message', 2, 3, { message: { content: [{ type: 'text', text: 'no usage' }] } }),
      event('turn/start', 3, 4, { turn: 2 }),
      event('user/message', 4, 5, { turn: 2, source: { kind: 'user' }, content: [{ type: 'text', text: 'next prompt' }] }),
      event('assistant/message', 5, 6, { usage: { inputTokens: 120_000, outputTokens: 900 } }),
    ])
    expect(rows.find(row => row.seq === 2)?.growthSource).toBeUndefined()
    // A new turn and its prompt, not the stale read, caused this growth.
    expect(rows.find(row => row.seq === 5)?.growthTokens).toBeUndefined()
    // A compaction rewrote the prompt, so the pre-compaction tool is no longer its source.
    const compacted = buildTrajectoryRows([
      event('tool/call', 0, 1, { callId: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' }),
      event('assistant/message', 1, 2, { usage: { inputTokens: 10_000, outputTokens: 100 } }),
      event('compaction/start', 2, 3, { compactionId: 'k1' }),
      event('compaction/end', 3, 4, { compactionId: 'k1' }),
      event('assistant/message', 4, 5, { usage: { inputTokens: 40_000, outputTokens: 400 } }),
    ])
    expect(compacted.find(row => row.seq === 4)?.growthTokens).toBeUndefined()
  })

  it('flags a step that re-read a large reusable prompt without a cache hit', () => {
    const rows = buildTrajectoryRows([
      event('assistant/message', 0, 1, { usage: { inputTokens: 100, outputTokens: 200, cacheReadTokens: 150_000 } }),
      event('assistant/message', 1, 2, { usage: { inputTokens: 150_800, outputTokens: 200, cacheReadTokens: 0 } }),
    ])
    expect(rows.find(row => row.seq === 0)?.cacheMissTokens).toBeUndefined()
    expect(rows.find(row => row.seq === 1)?.cacheMissTokens).toBe(150_300)
    expect(rows.find(row => row.seq === 1)?.summary).toContain('cold:150K')
  })

  it('states the freed context next to a compaction summary', () => {
    const rows = buildTrajectoryRows([
      event('compaction/start', 0, 1, { compactionId: 'k1' }),
      event('compaction/summary', 1, 2, { compactionId: 'k1', shadowedTokenCount: 96_000, summary: [{ type: 'text', text: 'kept the plan and open files' }] }),
    ])
    expect(rows.find(row => row.seq === 1)?.summary).toBe('freed 96K tokens · kept the plan and open files')
  })

  it('keeps descendants directly below their durable parent', () => {
    const ordered = orderTrajectorySessions([
      { id: 'child', title: 'Child', parentSession: 'root', updatedAt: 30 },
      { id: 'other', title: 'Other', updatedAt: 20 },
      { id: 'root', title: 'Root', updatedAt: 10 },
    ])
    expect(ordered.map(session => session.id)).toEqual(['other', 'root', 'child'])
  })

  it('maps keys 1-7, cycles modes, searches, and disables follow on manual scroll', () => {
    let state = readyState()
    const modes = ['overview', 'flow', 'runs', 'tools', 'changes', 'problems', 'raw'] as const
    for (let index = 0; index < modes.length; index += 1) {
      const command = applyTrajectoryEvent(state, typed(String(index + 1)))
      expect(command.kind).toBe('update')
      state = command.kind === 'update' ? command.state : state
      expect(state.mode).toBe(modes[index])
    }
    const cycle = applyTrajectoryEvent(state, typed('f'))
    state = cycle.kind === 'update' ? cycle.state : state
    expect(state.mode).toBe('overview')

    const search = applyTrajectoryEvent(state, typed('/'))
    state = search.kind === 'update' ? search.state : state
    for (const value of 'passed') {
      const update = applyTrajectoryEvent(state, typed(value))
      state = update.kind === 'update' ? update.state : state
    }
    expect(filteredTrajectoryRows(state).map(row => row.label)).toEqual(['bash'])
    expect(state.follow).toBe(false)
    expect(applyTrajectoryEvent(state, key('ctrl+c'))).toEqual({ kind: 'close' })
  })

  it('preserves a paused event by stable seq/type across snapshot refresh', () => {
    let state = readyState()
    const raw = applyTrajectoryEvent(state, typed('7'))
    state = raw.kind === 'update' ? { ...raw.state, focus: 'timeline' } : state
    const up = applyTrajectoryEvent(state, key('up'))
    state = up.kind === 'update' ? up.state : state
    expect(state.follow).toBe(false)
    const before = filteredTrajectoryRows(state)[state.selectedEvent]
    state = setTrajectorySnapshot(state, snapshot([...events, event('goal/change', 10, 1_150, { phase: 'active' })]))
    const after = filteredTrajectoryRows(state)[state.selectedEvent]
    expect({ seq: after?.seq, type: after?.type }).toEqual({ seq: before?.seq, type: before?.type })
    expect(state.follow).toBe(false)
  })

  it('routes wheel by pane geometry, including blank pane space', () => {
    let state = readyState()
    expect(trajectoryPaneAt(state, 120, 32, 10, 15)).toBe('sessions')
    expect(trajectoryPaneAt(state, 120, 32, 70, 8)).toBe('timeline')
    expect(trajectoryPaneAt(state, 120, 32, 70, 25)).toBe('details')
    const wheel = applyTrajectoryEvent(state, { type: 'mouse', action: 'wheel-up', column: 70, row: 8 }, 120, 32)
    expect(wheel.kind).toBe('update')
    state = wheel.kind === 'update' ? wheel.state : state
    expect(state.focus).toBe('timeline')
    expect(state.follow).toBe(false)
    const emptyDetails = applyTrajectoryEvent({ ...state, rows: [] }, { type: 'mouse', action: 'wheel-down', column: 70, row: 25 }, 120, 32)
    expect(emptyDetails.kind === 'update' && emptyDetails.state.focus).toBe('details')
  })
})

describe('renderTrajectory', () => {
  it('renders a distinct three-lane overview with status, usage, and selection', () => {
    const frame = renderTrajectory(readyState(), createTheme(false), 120, 32, 'omdsh', 0)
    const output = frame.lines.map(stripAnsi).join('\n')
    expect(frame.lines).toHaveLength(32)
    expect(frame.lines.every(line => visibleWidth(line) <= 120)).toBe(true)
    expect(output).toContain('omdsh · Trajectory')
    expect(output).toContain('0 Guide')
    expect(output).toContain('[1 Overview]')
    expect(output).toContain('Runs · current + agents')
    expect(output).toContain('Talk')
    expect(output).toContain('Tools')
    expect(output).toContain('Coordination')
    expect(output).toContain('Now:')
    expect(output).toContain('• event · ● several events · ◆ selected · ! problem')
    expect(output).toContain('Usage: in:100 · out:20')
    expect(output).toContain('◆')
    expect(output).toContain('Review child')
    expect(output).toContain('1 overview')
    expect(output).toContain('7 raw')
  })

  it('opens a visible 0 Guide slide that explains panes, modes, and controls', () => {
    const opened = applyTrajectoryEvent(readyState(), typed('0'))
    expect(opened.kind).toBe('update')
    const state = opened.kind === 'update' ? opened.state : readyState()
    expect(state.guideOpen).toBe(true)
    const output = renderTrajectory(state, createTheme(false), 120, 32).lines.map(stripAnsi).join('\n')
    expect(output).toContain('How to read Trajectory')
    expect(output).toContain('[0 Guide]')
    expect(output).toContain('1 Overview')
    expect(output).toContain('Runs on the left chooses the main conversation or an agent')
    expect(output).toContain('1 Overview = current shape')
    expect(output).toContain('0 / ? / h / Esc / Enter back')
    const switched = applyTrajectoryEvent(state, typed('2'))
    expect(switched.kind === 'update' && !switched.state.guideOpen && switched.state.mode === 'flow').toBe(true)
    const closed = applyTrajectoryEvent(state, key('escape'))
    expect(closed.kind === 'update' && closed.state.guideOpen).toBe(false)
  })

  it('renders explicit turn/step-aware vertical rails in flow mode', () => {
    const state = { ...readyState(), mode: 'flow' as const, selectedEvent: 3, follow: false, focus: 'timeline' as const }
    const output = renderTrajectory(state, createTheme(false), 120, 32).lines.map(stripAnsi).join('\n')
    expect(output).toContain('T1/S1/C:call-1')
    expect(output).toMatch(/[┌│└]T1/u)
    expect(output).toContain('Ship the terminal trajectory')
  })

  it('shows what inflated the context on the assistant row, its details, and overview', () => {
    const state = growthState('flow')
    const rowIndex = filteredTrajectoryRows(state).findIndex(row => row.seq === 9)
    const flow = renderTrajectory({ ...state, selectedEvent: rowIndex, follow: false, focus: 'timeline' as const }, createTheme(false), 120, 32)
    const flowOutput = flow.lines.map(stripAnsi).join('\n')
    expect(flowOutput).toContain('+87K ← read bridge.go')
    expect(flow.lines.every(line => visibleWidth(line) <= 120)).toBe(true)

    const details = renderTrajectory({ ...state, selectedEvent: rowIndex, follow: false, focus: 'details' as const }, createTheme(false), 120, 32)
    expect(details.lines.map(stripAnsi).join('\n')).toContain('Context growth: +87K tokens ← read bridge.go')

    const overviewState = { ...state, mode: 'overview' as const, follow: false }
    const overviewIndex = filteredTrajectoryRows(overviewState).findIndex(row => row.seq === 9)
    const overview = renderTrajectory({ ...overviewState, selectedEvent: overviewIndex }, createTheme(false), 120, 32)
    const overviewOutput = overview.lines.map(stripAnsi).join('\n')
    expect(overviewOutput).toContain('Selected now: #9 assistant/message')
    expect(overviewOutput).toContain('+87K ← read bridge.go')

    const narrow = renderTrajectory({ ...state, selectedEvent: rowIndex, follow: false }, createTheme(false), 70, 22)
    expect(narrow.lines.every(line => visibleWidth(line) <= 70)).toBe(true)
  })

  it('keeps Raw one-to-one and width-safe while carrying the growth annotation', () => {
    const state = growthState('raw')
    expect(state.rawRows).toHaveLength(growthEvents.length)
    expect(state.rawRows.filter(row => row.growthTokens !== undefined).map(row => row.seq)).toEqual([9])
    const rowIndex = state.rawRows.findIndex(row => row.seq === 9)
    const list = renderTrajectory({ ...state, selectedEvent: rowIndex, follow: false, focus: 'timeline' as const }, createTheme(false), 120, 32)
    expect(list.lines.every(line => visibleWidth(line) <= 120)).toBe(true)
    expect(list.lines.map(stripAnsi).join('\n')).toContain('+87K ← read bridge.go')
    const details = renderTrajectory({ ...state, selectedEvent: rowIndex, follow: false, focus: 'details' as const }, createTheme(false), 120, 32)
    const output = details.lines.map(stripAnsi).join('\n')
    expect(details.lines.every(line => visibleWidth(line) <= 120)).toBe(true)
    expect(output).toContain('"type": "assistant/message"')
    expect(output).toContain('"seq": 9')
  })

  it('redacts reasoning blocks and nested chunk objects from raw details', () => {
    const base = { ...readyState(), mode: 'raw' as const, follow: false, focus: 'details' as const }
    const messageOutput = renderTrajectory({ ...base, selectedEvent: 5 }, createTheme(false), 120, 32).lines.map(stripAnsi).join('\n')
    expect(messageOutput).toContain('assistant/message')
    expect(messageOutput).not.toContain('private chain')
    const chunkOutput = renderTrajectory({ ...base, selectedEvent: 9 }, createTheme(false), 120, 32).lines.map(stripAnsi).join('\n')
    expect(chunkOutput).toContain('assistant/chunk')
    expect(chunkOutput).not.toContain('must stay private')
    expect(chunkOutput).not.toContain('"text": "hidden"')
  })

  it('keeps responsive narrow layout and terminal-cell width safety', () => {
    const frame = renderTrajectory(readyState(), createTheme(false), 70, 22)
    const output = frame.lines.map(stripAnsi).join('\n')
    expect(frame.lines).toHaveLength(22)
    expect(frame.lines.every(line => visibleWidth(line) <= 70)).toBe(true)
    expect(output).toContain('Runs')
    expect(output).toContain('Review child')
    expect(output).toContain('1 overview')
    expect(output).not.toContain('Timeline')
  })
})
