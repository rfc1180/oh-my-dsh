/**
 * LocalTui contract tests over a fake terminal: key routing (edit, history,
 * slash/tab autocomplete, Ctrl-R history search, PgUp/PgDn transcript
 * scroll, Ctrl-O tool expand, submit), double-Escape rewind, double Ctrl-C exit, Ctrl-D quit and the
 * cross-turn quit latch, plain-mode line input, and event rendering.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference'
import { copyToClipboard } from '../input/clipboard.ts'
import { LocalTui, runTrajectoryTerminal, type TerminalLike } from './provider-local.ts'
import { initialTranscript, renderView } from '../views/event-views.ts'
import { createHistorySearch } from '../views/history-search.ts'
import type { DirEntry, PathSearcher, ProjectPathEntry } from '../views/path-complete.ts'
import { stripAnsi } from '../chrome/width.ts'
import { SessionPresentationController } from '../session/session-controller.ts'

const PNG_1X1 = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zk5sAAAAASUVORK5CYII=',
  'base64',
))

const flushAsyncPaste = async (): Promise<void> => {
  await new Promise<void>(resolve => { setImmediate(resolve) })
}

class FakeTerminal implements TerminalLike {
  captured = ''
  writes = 0
  raw = false
  destroyed = false
  columns = 60
  rows = 24
  resizeListener: (() => void) | undefined
  output = {
    isTTY: true,
    write: (chunk: string): void => { this.writes += 1; this.captured += chunk },
  }
  input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: (on: boolean): void => { this.raw = on },
    destroy: (): void => { this.destroyed = true },
  })
  width(): number { return this.columns }
  height(): number { return this.rows }
  onResize(listener: () => void): () => void {
    this.resizeListener = listener
    return () => { this.resizeListener = undefined }
  }
  resize(columns: number, rows: number): void {
    this.columns = columns
    this.rows = rows
    this.resizeListener?.()
  }
}

function ev(type: string, data: unknown, seq: number): SessionEvent {
  return { type, seq, time: seq, data } as unknown as SessionEvent
}

const press = (term: FakeTerminal, bytes: string): void => {
  term.input.write(bytes)
}

function emulatedScreenRows(output: string): string[] {
  const rows: string[] = ['']
  let row = 0
  let column = 0
  const tokens = output.match(/\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[?0-9;]*[ -/]*[@-~]|\r|\n|[^\x1b\r\n]+/gu) ?? []
  for (const token of tokens) {
    if (token === '\r') {
      column = 0
      continue
    }
    if (token === '\n') {
      row += 1
      rows[row] ??= ''
      continue
    }
    if (token.startsWith('\x1b]')) continue
    if (token.startsWith('\x1b[')) {
      const operation = token.at(-1)
      const rawParams = token.slice(2, -1).replace(/^\?/u, '')
      const params = rawParams.split(';').map(value => Number(value || '1'))
      const amount = params[0] ?? 1
      if (operation === 'A') row = Math.max(0, row - amount)
      else if (operation === 'B') row += amount
      else if (operation === 'C') column += amount
      else if (operation === 'D') column = Math.max(0, column - amount)
      else if (operation === 'H' || operation === 'f') {
        row = Math.max(0, (params[0] ?? 1) - 1)
        column = Math.max(0, (params[1] ?? 1) - 1)
      } else if (operation === 'J' && rawParams === '2') {
        rows.splice(0, rows.length, '')
      } else if (operation === 'K') {
        rows[row] = (rows[row] ?? '').slice(0, column)
      }
      rows[row] ??= ''
      continue
    }
    const current = rows[row] ?? ''
    rows[row] = current.slice(0, column) + token + current.slice(column + token.length)
    column += token.length
  }
  return Array.from(rows, value => value ?? '')
}

/** Status-line workspace label: home-relative git root, matching LocalTui. */
function shortenedWorkspaceRoot(): string {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const home = homedir()
  if (root === home) return '~'
  if (root.startsWith(`${home}/`)) return `~${root.slice(home.length)}`
  return root
}

describe('LocalTui (tty)', () => {
  it('shows a staged tail while composer input stays unbound until activation', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, { deferInitialRender: true })
    expect(term.raw).toBe(false)
    expect(term.resizeListener).toBeUndefined()
    press(term, 'ignored before validation')
    tui.replaceViewportTail([
      ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'early durable tail' }] }, 1),
    ])
    expect(stripAnsi(term.captured)).toContain('early durable tail')
    expect(term.raw).toBe(false)

    tui.activateInput()
    tui.activateInput()
    expect(term.raw).toBe(true)
    expect(term.resizeListener).toBeTypeOf('function')
    const pending = tui.readInput()
    press(term, 'accepted\r')
    await expect(pending).resolves.toEqual({ text: 'accepted', images: [] })
    tui.dispose()
  })

  it('reconciles a resize that happens before input activation', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, { deferInitialRender: true })
    tui.replaceSession([
      ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'initial frame' }] }, 1),
    ])

    term.rows = 40
    tui.activateInput()

    const screen = emulatedScreenRows(term.captured).map(stripAnsi)
    expect(screen[38]).toContain('m')
    expect(screen).toHaveLength(40)
    tui.dispose()
  })

  it('reconciles live geometry when the terminal resize event is missed', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)

    term.rows = 40
    tui.setModel('resized-model')

    const screen = emulatedScreenRows(term.captured).map(stripAnsi)
    expect(screen[38]).toContain('resized-model')
    expect(screen).toHaveLength(40)
    tui.dispose()
  })

  it('opens Trajectory in the alternate screen and restores the transcript on close', async () => {
    const term = new FakeTerminal()
    term.columns = 120
    term.rows = 32
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, { alternateScreenOverlays: true })
    tui.setSession({ id: 'session-root', recent: [] })
    tui.replaceSession([
      ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'preserved transcript' }] }, 1),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2),
    ])
    const before = term.captured.length
    const closed = tui.openTrajectory({
      activeSessionId: 'session-root',
      pollIntervalMs: 30_000,
      list: async () => [{ id: 'session-root', title: 'Current work', eventCount: 2 }],
      inspect: async () => ({
        id: 'session-root',
        title: 'Current work',
        eventCount: 2,
        events: [
          ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'preserved transcript' }] }, 1),
          ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2),
        ],
      }),
    })
    await flushAsyncPaste()
    const opened = term.captured.slice(before)
    expect(opened).toContain('\x1b[?1049h')
    expect(emulatedScreenRows(opened).map(stripAnsi).join('\n')).toContain('Trajectory')

    press(term, 'q')
    await closed
    expect(term.captured.slice(before)).toContain('\x1b[?1049l')
    tui.dispose()
  })

  it('opens /trajectory as the native screen while keeping companion and text explicit', async () => {
    const term = new FakeTerminal()
    term.columns = 120
    term.rows = 30
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, { alternateScreenOverlays: true })
    const openCompanion = vi.fn(async () => {})
    tui.setSession({ id: 'session-live', recent: [] })
    tui.setCommands([{ name: 'trajectory', description: 'Open Trajectory' }])
    tui.setTrajectorySource({
      activeSessionId: 'session-live',
      pollIntervalMs: 30_000,
      openCompanion,
      list: async () => [{ id: 'session-live', title: 'Live task' }],
      inspect: async () => ({ id: 'session-live', title: 'Live task', events: [] }),
    })
    const pending = tui.readInput()
    const before = term.captured.length

    press(term, '/trajectory tools 40\r')
    await flushAsyncPaste()
    expect(term.captured.slice(before)).toContain('\x1b[?1049h')
    expect(openCompanion).not.toHaveBeenCalled()
    press(term, 'q')
    await flushAsyncPaste()

    const beforeScreen = term.captured.length
    press(term, '/trajectory screen summary\r')
    await flushAsyncPaste()
    expect(term.captured.slice(beforeScreen)).toContain('\x1b[?1049h')
    expect(openCompanion).not.toHaveBeenCalled()
    press(term, 'q')
    await flushAsyncPaste()

    const beforeCompanion = term.captured.length
    press(term, '/trajectory companion errors 30\r')
    await flushAsyncPaste()
    expect(openCompanion).toHaveBeenLastCalledWith({ mode: 'errors', limit: 30 })
    expect(term.captured.slice(beforeCompanion)).not.toContain('\x1b[?1049h')

    press(term, '/trajectory text summary 20\r')
    await expect(pending).resolves.toEqual({ text: '/trajectory text summary 20', images: [] })
    tui.dispose()
  })

  it('runs the rich native Trajectory renderer as a dedicated terminal app', async () => {
    const term = new FakeTerminal()
    term.columns = 120
    term.rows = 30
    const running = runTrajectoryTerminal({
      activeSessionId: 'session-live',
      pollIntervalMs: 30_000,
      list: async () => [{ id: 'session-live', title: 'Live task' }],
      inspect: async () => ({
        id: 'session-live',
        title: 'Live task',
        eventCount: 1,
        events: [ev('assistant/message', { message: { content: [{ type: 'text', text: 'rich detached event' }] } }, 1)],
      }),
    }, { mode: 'summary' }, {
      terminal: term,
      colors: false,
      copy: async () => {},
    })

    await flushAsyncPaste()
    const rendered = emulatedScreenRows(term.captured).map(stripAnsi).join('\n')
    expect(term.captured).toContain('\x1b[?1049h')
    expect(rendered).toContain('Trajectory')
    expect(rendered).toContain('Live task')
    press(term, 'q')
    await running
    expect(term.captured).toContain('\x1b[?1049l')
    expect(term.destroyed).toBe(true)
  })

  it('opens the configured Trajectory source while an agent turn is running', async () => {
    const term = new FakeTerminal()
    term.columns = 120
    term.rows = 30
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, { alternateScreenOverlays: true })
    tui.setSession({ id: 'session-live', recent: [] })
    tui.setTrajectorySource({
      activeSessionId: 'session-live',
      pollIntervalMs: 30_000,
      list: async () => [{ id: 'session-live', title: 'Live task' }],
      inspect: async () => ({ id: 'session-live', title: 'Live task', events: [] }),
    })
    tui.setStatus('running')
    const before = term.captured.length
    press(term, '\x1bt')
    await flushAsyncPaste()
    expect(term.captured.slice(before)).toContain('\x1b[?1049h')
    expect(emulatedScreenRows(term.captured.slice(before)).map(stripAnsi).join('\n')).toContain('Live task')
    tui.event(ev('tool/call', { callId: 'call-live', name: 'bash', arguments: '{"command":"pnpm test"}' }, 1))
    expect(emulatedScreenRows(term.captured.slice(before)).map(stripAnsi).join('\n')).toContain('pnpm test')
    press(term, 'q')
    await flushAsyncPaste()
    tui.dispose()
  })

  it('rings the terminal bell when a running turn becomes idle', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    tui.setStatus('running')
    const before = term.captured.length

    tui.setStatus('idle')

    expect(term.captured.slice(before)).toContain('\x07')
    tui.dispose()
  })

  it('does not repaint the complete transcript on a cosmetic spinner timer', () => {
    vi.useFakeTimers()
    try {
      const term = new FakeTerminal()
      const tui = new LocalTui(term, 'm', false)
      tui.setStatus('running')
      const writes = term.writes

      vi.advanceTimersByTime(30_000)
      expect(term.writes).toBe(writes)
      tui.event({ seq: 1, type: 'turn/start', data: { turn: 1 } })
      expect(term.writes).toBeGreaterThan(writes)
      tui.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('repaints the footer when live Agent and tool controls change', () => {
    const term = new FakeTerminal()
    term.columns = 100
    const tui = new LocalTui(term, 'm', false)
    tui.setSession({
      id: 'session-controls',
      recent: [],
      controls: {
        agentPreset: 'standard',
        tools: 'native',
        plan: { active: false, pending: false },
      },
    })
    expect(emulatedScreenRows(term.captured).map(stripAnsi).join('\n')).toContain('m · standard')

    tui.setSession({
      id: 'session-controls',
      recent: [],
      controls: {
        agentPreset: 'code',
        tools: 'both',
        plan: { active: false, pending: false },
      },
    })
    const screen = emulatedScreenRows(term.captured).map(stripAnsi).join('\n')
    expect(screen).toContain('m · ptc · both')
    expect(screen).not.toContain('m · standard')
    tui.dispose()
  })

  it('publishes complete deduplicated telemetry for supporting terminal hosts', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'deepseek-v4-pro', false, 'dark', copyToClipboard, { hostTelemetry: true })
    const session = {
      id: 'session-telemetry',
      recent: [],
      stats: {
        turns: 2,
        steps: 5,
        llmMs: 12_000,
        toolMs: 3_000,
        ttftMs: 600,
        ttftSteps: 2,
        decodeMs: 8_000,
        decodeTokens: 320,
        inputTokens: 20_000,
        outputTokens: 400,
        cacheReadTokens: 18_000,
        cacheWriteTokens: 0,
        contextTokens: 8_000,
        contextWindow: 100_000,
      },
    }
    tui.applyStoredPrefs({
      theme: 'dark',
      colors: false,
      expandTools: false,
      statusBar: { groups: ['context'] },
    })
    tui.setSession(session)

    const frames = (): string[] => term.captured.match(/\x1b\]16163;[A-Za-z0-9+/=]*\x1b\\/gu) ?? []
    const published = frames().find(frame => !frame.startsWith('\x1b]16163;\x1b\\'))
    expect(published).toBeDefined()
    const encoded = published?.slice('\x1b]16163;'.length, -2) ?? ''
    const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as { groups: string[] }
    expect(payload.groups).toContain('Ctx 8% · 8K/100K')
    expect(payload.groups).toContain('Cache 90%')

    const beforeRefresh = frames().length
    tui.refresh()
    tui.setSession(session)
    expect(frames()).toHaveLength(beforeRefresh)

    tui.applyStoredPrefs({
      theme: 'dark',
      colors: false,
      expandTools: false,
      statusBar: { enabled: false },
    })
    expect(frames().at(-1)).toBe('\x1b]16163;\x1b\\')

    tui.dispose()
    expect(frames().at(-1)).toBe('\x1b]16163;\x1b\\')
  })

  it('renders the package version in the welcome title', () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    ) as { version: string }
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)

    expect(stripAnsi(term.captured)).toContain(`omdsh v${manifest.version}`)
    tui.dispose()
  })

  it('keeps the welcome card when a durable transcript replaces the startup frame', () => {
    const term = new FakeTerminal()
    term.rows = 12
    const tui = new LocalTui(term, 'm', false)
    expect(term.captured.match(/\x1b\[3J/gu)).toHaveLength(1)

    const restored = Array.from({ length: 30 }, (_, index) => `restored-${index}`).join('\n')
    tui.replaceSession([
      ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'resumed prompt' }] }, 1),
      ev('assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', text: restored },
      }, 2),
    ])

    expect(term.captured.match(/\x1b\[3J/gu)).toHaveLength(2)
    const screen = emulatedScreenRows(term.captured).map(stripAnsi).join('\n')
    expect(screen).toContain('resumed prompt')
    expect(screen).toContain('restored-0')
    expect(screen).toContain('restored-15')
    expect(screen).toContain('restored-29')
    expect(screen).toContain('Into the Unknown')
    tui.dispose()
  })

  it('defers the production first frame until the initial session is available', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, { deferInitialRender: true })

    expect(term.captured).not.toContain('Into the Unknown')
    expect(term.captured).not.toContain('\x1b[3J')
    tui.setStatus('running')
    expect(term.captured).not.toContain('Into the Unknown')

    tui.replaceSession([
      ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'initial session' }] }, 1),
    ], undefined, 'idle')
    expect(term.captured).toContain('Into the Unknown')
    expect(term.captured).toContain('initial session')
    expect(term.captured.match(/\x1b\[3J/gu)).toHaveLength(1)
    tui.dispose()
  })

  it('does not request ED3 inside a terminal multiplexer', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, { terminalProfile: 'multiplexer' })
    tui.replaceSession([
      ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'multiplexed' }] }, 1),
    ])

    expect(term.captured).not.toContain('\x1b[3J')
    expect(term.captured).toContain('multiplexed')
    tui.dispose()
  })

  it('does not request ED3 through ConPTY', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, { terminalProfile: 'conpty' })
    tui.replaceSession([
      ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'conpty replay' }] }, 1),
    ])

    expect(term.captured).not.toContain('\x1b[3J')
    expect(term.captured).toContain('conpty replay')
    tui.dispose()
  })

  it('coalesces multiplexer resize bursts before repainting', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, {
      terminalProfile: 'multiplexer',
      resizeDebounceMs: 5,
    })
    const beforeResize = term.writes

    term.resize(70, 20)
    term.resize(72, 21)
    expect(term.writes).toBe(beforeResize)

    await new Promise<void>(resolve => { setTimeout(resolve, 15) })
    expect(term.writes).toBe(beforeResize + 1)
    tui.dispose()
  })

  it('renders typed input inside the rounded editor', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', true)
    press(term, 'ab')
    expect(term.captured).toContain('ab')
    expect(term.captured).toContain('╰─')
    expect(term.raw).toBe(true)
    tui.dispose()
  })

  it('clears the screen before the first frame in tty mode', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    expect(term.captured).toContain('\x1b[2J\x1b[H')
    tui.dispose()
  })

  it('keeps native mouse selection and restores enhanced keyboard modes', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    tui.dispose()
    expect(term.captured).not.toContain('\x1b[?1000h')
    expect(term.captured).not.toContain('\x1b[?1006h')
    expect(term.captured).not.toContain('\x1b[?1000l')
    expect(term.captured).not.toContain('\x1b[?1006l')
    expect(term.captured).toContain('\x1b[>4;2m')
    expect(term.captured).toContain('\x1b[>4m')
    expect(term.captured).toContain('\x1b[?2004l')
    expect(term.raw).toBe(false)
    expect(term.destroyed).toBe(true)
  })

  it('restores enhanced keyboard input after suspend and continue', () => {
    const term = new FakeTerminal()
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const tui = new LocalTui(term, 'm', false)
    const before = term.captured.length

    press(term, '\x1a')
    expect(term.captured.slice(before)).toContain('\x1b[>4m\x1b[?2004l')
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTSTP')

    process.emit('SIGCONT')
    expect(term.captured.slice(before)).toContain('\x1b[?2004h\x1b[>4;2m')
    tui.dispose()
    kill.mockRestore()
  })

  it('starts a clean transcript epoch after direct-terminal width reflow', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, { resizeDebounceMs: 0 })
    const rows = Array.from({ length: 30 }, (_, index) => `| row-${index.toString().padStart(2, '0')} | value-${index} |`)
    const table = ['| key | value |', '| --- | --- |', ...rows].join('\n')
    tui.replaceSession([
      ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'render the complete table' }] }, 1),
      ev('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: table }] } }, 2),
    ])
    const before = term.captured.length

    term.resize(100, 18)

    const repaint = term.captured.slice(before)
    expect(repaint.match(/\x1b\[3J/gu)).toHaveLength(1)
    expect(repaint).toContain('\x1b[2J\x1b[H')
    expect(stripAnsi(repaint)).toContain('row-00')
    expect(stripAnsi(repaint)).toContain('row-15')
    expect(stripAnsi(repaint)).toContain('row-29')
    tui.dispose()
  })

  it('preserves a pending direct-terminal width reflow when an event reconciles height first', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, { resizeDebounceMs: 1_000 })

    term.resize(70, 24)
    term.columns = 60
    term.rows = 30
    const before = term.captured.length
    tui.setModel('resized-model')

    const repaint = term.captured.slice(before)
    expect(repaint.match(/\x1b\[3J/gu)).toHaveLength(1)
    expect(emulatedScreenRows(repaint).map(stripAnsi)[28]).toContain('resized-model')
    tui.dispose()
  })

  it('rebuilds an oversized streaming reply once when turn/end settles it', () => {
    const term = new FakeTerminal()
    term.rows = 18
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, { streamRenderMs: 0 })
    const rows = Array.from({ length: 40 }, (_, index) => `| settle-${index.toString().padStart(2, '0')} | ${'long value '.repeat(4)} |`)
    const table = ['| key | value |', '| --- | --- |', ...rows].join('\n')
    tui.replaceSession([
      ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'stream an oversized table' }] }, 1),
      ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', text: table } }, 2),
    ], undefined, 'running')
    const before = term.captured.length

    tui.event(ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3))

    const settlement = term.captured.slice(before)
    expect(settlement.match(/\x1b\[3J/gu)).toHaveLength(1)
    for (let index = 0; index < rows.length; index += 1) {
      expect(stripAnsi(settlement)).toContain(`settle-${index.toString().padStart(2, '0')}`)
    }
    tui.dispose()
  })

  it('rebuilds a streaming Markdown table across direct-terminal width reflow', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, { resizeDebounceMs: 0 })
    const rows = Array.from({ length: 30 }, (_, index) => `| stream-${index.toString().padStart(2, '0')} | value-${index} |`)
    const table = ['| key | value |', '| --- | --- |', ...rows].join('\n')
    tui.replaceSession([
      ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'stream the complete table' }] }, 1),
      ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', text: table } }, 2),
    ], undefined, 'running')
    const before = term.captured.length

    term.resize(100, 18)
    tui.event(ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3))

    const reflow = term.captured.slice(before)
    expect(reflow.match(/\x1b\[3J/gu)).toHaveLength(2)
    expect(stripAnsi(reflow)).toContain('stream-00')
    expect(stripAnsi(reflow)).toContain('stream-15')
    expect(stripAnsi(reflow)).toContain('stream-29')
    tui.dispose()
  })

  it('repaints height-only and same-geometry resize without erasing scrollback', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const beforeHeight = term.captured.length

    term.resize(term.columns, 18)

    const heightRepaint = term.captured.slice(beforeHeight)
    expect(heightRepaint).not.toContain('\x1b[3J')
    expect(heightRepaint).toContain('\x1b[2J\x1b[H')
    expect(stripAnsi(heightRepaint)).toContain('🐳')

    const beforeSameGeometry = term.captured.length
    term.resize(term.columns, term.rows)

    const sameGeometryRepaint = term.captured.slice(beforeSameGeometry)
    expect(sameGeometryRepaint).not.toContain('\x1b[3J')
    expect(sameGeometryRepaint).toContain('\x1b[2J\x1b[H')
    expect(stripAnsi(sameGeometryRepaint)).toContain('🐳')
    tui.dispose()
  })

  it('leaves the cursor on a fresh line when disposed', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const before = term.captured.length
    tui.dispose()
    expect(term.captured.slice(before)).toContain('\r\n')
  })

  it('submits a line on Enter and clears the buffer', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const pending = tui.readline()
    press(term, 'hi\r')
    expect(await pending).toBe('hi')
    expect(term.captured).toContain('╰─')
    tui.dispose()
  })

  it('interactively selects a prompt option with arrow keys and Enter', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const runnerLine = tui.readline()
    const answer = tui.prompt({
      title: 'Resume session',
      question: 'Choose a session',
      options: [
        { label: 'session-one', description: 'First session' },
        { label: 'session-two', description: 'Second session' },
      ],
    })

    press(term, '\x1b[B\r')

    expect(stripAnsi(term.captured)).toContain('❯ session-two')
    expect(await answer).toBe('session-two')
    press(term, 'next prompt\r')
    expect(await runnerLine).toBe('next prompt')
    tui.dispose()
  })

  it('accepts a line-feed Enter event in a prompt selector', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const answer = tui.prompt({
      title: 'Choice',
      question: 'Choose one',
      options: [{ label: 'Alpha' }, { label: 'Beta' }],
    })

    press(term, '\x1b[B\n')

    expect(await answer).toBe('Beta')
    tui.dispose()
  })

  it('submits the current multi-select option when none are checked', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const answer = tui.prompt({
      title: 'Update mode',
      question: 'How should updates be applied?',
      options: [{ label: 'Recommended' }, { label: 'Manual' }],
      multiSelect: true,
    })

    press(term, '\r')

    expect(await answer).toBe('Recommended')
    tui.dispose()
  })

  it('filters a full-screen prompt and returns the hidden option value', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const answer = tui.prompt({
      title: 'Resume Session',
      question: '',
      presentation: 'fullscreen-list',
      filterable: true,
      allowCustom: false,
      options: [
        { label: 'Alpha session', value: 'session-alpha', description: '2m ago' },
        { label: 'Beta session', value: 'session-beta', description: '1h ago' },
      ],
    })

    press(term, 'session\x1b[B\r')

    expect(stripAnsi(term.captured)).toContain('Beta session')
    expect(await answer).toBe('session-beta')
    tui.dispose()
  })

  it('renders a fixed-choice prompt without a custom-answer editor', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const beforePrompt = term.captured.length
    const answer = tui.prompt({
      title: 'Skills · 2 available',
      question: 'Skills are reusable playbooks.',
      detail: 'Choose one to add its instructions to this turn.',
      options: [
        { label: 'code-review', description: 'Review a change for correctness.' },
        { label: 'research', description: 'Research a question using primary sources.' },
      ],
      allowCustom: false,
      submitLabel: 'run',
    })

    expect(stripAnsi(term.captured)).toContain('Skills · 2 available')
    expect(stripAnsi(term.captured)).toContain('reusable playbooks')
    expect(stripAnsi(term.captured)).toContain('enter run')
    expect(stripAnsi(term.captured)).not.toContain('custom answer')
    expect(term.captured.slice(beforePrompt)).toContain('\x1b[?25l')
    const beforeClose = term.captured.length
    press(term, '\x1b[B\r')
    expect(await answer).toBe('research')
    expect(term.captured.slice(beforeClose)).toContain('\x1b[?25h')
    tui.dispose()
  })

  it('returns secret prompt input without rendering its value', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const secret = 'sk-never-render-this'
    const answer = tui.prompt({
      title: 'Login to DeepSeek',
      question: 'Paste your DeepSeek API key',
      allowCustom: true,
      secret: true,
    })

    press(term, secret)
    expect(stripAnsi(term.captured)).not.toContain(secret)
    expect(stripAnsi(term.captured)).toContain('•'.repeat(secret.length))
    press(term, '\n')
    expect(await answer).toBe(secret)
    expect(stripAnsi(term.captured)).not.toContain(secret)
    tui.dispose()
  })

  it('opens a fixed-choice prompt on its current value', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const answer = tui.prompt({
      title: 'Permission',
      question: 'Choose how omdsh may access your workspace',
      options: [
        { label: 'Read only', value: 'read-only' },
        { label: 'Workspace write', value: 'workspace-write' },
      ],
      initialValue: 'workspace-write',
      allowCustom: false,
    })

    press(term, '\r')
    expect(await answer).toBe('workspace-write')
    tui.dispose()
  })

  it('reviews long plans in a bounded page and returns approval directly', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const answer = tui.prompt({
      title: 'Plan review',
      question: 'Approve this plan and leave plan mode?',
      detail: ['# Plan', ...Array.from({ length: 60 }, (_, index) => `- Step ${index + 1}`)].join('\n'),
      options: [{ label: 'Approve' }, { label: 'Keep planning' }],
      presentation: 'plan-review',
      approveValue: 'Approve',
      allowCustom: true,
    })

    expect(stripAnsi(term.captured)).toContain('later plan lines')
    press(term, '\r')
    expect(await answer).toBe('Approve')
    tui.dispose()
  })

  it('collects feedback only after Keep planning is selected', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const answer = tui.prompt({
      title: 'Plan review',
      question: 'Approve this plan and leave plan mode?',
      detail: '# Plan\n\n- Implement the change',
      options: [{ label: 'Approve' }, { label: 'Keep planning' }],
      presentation: 'plan-review',
      approveValue: 'Approve',
      allowCustom: true,
    })

    press(term, '\t\r')
    expect(stripAnsi(term.captured)).toContain('Revision feedback · optional')
    press(term, 'Cover the failure path\r')
    expect(await answer).toBe('Cover the failure path')
    tui.dispose()
  })

  it('queues a line submitted while a turn is running', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    // No readline in flight — the runner is busy driving a turn.
    press(term, 'typed during turn\r')
    expect(stripAnsi(term.captured)).toContain('│ Queued · typed during turn')
    expect(stripAnsi(term.captured)).toContain('↑ edit')
    const next = tui.readline()
    expect(await next).toBe('typed during turn')
    tui.dispose()
  })

  it('restores the newest queued line into an empty composer with shift+up', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    press(term, 'first queued\rsecond queued\r')
    expect(stripAnsi(term.captured)).toContain('Queued · 2')
    press(term, '\x1b[1;2A')
    const restored = stripAnsi(term.captured)
    expect(restored).toContain('│ Queued · first queued')
    expect(restored).toContain('second queued')
    const next = tui.readline()
    expect(await next).toBe('first queued')
    tui.dispose()
  })

  it('walks backward through queued lines with repeated shift+up without reordering them', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    press(term, 'first queued\rsecond queued\rthird queued\r')

    press(term, '\x1b[1;2A\x1b[1;2A!\r')

    expect(await tui.readline()).toBe('first queued')
    expect(await tui.readline()).toBe('second queued!')
    expect(await tui.readline()).toBe('third queued')
    tui.dispose()
  })

  it('recalls history with shift+up while plain up remains caret motion', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const first = tui.readline()
    press(term, 'one\r')
    await first
    void tui.readline()
    press(term, '\x1b[A')
    expect(emulatedScreenRows(term.captured).map(stripAnsi).join('\n')).not.toContain('│ one')
    press(term, '\x1b[1;2A')
    expect(term.captured).toContain('one')
    expect(term.captured).toContain('╰─')
    tui.dispose()
  })

  it('clears the line on idle Ctrl-C without interrupting', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    let fired = 0
    tui.onInterrupt(() => { fired += 1 })
    press(term, 'abc\x03')
    expect(fired).toBe(0)
    expect(term.captured).toContain('╰─')
    tui.dispose()
  })

  it('fires interrupt listeners on Ctrl-C while running', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    let fired = 0
    const off = tui.onInterrupt(() => { fired += 1 })
    tui.setStatus('running')
    press(term, '\x03')
    expect(fired).toBe(1)
    off()
    press(term, '\x03')
    expect(fired).toBe(1)
    tui.dispose()
  })

  it('blocks composer input while compacting instead of queueing it', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    let interrupted = 0
    tui.onInterrupt(() => { interrupted += 1 })
    tui.event(ev('command/run', {
      commandId: 'cmd-compact-1',
      name: 'compact',
      source: { kind: 'user' },
    }, 1))

    press(term, 'must not queue\r')
    expect(stripAnsi(term.captured)).toContain('Compacting')
    press(term, '\x03')
    expect(interrupted).toBe(1)

    tui.event(ev('command/done', {
      commandId: 'cmd-compact-1',
      kind: 'success',
    }, 2))
    const pending = tui.readline()
    press(term, 'after compact\r')
    expect(await pending).toBe('after compact')
    tui.dispose()
  })

  it('keeps exactly one activity row while queued follow-ups change', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    tui.event(ev('turn/start', { turn: 1 }, 1))
    tui.event(ev('agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: [
        { id: 'message-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'next one' }] },
        { id: 'message-2', source: { kind: 'user' }, content: [{ type: 'text', text: 'next two' }] },
      ],
    }, 2))
    tui.event(ev('agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      removedCount: 1,
      inserted: [],
    }, 3))

    const rows = emulatedScreenRows(term.captured)
    expect(rows.filter(line => stripAnsi(line).includes('Deep Driving'))).toHaveLength(1)
    tui.dispose()
  })

  it('requests editing the latest durable follow-up when Shift+Up is pressed in an empty composer', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const pending = tui.readline()
    let edits = 0
    const off = tui.onQueueEdit(() => { edits += 1 })
    tui.event(ev('turn/start', { turn: 1 }, 1))
    tui.event(ev('agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: [
        { id: 'message-1', source: { kind: 'user' }, content: [{ type: 'text', text: 'edit this' }] },
      ],
    }, 2))

    press(term, '\x1b[1;2A')

    expect(edits).toBe(1)
    off()
    tui.dispose()
    expect(await pending).toBe(null)
  })

  it('continues backward through durable follow-ups and preserves newer drafts', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const messages = ['first durable', 'second durable', 'third durable']
    let seq = 1
    tui.event(ev('turn/start', { turn: 1 }, seq++))
    tui.event(ev('agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: messages.map((text, index) => ({
        id: `message-${index}`,
        source: { kind: 'user' },
        content: [{ type: 'text', text }],
      })),
    }, seq++))
    let edits = 0
    tui.onQueueEdit(() => {
      const text = messages.pop()
      if (text === undefined) {
        tui.resolveQueueEdit(null)
        return
      }
      edits += 1
      tui.event(ev('agent/inbox/spliced', {
        target: 'next-turn',
        start: messages.length,
        removedCount: 1,
        inserted: [],
      }, seq++))
      tui.resolveQueueEdit({ text, images: [] })
    })

    press(term, '\x1b[1;2A\x1b[1;2A!\r')

    expect(edits).toBe(2)
    expect(await tui.readline()).toBe('second durable!')
    expect(await tui.readline()).toBe('third durable')
    tui.dispose()
  })

  it('fires rewind listeners on double Escape while the idle composer is empty', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const pending = tui.readline()
    let fired = 0
    const off = tui.onRewind(() => { fired += 1 })

    press(term, '\x1b\x1b')
    await new Promise<void>(resolve => { setTimeout(resolve, 100) })

    expect(fired).toBe(1)
    off()
    tui.dispose()
    expect(await pending).toBe(null)
  })

  it('does not rewind when the composer contains a draft', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const pending = tui.readline()
    let fired = 0
    tui.onRewind(() => { fired += 1 })

    press(term, 'draft\x1b\x1b')
    await new Promise<void>(resolve => { setTimeout(resolve, 100) })

    expect(fired).toBe(0)
    tui.dispose()
    expect(await pending).toBe(null)
  })

  it('quits on a rapid second Ctrl-C and prints a resume command after restoring the tty', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    tui.setSession({ id: 'session-double-c', recent: [] })
    const pending = tui.readline()
    let settled = false
    void pending.then(() => { settled = true })

    press(term, 'draft\x03')
    await Promise.resolve()
    expect(settled).toBe(false)

    press(term, '\x03')
    expect(await pending).toBe(null)
    tui.dispose()

    expect(term.raw).toBe(false)
    expect(term.captured).toContain('Resume this session with omdsh --resume session-double-c')
  })

  it('prints the resume command below both fixed status lines', async () => {
    const term = new FakeTerminal()
    term.columns = 80
    const tui = new LocalTui(term, 'deepseek-v4-flash', false)
    tui.setSession({ id: 'session-exit-layout', recent: [] })
    const pending = tui.readline()

    press(term, '\x03\x03')
    expect(await pending).toBe(null)
    tui.dispose()

    const rows = emulatedScreenRows(term.captured)
    const statusRow = rows.findIndex(line => line.includes(shortenedWorkspaceRoot()))
    const resumeRow = rows.findIndex(line => line.includes('Resume this session with omdsh --resume'))
    expect(statusRow).toBeGreaterThanOrEqual(0)
    expect(resumeRow).toBeGreaterThan(statusRow)
  })

  it('quits on Ctrl-D with an empty buffer', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const pending = tui.readline()
    press(term, '\x04')
    expect(await pending).toBe(null)
    tui.dispose()
  })

  it('latches a Ctrl-D pressed between turns onto the next readline', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    press(term, '\x04')
    expect(await tui.readline()).toBe(null)
    tui.dispose()
  })

  it('renders events and the selected model', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm0', false)
    tui.event(ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }, 1))
    expect(term.captured).toContain('hi')
    tui.setModel('deepseek-v4-pro', 'max')
    expect(term.captured).toContain('deepseek-v4-pro')
    expect(term.captured).toContain('max')
    tui.dispose()
  })

  it('coalesces 1,000 controller-style transcript and footer updates but flushes settlement immediately', async () => {
    vi.useFakeTimers()
    try {
      const term = new FakeTerminal()
      const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, { streamRenderMs: 8 })
      const initialWrites = term.writes
      let projectedOutputTokens = 0
      const stats = (outputTokens: number) => ({
        turns: 1,
        steps: 1,
        llmMs: outputTokens,
        toolMs: 0,
        ttftMs: 1,
        ttftSteps: 1,
        decodeMs: outputTokens,
        decodeTokens: outputTokens,
        inputTokens: 10,
        outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      })
      const controller = new SessionPresentationController(tui, () => {
        tui.setSession({ id: 'stream-session', recent: [], stats: stats(projectedOutputTokens) })
      })

      for (let index = 0; index < 1_000; index += 1) {
        projectedOutputTokens = index + 1
        controller.event(ev('assistant/chunk', {
          turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' },
        }, index + 1))
      }
      expect(term.writes).toBe(initialWrites)

      await vi.advanceTimersByTimeAsync(8)
      expect(term.writes).toBe(initialWrites + 1)

      controller.event(ev('assistant/message', {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: 'FINAL-SETTLEMENT' }] },
      }, 1_001))
      controller.event(ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1_002))
      expect(term.writes - initialWrites).toBeLessThanOrEqual(3)
      expect(term.captured).toContain('FINAL-SETTLEMENT')

      await vi.advanceTimersByTimeAsync(8)
      expect(term.writes - initialWrites).toBeLessThanOrEqual(3)
      controller.dispose()
      tui.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps raw-key frames ahead of a pending default stream repaint', async () => {
    vi.useFakeTimers()
    try {
      const term = new FakeTerminal()
      const tui = new LocalTui(term, 'm', false)
      const pending = tui.readline()

      tui.event(ev('assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'deferred-stream-body' },
      }, 1))
      press(term, 'Q')

      expect(stripAnsi(term.captured)).toContain('Q')
      expect(stripAnsi(term.captured)).not.toContain('deferred-stream-body')

      press(term, '\r')
      await expect(pending).resolves.toBe('Q')

      await vi.advanceTimersByTimeAsync(49)
      expect(stripAnsi(term.captured)).not.toContain('deferred-stream-body')

      await vi.advanceTimersByTimeAsync(1)
      expect(stripAnsi(term.captured)).toContain('deferred-stream-body')
      tui.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips a footer repaint when only non-visible session timing changes', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const stats = {
      turns: 1,
      steps: 2,
      llmMs: 10,
      toolMs: 5,
      ttftMs: 2,
      ttftSteps: 1,
      decodeMs: 8,
      decodeTokens: 16,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
      contextTokens: 120,
      contextWindow: 1_000,
      elapsedMs: 100,
    }
    tui.setSession({ id: 'session-perf', recent: [], stats })
    const writesAfterVisibleStats = term.writes

    tui.setSession({ id: 'session-perf', recent: [], stats: { ...stats, elapsedMs: 200 } })

    expect(term.writes).toBe(writesAfterVisibleStats)
    tui.dispose()
  })

  it('selects the whole composer with ctrl+a and replaces it on input', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', true)
    press(term, 'hello')
    press(term, '\x01')
    expect(term.captured).toContain('\x1b[7mhello')
    press(term, 'X')
    press(term, '\x05')
    press(term, '!')
    expect(stripAnsi(term.captured)).toContain('X!')
    expect(stripAnsi(term.captured)).not.toContain('Xhello')
    tui.dispose()
  })

  it('kills the previous word with ctrl+w', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    press(term, 'hello world')
    press(term, '\x17')
    expect(term.captured).toContain('hello')
    tui.dispose()
  })

  it('moves up and down by visible wrapped rows without recalling history', async () => {
    const term = new FakeTerminal()
    term.columns = 12
    const tui = new LocalTui(term, 'm', false)
    const pending = tui.readline()
    press(term, 'abcdefghijklmnop')
    press(term, '\x1b[A')
    press(term, 'X\r')
    expect(await pending).toBe('abcdefghXijklmnop')
    tui.dispose()
  })

  it('inserts a newline with shift+enter and submits the multiline buffer', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const pending = tui.readline()
    press(term, 'one')
    press(term, '\x1b[13;2u')
    press(term, 'two\r')
    expect(await pending).toBe('one\ntwo')
    tui.dispose()
  })

  it('inserts a newline with alt+enter and submits the multiline buffer', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const pending = tui.readline()
    press(term, 'one')
    press(term, '\x1b\r')
    press(term, 'two\r')
    expect(await pending).toBe('one\ntwo')
    tui.dispose()
  })

  it('smart-pastes a clipboard image as an OMP-style draft and submits it with text', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, {
      readClipboard: async () => 'text fallback',
      readClipboardImage: async () => ({ data: PNG_1X1, mediaType: 'image/png', name: 'clipboard.png' }),
    })
    const pending = tui.readInput()

    press(term, '\x16')
    await flushAsyncPaste()
    expect(stripAnsi(term.captured)).toContain('[Image #1, 1x1]')
    expect(stripAnsi(term.captured)).not.toContain('text fallback')

    press(term, 'describe this\r')
    await expect(pending).resolves.toEqual({
      text: '[Image #1, 1x1] describe this',
      images: [{ data: PNG_1X1, mediaType: 'image/png', name: 'clipboard.png', width: 1, height: 1 }],
    })
    tui.dispose()
  })

  it('deletes a selected image draft and text together after ctrl+a', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, {
      readClipboardImage: async () => ({ data: PNG_1X1, mediaType: 'image/png', name: 'clipboard.png' }),
    })
    const pending = tui.readInput()

    press(term, '\x16')
    await flushAsyncPaste()
    press(term, ' notes\x01\x7freplacement\r')

    await expect(pending).resolves.toEqual({ text: 'replacement', images: [] })
    tui.dispose()
  })

  it('loads Finder file-url clipboard images when no raw bitmap is available', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, {
      readClipboard: async () => '',
      readClipboardImage: async () => null,
      readClipboardFiles: async () => ['/tmp/Screenshot 2026-08-15.png'],
      readImagePath: async () => ({ data: PNG_1X1, mediaType: 'image/png', name: 'Screenshot 2026-08-15.png' }),
    })
    const pending = tui.readInput()

    press(term, '\x16\r')
    await expect(pending).resolves.toMatchObject({
      text: '[Image #1, 1x1]',
      images: [{ mediaType: 'image/png', name: 'Screenshot 2026-08-15.png' }],
    })
    tui.dispose()
  })

  it('turns a bracketed-paste image path into a draft attachment', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, {
      readImagePath: async path => path === '/tmp/screenshot.png'
        ? { data: PNG_1X1, mediaType: 'image/png', name: 'screenshot.png' }
        : null,
    })
    const pending = tui.readInput()

    press(term, '\x1b[200~/tmp/screenshot.png\x1b[201~')
    await flushAsyncPaste()
    expect(stripAnsi(term.captured)).toContain('[Image #1, 1x1]')
    press(term, '\r')
    await expect(pending).resolves.toMatchObject({
      text: '[Image #1, 1x1]',
      images: [{ mediaType: 'image/png', name: 'screenshot.png', width: 1, height: 1 }],
    })
    tui.dispose()
  })

  it('refuses a pasted image that fails Harness admission, with an error notice', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, {
      readClipboardImage: async () => ({ data: PNG_1X1, mediaType: 'image/png', name: 'huge.png' }),
    })
    tui.setImageValidator(async () => { throw new Error('image exceeds the 2000px dimension limit') })
    const pending = tui.readInput()

    press(term, '\x16')
    await flushAsyncPaste()
    await flushAsyncPaste()
    expect(stripAnsi(term.captured)).toContain('image exceeds the 2000px dimension limit')
    expect(stripAnsi(term.captured)).not.toContain('[Image #1')

    press(term, 'just text\r')
    await expect(pending).resolves.toEqual({ text: 'just text', images: [] })
    tui.dispose()
  })

  it('drafts a pasted image that passes Harness admission', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, {
      readClipboardImage: async () => ({ data: PNG_1X1, mediaType: 'image/png', name: 'clipboard.png' }),
    })
    tui.setImageValidator(async () => {})
    const pending = tui.readInput()

    press(term, '\x16')
    await flushAsyncPaste()
    await flushAsyncPaste()
    expect(stripAnsi(term.captured)).toContain('[Image #1, 1x1]')
    press(term, '\r')
    await expect(pending).resolves.toMatchObject({ text: '[Image #1, 1x1]' })
    tui.dispose()
  })

  it('queues Enter behind an asynchronous image paste', async () => {
    const term = new FakeTerminal()
    let resolveImage: ((image: { data: Uint8Array; mediaType: 'image/png' }) => void) | undefined
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, {
      readClipboardImage: () => new Promise(resolve => { resolveImage = resolve }),
    })
    const pending = tui.readInput()
    let settled = false
    void pending.then(() => { settled = true })

    press(term, '\x16\r')
    await Promise.resolve()
    expect(settled).toBe(false)
    resolveImage?.({ data: PNG_1X1, mediaType: 'image/png' })
    await expect(pending).resolves.toMatchObject({ text: '[Image #1, 1x1]' })
    tui.dispose()
  })

  it('restores a failed image submission ahead of a newer draft without colliding markers', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, {
      readClipboardImage: async () => ({ data: PNG_1X1, mediaType: 'image/png' }),
    })
    const firstRead = tui.readInput()
    press(term, '\x16\r')
    const first = await firstRead
    expect(first).not.toBeNull()

    press(term, '\x16')
    await flushAsyncPaste()
    tui.restoreInput(first as NonNullable<typeof first>)
    const restored = tui.readInput()
    press(term, '\r')

    await expect(restored).resolves.toMatchObject({
      text: '[Image #1, 1x1]\n[Image #2, 1x1]',
      images: [{ mediaType: 'image/png' }, { mediaType: 'image/png' }],
    })
    tui.dispose()
  })

  it('keeps the original image draft when a slash command is typed after a paste', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, {
      readClipboardImage: async () => ({ data: PNG_1X1, mediaType: 'image/png' }),
    })
    const pending = tui.readInput()
    press(term, '\x16')
    await flushAsyncPaste()
    press(term, '/goal implement auth\r')
    const submitted = await pending
    expect(submitted).toMatchObject({
      text: '[Image #1, 1x1] /goal implement auth',
      images: [{ mediaType: 'image/png' }],
    })
    tui.restoreInput(submitted as NonNullable<typeof submitted>)
    const restored = tui.readInput()
    press(term, '\r')
    await expect(restored).resolves.toMatchObject({
      text: '[Image #1, 1x1] /goal implement auth',
      images: [{ mediaType: 'image/png' }],
    })
    tui.dispose()
  })

  it('keeps the original image draft when a slash command is typed before a paste', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, {
      readClipboardImage: async () => ({ data: PNG_1X1, mediaType: 'image/png' }),
    })
    const pending = tui.readInput()
    press(term, '/plan the migration')
    press(term, '\x16')
    await flushAsyncPaste()
    press(term, '\r')
    await expect(pending).resolves.toMatchObject({
      text: '/plan the migration [Image #1, 1x1]',
      images: [{ mediaType: 'image/png' }],
    })
    tui.dispose()
  })

  it('keeps the original image draft when a paste lands inside a slash command', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, {
      readClipboardImage: async () => ({ data: PNG_1X1, mediaType: 'image/png' }),
    })
    const pending = tui.readInput()
    press(term, '/goal ')
    press(term, '\x16')
    await flushAsyncPaste()
    press(term, 'implement auth\r')
    await expect(pending).resolves.toMatchObject({
      text: '/goal [Image #1, 1x1] implement auth',
      images: [{ mediaType: 'image/png' }],
    })
    tui.dispose()
  })

  it('recalls handwritten image placeholders from history when nothing is attached', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const first = tui.readline()
    press(term, '[Image #1] /goal literal\r')
    await first
    void tui.readline()
    press(term, '\x1b[1;2A')
    expect(emulatedScreenRows(term.captured).map(stripAnsi).join('\n')).toContain('[Image #1] /goal literal')
    tui.dispose()
  })

  it('drops attached image markers from history but keeps handwritten ones', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, {
      readClipboardImage: async () => ({ data: PNG_1X1, mediaType: 'image/png' }),
    })
    const pending = tui.readInput()
    press(term, '\x16')
    await flushAsyncPaste()
    press(term, 'see [Image #2] notes\r')
    await pending
    void tui.readInput()
    press(term, '\x1b[1;2A')
    const screen = emulatedScreenRows(term.captured).map(stripAnsi).join('\n')
    expect(screen).toContain('[Image #2] notes')
    expect(screen).not.toContain('[Image #1, 1x1]')
    tui.dispose()
  })

  it('interrupts a running turn on Escape', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    let fired = 0
    tui.onInterrupt(() => { fired += 1 })
    tui.setStatus('running')
    press(term, '\x1b')
    // Lone ESC is flushed on the decoder timeout.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(fired).toBe(1)
        tui.dispose()
        resolve()
      }, 120)
    })
  })

  it('deletes forward with ctrl+d when the buffer is not empty', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    press(term, 'ab')
    press(term, '\x01')
    press(term, '\x04')
    expect(term.captured).toContain('b')
    tui.dispose()
  })

  it('opens slash-command suggestions when the buffer starts with /', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    press(term, '/')
    expect(term.captured).toContain('/help')
    expect(term.captured).toContain('/settings')
    expect(term.captured).toContain('/detail')
    expect(term.captured).not.toContain('/theme')
    expect(term.captured).not.toContain('/hotkeys')
    expect(term.captured).not.toContain('/pwd')
    expect(term.captured).not.toContain('/dirs')
    expect(term.captured).toContain('/copy')
    expect(term.captured).toContain('1/7')
    tui.dispose()
  })

  it('completes the selected slash command on Tab', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    press(term, '/cl')
    press(term, '\t')
    expect(term.captured).toContain('/clear ')
    tui.dispose()
  })

  it('suggests /copy arguments and completes the selected kind', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    press(term, '/copy c')
    expect(term.captured).toContain('code')
    expect(term.captured).toContain('cmd')
    press(term, '\t')
    expect(term.captured).toContain('/copy code ')
    tui.dispose()
  })

  it('completes @ paths from the injected listing', () => {
    const listing = (dir: string): readonly DirEntry[] | undefined => {
      if (dir === '/proj') {
        return [
          { name: 'src', directory: true },
          { name: 'README.md', directory: false },
        ]
      }
      if (dir === '/proj/src') return [{ name: 'index.ts', directory: false }]
      return undefined
    }
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, {
      cwd: '/proj',
      home: '/home/me',
      listDir: listing,
    })
    press(term, '@')
    expect(term.captured).toContain('src/')
    expect(term.captured).toContain('README.md')
    expect(term.captured).not.toContain('/src/')
    press(term, '\t')
    expect(term.captured).toContain('@src/')
    expect(term.captured).toContain('index.ts')
    press(term, '\t')
    expect(term.captured).toContain('@src/index.ts ')
    tui.dispose()
  })

  it('lists session mentions under the @ menu when a session searcher is injected', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, {
      cwd: '/proj',
      home: '/home/me',
      listDir: () => [{ name: 'README.md', directory: false }],
      autocompleteDebounceMs: 0,
      searchSessions: async () => [{ sessionId: 'session-a', label: 'Research notes' }],
    })
    press(term, '@')
    await new Promise(resolve => { setTimeout(resolve, 10) })
    expect(stripAnsi(term.captured)).toContain('Files & folders')
    expect(stripAnsi(term.captured)).toContain('Session conversations')
    expect(stripAnsi(term.captured)).toContain('Research notes')
    press(term, '\x1b[B\t')
    expect(stripAnsi(term.captured)).toContain(formatSessionReferenceMention({
      sessionId: SessionId('session-a'),
      label: 'Research notes',
    }))
    tui.dispose()
  })

  it('lists file-reference candidates in the @ menu', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, {
      cwd: '/proj',
      home: '/home/me',
      listDir: () => [],
      autocompleteDebounceMs: 0,
      searchFileMentions: async () => [
        { path: 'README.md', kind: 'file' },
        { path: 'src', kind: 'directory' },
      ],
    })
    press(term, '@')
    await new Promise(resolve => { setTimeout(resolve, 10) })
    expect(stripAnsi(term.captured)).toContain('README.md')
    expect(stripAnsi(term.captured)).toContain('src/')
    press(term, '\t')
    expect(stripAnsi(term.captured)).toContain('@README.md')
    tui.dispose()
  })

  it('updates @ suggestions from asynchronous recursive project search', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, {
      cwd: '/proj/app',
      projectRoot: '/proj',
      home: '/home/me',
      listDir: () => [],
      autocompleteDebounceMs: 0,
      searchFiles: async (_root, query) => query === 'index'
        ? [{ path: 'src/index.ts', directory: false }]
        : [],
    })

    press(term, '@index')
    await new Promise(resolve => { setTimeout(resolve, 10) })

    expect(stripAnsi(term.captured)).toContain('src/index.ts')
    tui.dispose()
  })

  it('ignores a stale @ search response after the query changes', async () => {
    const pending = new Map<string, (entries: readonly ProjectPathEntry[]) => void>()
    const searchFiles: PathSearcher = async (_root, query) => new Promise((resolve) => {
      pending.set(query, resolve)
    })
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, {
      cwd: '/proj',
      projectRoot: '/proj',
      home: '/home/me',
      listDir: () => [],
      autocompleteDebounceMs: 0,
      searchFiles,
    })

    press(term, '@a')
    await new Promise(resolve => { setTimeout(resolve, 5) })
    press(term, 'b')
    await new Promise(resolve => { setTimeout(resolve, 5) })
    expect([...pending.keys()]).toEqual(['a', 'ab'])

    pending.get('ab')?.([{ path: 'ab-new.ts', directory: false }])
    await new Promise(resolve => { setTimeout(resolve, 5) })
    expect(stripAnsi(term.captured)).toContain('ab-new.ts')

    const beforeStale = term.captured.length
    pending.get('a')?.([{ path: 'a-old.ts', directory: false }])
    await new Promise(resolve => { setTimeout(resolve, 5) })
    expect(stripAnsi(term.captured.slice(beforeStale))).not.toContain('a-old.ts')
    tui.dispose()
  })

  it('opens bare-word path suggestions on Tab and completes on a second Tab', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, {
      cwd: '/proj',
      home: '/home/me',
      listDir: (dir) => dir === '/proj'
        ? [
          { name: 'src', directory: true },
          { name: 'README.md', directory: false },
        ]
        : undefined,
    })
    press(term, 'READ')
    expect(term.captured).not.toContain('README.md')
    press(term, '\t')
    expect(term.captured).toContain('README.md')
    expect(term.captured).not.toContain('README.md ')
    press(term, '\t')
    expect(term.captured).toContain('README.md ')
    tui.dispose()
  })

  it('does not replace the slash popup with file listings', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', copyToClipboard, {
      cwd: '/proj',
      listDir: () => [{ name: 'src', directory: true }],
    })
    press(term, '/')
    expect(term.captured).toContain('/help')
    expect(term.captured).not.toContain('src/')
    tui.dispose()
  })

  it('navigates suggestions with up/down instead of history', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const first = tui.readline()
    press(term, 'one\r')
    await first
    const pending = tui.readline()
    press(term, '/')
    press(term, '\x1b[A')
    press(term, '\r')
    expect(await pending).toBe(null)
    tui.dispose()
  })

  it('copies the last assistant reply on /copy', async () => {
    const copied: string[] = []
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', async (text) => { copied.push(text) })
    const pending = tui.readline()
    tui.event(ev('assistant/message', {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text: 'hello from the model' }] },
    }, 1))
    press(term, '/copy text\r')
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(copied).toEqual(['hello from the model'])
    expect(term.captured).toContain('Copied assistant text')
    press(term, 'ok\r')
    expect(await pending).toBe('ok')
    tui.dispose()
  })

  it('opens the /copy picker and copies the selected row', async () => {
    const copied: string[] = []
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', async (text) => { copied.push(text) })
    const pending = tui.readline()
    tui.event(ev('assistant/message', {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text: 'hello from the model' }] },
    }, 1))
    press(term, '/copy\r')
    expect(term.captured).toContain('hello from the model')
    expect(term.captured).toContain('enter copy')
    expect(copied).toEqual([])
    press(term, '\r')
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(copied).toEqual(['hello from the model'])
    expect(term.captured).toContain('Copied last message')
    press(term, 'ok\r')
    expect(await pending).toBe('ok')
    tui.dispose()
  })

  it('reports nothing to copy and rejects unknown /copy args', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false, 'dark', async () => { throw new Error('unused') })
    const pending = tui.readline()
    press(term, '/copy\r')
    expect(term.captured).toContain('Nothing to copy.')
    press(term, '/copy nope\r')
    expect(term.captured).toContain('Usage: /copy [code|cmd]')
    press(term, 'ok\r')
    expect(await pending).toBe('ok')
    tui.dispose()
  })

  it('opens long command catalogs at their heading instead of their tail', () => {
    const cases = [
      {
        command: '/help\r',
        heading: 'Commands · 31 core',
        prepare: (tui: LocalTui): void => {
          tui.setCommands(Array.from({ length: 24 }, (_, index) => ({
            name: `runtime-${index}`,
            description: `Runtime command ${index} with a deliberately descriptive explanation`,
          })))
        },
      },
      {
        command: '/tools\r',
        heading: 'Available Tools',
        prepare: (tui: LocalTui): void => {
          tui.setTools(Array.from({ length: 24 }, (_, index) => ({
            name: `tool-${index}`,
            description: `Tool ${index} performs a concrete operation for the active agent`,
          })))
        },
      },
    ]

    for (const entry of cases) {
      const term = new FakeTerminal()
      const tui = new LocalTui(term, 'm', false)
      entry.prepare(tui)
      const before = term.captured.length
      press(term, entry.command)
      expect(stripAnsi(term.captured.slice(before))).toContain(entry.heading)
      tui.dispose()
    }
  })

  it('treats /exit as quit', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const pending = tui.readline()
    press(term, '/exit\r')
    expect(await pending).toBe(null)
    tui.dispose()
  })

  it('lists agent tools on /tools after setTools', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const pending = tui.readline()
    press(term, '/tools\r')
    expect(term.captured).toContain('Available Tools')
    expect(term.captured).toContain('0 active')
    expect(term.captured).toContain('No tools are currently visible to the agent.')
    tui.setTools([
      { name: 'bash', description: 'Run a shell command and return its complete output with COMPLETE_TAIL metadata for diagnostics.' },
      { name: 'fs', description: '' },
    ])
    press(term, '/tools\r')
    expect(term.captured).toContain('2 active')
    expect(term.captured).toContain('Tool')
    expect(term.captured).toContain('Description')
    expect(term.captured).toContain('bash')
    expect(term.captured).toContain('Run a shell command')
    expect(term.captured).toContain('Descriptions shortened')
    expect(term.captured).not.toContain('COMPLETE_TAIL')
    expect(term.captured).toContain('No description provided.')
    press(term, '\x0f')
    expect(term.captured).toContain('COMPLETE_TAIL')
    expect(term.captured).toContain('Collapse descriptions')
    press(term, 'ok\r')
    expect(await pending).toBe('ok')
    tui.dispose()
  })

  it('runs /help locally and keeps readline pending', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const pending = tui.readline()
    press(term, '/help\r')
    expect(term.captured).toContain('/settings, /set')
    expect(term.captured).toContain('Essential Shortcuts')
    expect(term.captured).toContain('/help [full]')
    press(term, '/help full\r')
    for (let index = 0; index < 12; index += 1) press(term, '\x1b[6~')
    expect(term.captured).toContain('Keyboard Shortcuts')
    expect(term.captured).toContain('Navigation')
    expect(term.captured).not.toContain('/hotkeys')
    press(term, 'hi\r')
    expect(await pending).toBe('hi')
    tui.dispose()
  })

  it('submits a namespaced skill command from the flat command catalog', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    tui.setCommands([{ name: 'skill:code-review', description: 'Review a change for correctness' }])
    const pending = tui.readline()
    press(term, '/skill:code-review focus on auth\r')
    expect(await pending).toBe('/skill:code-review focus on auth')
    tui.dispose()
  })

  it('exposes the interactive /access command without a raw input hint', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    tui.setCommands([
      { name: 'access', description: 'Choose the session access level' },
    ])
    const pending = tui.readline()
    press(term, '/mode\r')
    expect(stripAnsi(term.captured)).toContain('unknown command: /mode')
    press(term, '/access\r')
    expect(await pending).toBe('/access')
    tui.dispose()
  })

  it('opens the settings overlay on /settings and cycles theme', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const pending = tui.readline()
    press(term, '/settings\r')
    expect(term.captured).toContain('Settings')
    expect(term.captured).toContain('Theme')
    expect(term.captured).toContain('dark')
    press(term, '\r')
    expect(term.captured).toContain('light')
    press(term, '\x1b')
    return new Promise<void>((resolve) => {
      setTimeout(async () => {
        press(term, 'after\r')
        expect(await pending).toBe('after')
        tui.dispose()
        resolve()
      }, 120)
    })
  })

  it('hides the terminal cursor while the non-editable settings overlay is open', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    void tui.readline()
    const beforeOpen = term.captured.length
    press(term, '/settings\r')
    expect(term.captured.slice(beforeOpen)).toContain('\x1b[?25l')
    const beforeClose = term.captured.length
    press(term, '\x03')
    expect(term.captured.slice(beforeClose)).toContain('\x1b[?25h')
    tui.dispose()
  })

  it('opens settings from the /set alias', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    void tui.readline()
    press(term, '/set\r')
    expect(term.captured).toContain('Settings')
    expect(term.captured).toContain('Color palette')
    tui.dispose()
  })

  it('keeps individual settings out of slash-command arguments', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    void tui.readline()
    press(term, '/settings theme\r')
    expect(term.captured).toContain('Usage: /settings')
    tui.dispose()
  })

  it('opens and persists lighter activity detail modes', async () => {
    const persisted: string[] = []
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    tui.setPrefsPersist((prefs) => { persisted.push(prefs.activityDetail ?? 'standard') })
    const pending = tui.readline()

    press(term, '/detail\r')
    expect(term.captured).toContain('Activity detail')
    expect(term.captured).toContain('standard')
    press(term, '\x1b[C')
    expect(persisted).toEqual(['compact'])
    expect(term.captured).toContain('One-line reasoning, tools, and todo progress')
    press(term, '\x03')

    const beforeSwitch = term.captured.length
    press(term, '/detail minimal\r')
    expect(term.captured.slice(beforeSwitch)).toContain('\x1b[3J')
    expect(persisted).toEqual(['compact', 'minimal'])
    expect(term.captured).toContain('Activity detail: minimal')

    press(term, '/detail noisy\r')
    expect(term.captured).toContain('Usage: /detail [standard|compact|minimal|quiet]')
    press(term, 'ok\r')
    expect(await pending).toBe('ok')
    tui.dispose()
  })

  it('persists theme changes made in the settings overlay', async () => {
    const persisted: Array<{ theme: string; colors: boolean }> = []
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    tui.setPrefsPersist((prefs) => { persisted.push(prefs) })
    const pending = tui.readline()
    press(term, '/settings\r')
    press(term, '\r')
    expect(persisted).toEqual([{
      theme: 'light',
      colors: false,
      expandTools: false,
      activityDetail: 'standard',
      checkUpdates: true,
      startupChangelog: 'summary',
      statusBar: {
        enabled: true,
        labels: 'compact',
        groups: ['context', 'cache', 'tokens', 'speed', 'durations', 'counts'],
        order: ['context', 'cache', 'tokens', 'speed', 'durations', 'counts'],
        meta: ['model', 'effort', 'path', 'git'],
        metaOrder: ['model', 'effort', 'path', 'git'],
        colors: {
          model: 'default',
          effort: 'default',
          path: 'default',
          git: 'default',
          metrics: 'default',
          context: 'default',
          cache: 'default',
          tokens: 'default',
          speed: 'default',
          durations: 'default',
          counts: 'default',
        },
        sides: {
          model: 'left',
          effort: 'left',
          path: 'right',
          git: 'right',
          context: 'left',
          cache: 'left',
          tokens: 'left',
          speed: 'left',
          durations: 'right',
          counts: 'right',
        },
      },
    }])
    press(term, '\x03')
    tui.applyStoredPrefs({ theme: 'dark', colors: true, expandTools: false })
    expect(term.captured).not.toContain('Theme: dark')
    press(term, 'ok\r')
    expect(await pending).toBe('ok')
    tui.dispose()
  })

  it('does not submit /clear as a prompt', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const pending = tui.readline()
    tui.event(ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'keep-me' }] }, 1))
    press(term, '/clear\r')
    press(term, 'next\r')
    expect(await pending).toBe('next')
    tui.dispose()
  })

  it('treats an unknown slash command as a local notice', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const pending = tui.readline()
    press(term, '/nope\r')
    expect(term.captured).toContain('unknown command: /nope')
    press(term, 'ok\r')
    expect(await pending).toBe('ok')
    tui.dispose()
  })

  it('opens history search on ctrl+r', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const first = tui.readline()
    press(term, 'find the files\r')
    await first
    void tui.readline()
    press(term, '\x12')
    expect(term.captured).toContain('Search History')
    expect(term.captured).toContain('find the files')
    tui.dispose()
  })

  it('filters history and inserts a match without submitting', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const first = tui.readline()
    press(term, 'aaa\r')
    await first
    const second = tui.readline()
    press(term, 'unique zebra\r')
    await second
    const pending = tui.readline()
    press(term, '\x12')
    press(term, 'zebra')
    expect(term.captured).toContain('unique zebra')
    press(term, '\r')
    press(term, '\r')
    expect(await pending).toBe('unique zebra')
    tui.dispose()
  })

  it('cancels history search on Escape and restores the editor', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const first = tui.readline()
    press(term, 'keep\r')
    await first
    const pending = tui.readline()
    press(term, 'draft')
    press(term, '\x12')
    press(term, '\x1b')
    return new Promise<void>((resolve) => {
      setTimeout(async () => {
        press(term, '\r')
        expect(await pending).toBe('draft')
        tui.dispose()
        resolve()
      }, 120)
    })
  })

  it('closes history search on Ctrl-C without interrupting', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    let fired = 0
    tui.onInterrupt(() => { fired += 1 })
    tui.setStatus('running')
    press(term, '\x12')
    press(term, '\x03')
    expect(fired).toBe(0)
    expect(term.captured).toContain('Search History')
    tui.dispose()
  })

  it('dismisses the slash popup on Escape without interrupting', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    let fired = 0
    tui.onInterrupt(() => { fired += 1 })
    press(term, '/')
    press(term, '\x1b')
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(fired).toBe(0)
        tui.dispose()
        resolve()
      }, 120)
    })
  })

  it('scrolls the clipped transcript with pageUp and pageDown', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    for (let i = 0; i < 16; i += 1) {
      tui.event(ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'mark-' + i }] }, i))
    }
    // Follow mode renders the full transcript and lets the terminal's native
    // scrollback keep it; no in-frame scroll indicators.
    expect(term.captured).toContain('mark-15')
    expect(term.captured).not.toContain('earlier lines')
    expect(term.captured).not.toContain('later line')
    press(term, '\x1b[5~')
    expect(term.captured).toContain('later line')
    const beforeDraft = term.captured.length
    press(term, 'draft while reading history')
    expect(stripAnsi(term.captured.slice(beforeDraft))).toContain('draft while reading history')
    const before = term.captured.length
    tui.event(ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'NEW-TAIL' }] }, 99))
    expect(term.captured.slice(before)).not.toContain('NEW-TAIL')
    for (let i = 0; i < 24; i += 1) press(term, '\x1b[6~')
    expect(term.captured).toContain('NEW-TAIL')
    tui.dispose()
  })

  it('expands tool output when expandTools pref is on', () => {
    const term = new FakeTerminal()
    term.height = () => 80
    const tui = new LocalTui(term, 'm', false)
    tui.applyStoredPrefs({ theme: 'dark', colors: false, expandTools: true })
    const output = Array.from({ length: 14 }, (_, i) => 'tool-line-' + i).join('\n')
    tui.event(ev('tool/call', { callId: 'call-1', name: 'bash', arguments: '{}' }, 1))
    tui.event(ev('tool/result', {
      message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: output }] }] },
    }, 2))
    expect(term.captured).toContain('tool-line-13')
    expect(term.captured).not.toContain('Ctrl+O: Expand')
    tui.dispose()
  })

  it('toggles truncated tool output on ctrl+o', () => {
    const term = new FakeTerminal()
    term.height = () => 80
    const tui = new LocalTui(term, 'm', false)
    const output = Array.from({ length: 14 }, (_, i) => 'tool-line-' + i).join('\n')
    tui.event(ev('tool/call', { callId: 'call-1', name: 'bash', arguments: '{}' }, 1))
    tui.event(ev('tool/result', {
      message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: output }] }] },
    }, 2))
    expect(term.captured).toContain('tool-line-0')
    expect(term.captured).toContain('Ctrl+O: Expand')
    expect(term.captured).not.toContain('tool-line-13')
    press(term, '\x0f')
    expect(term.captured).toContain('tool-line-13')
    const afterExpand = term.captured.length
    press(term, '\x0f')
    expect(term.captured.slice(afterExpand)).toContain('Ctrl+O: Expand')
    expect(term.captured.slice(afterExpand)).not.toContain('tool-line-13')
    tui.dispose()
  })

  it('restarts lighter projections before ctrl+o reveals a hidden tool', () => {
    const term = new FakeTerminal()
    term.height = () => 80
    const tui = new LocalTui(term, 'm', false)
    tui.applyStoredPrefs({ theme: 'dark', colors: false, expandTools: false, activityDetail: 'quiet' })
    tui.event(ev('tool/call', { callId: 'call-hidden', name: 'bash', arguments: '{}' }, 1))
    tui.event(ev('tool/result', {
      message: { role: 'user', content: [{
        type: 'tool-result', toolCallId: 'call-hidden', content: [{ type: 'text', text: 'HIDDEN-OUTPUT' }],
      }] },
    }, 2))
    expect(term.captured).not.toContain('HIDDEN-OUTPUT')

    const beforeExpand = term.captured.length
    press(term, '\x0f')
    const expanded = term.captured.slice(beforeExpand)
    expect(expanded).toContain('\x1b[3J')
    expect(expanded).toContain('HIDDEN-OUTPUT')
    tui.dispose()
  })

  it('focuses the task launcher with down and activates an agent through the hub', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const opened: string[] = []
    tui.onInspectSubagent(id => { opened.push(id) })
    tui.setSubagents({
      agents: [
        { id: 'child-1', depth: 1, label: 'Explore auth', phase: 'running', activity: [] },
        { id: 'child-2', depth: 1, label: 'Review tests', phase: 'waiting', activity: [] },
      ],
    })

    press(term, '\x1b[B')
    expect(term.captured).toContain('Enter open · Esc return')
    press(term, '\r')
    expect(term.captured).toContain('Agent Hub')
    expect(term.captured).toContain('type to filter · ↑↓ navigate')
    press(term, '\x1b[B')
    press(term, '\r')
    await flushAsyncPaste()

    expect(opened).toEqual(['child-2'])
    tui.dispose()
  })

  it('steers a writable inspected subagent without resolving parent input', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const steered: string[] = []
    tui.onInspectSubmit(submission => { steered.push(submission.text) })
    const pending = tui.readInput()
    tui.setInspectedSubagent({
      id: 'child-1', label: 'Explore auth', phase: 'waiting', mode: 'continuable', writable: true,
    })
    press(term, 'keep going\r')
    expect(steered).toEqual(['keep going'])
    tui.dispose()
    expect(await pending).toBe(null)
  })

  it('clears a writable inspect draft on Escape before leaving', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const closed: number[] = []
    tui.onInspectClose(() => { closed.push(1) })
    tui.setInspectedSubagent({
      id: 'child-1', label: 'Explore auth', phase: 'waiting', mode: 'continuable', writable: true,
    })
    press(term, 'draft')
    press(term, '\x1b')
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(closed).toEqual([])
        press(term, '\x1b')
        setTimeout(() => {
          expect(closed).toEqual([1])
          tui.dispose()
          resolve()
        }, 120)
      }, 120)
    })
  })

  it('hides the composer cursor while a read-only inspect is open', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    term.captured = ''
    tui.setInspectedSubagent({
      id: 'child-1', label: 'Explore auth', phase: 'running', writable: false,
    })
    expect(term.captured).toContain('\x1b[?25l')
    term.captured = ''
    tui.setInspectedSubagent({
      id: 'child-1', label: 'Explore auth', phase: 'waiting', mode: 'continuable', writable: true,
    })
    expect(term.captured).toContain('\x1b[?25h')
    expect(term.captured).not.toContain('\x1b[?25l')
    tui.dispose()
  })

  it('returns from an inspected subagent on Escape', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const closed: number[] = []
    tui.onInspectClose(() => { closed.push(1) })
    tui.setInspectedSubagent({ id: 'child-1', label: 'Explore auth', phase: 'running', writable: false })
    press(term, '\x1b')
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(closed).toEqual([1])
        tui.dispose()
        resolve()
      }, 120)
    })
  })

  it('does not type SGR mouse reports into the editor', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const pending = tui.readline()
    press(term, '\x1b[<0;4;8M')
    press(term, 'ok\r')
    expect(await pending).toBe('ok')
    tui.dispose()
  })

  it('does not type terminal protocol replies into the editor', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const pending = tui.readline()
    press(term, '\x1b[?1;')
    press(term, '2c')
    press(term, '\x1b[?' + '1;'.repeat(24))
    press(term, '2c')
    press(term, '\x1b[>0;276;0c')
    press(term, '\x1b]10;rgb:ffff/')
    press(term, 'ffff/ffff\x1b\\')
    press(term, 'ok\r')
    expect(await pending).toBe('ok')
    tui.dispose()
  })

  it('reserves shift+up for sent-prompt history instead of transcript scroll', async () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    const submitted = tui.readline()
    press(term, 'saved prompt\r')
    await submitted
    void tui.readline()
    for (let i = 0; i < 16; i += 1) {
      tui.event(ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'row-' + i }] }, i))
    }
    const before = term.captured.length
    press(term, '\x1b[1;2A')
    expect(stripAnsi(term.captured.slice(before))).toContain('saved prompt')
    expect(stripAnsi(term.captured.slice(before))).not.toContain('later line')
    tui.dispose()
  })

  it('replays the full transcript when Ctrl+T requests recovery', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    tui.event(ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'recover me' }] }, 1))
    const before = term.captured.length

    press(term, '\x14')

    const repaint = term.captured.slice(before)
    expect(repaint).toContain('\x1b[3J')
    expect(stripAnsi(repaint)).toContain('recover me')
    tui.dispose()
  })

  it('releases the tty on dispose', () => {
    const term = new FakeTerminal()
    const tui = new LocalTui(term, 'm', false)
    tui.dispose()
    expect(term.raw).toBe(false)
    expect(term.destroyed).toBe(true)
  })
})

describe('LocalTui (plain)', () => {
  it('reads lines from a non-tty stream and quits on EOF', async () => {
    const term = new FakeTerminal()
    term.input.isTTY = false
    term.output.isTTY = false
    const tui = new LocalTui(term, 'm', false)
    const first = tui.readline()
    press(term, 'hello\n')
    expect(await first).toBe('hello')
    const second = tui.readline()
    term.input.end()
    expect(await second).toBe(null)
    tui.dispose()
  })

  it('routes a human-interaction answer before the outstanding runner readline', async () => {
    const term = new FakeTerminal()
    term.input.isTTY = false
    term.output.isTTY = false
    const tui = new LocalTui(term, 'm', false)
    const runnerLine = tui.readline()
    const answer = tui.prompt({ title: 'Approval', question: 'Continue?' })
    press(term, 'yes\n')
    expect(await answer).toBe('yes')
    press(term, 'next prompt\n')
    expect(await runnerLine).toBe('next prompt')
    tui.dispose()
  })

  it('prints settled blocks only', async () => {
    const term = new FakeTerminal()
    term.input.isTTY = false
    term.output.isTTY = false
    const tui = new LocalTui(term, 'm', false)
    tui.event(ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'q' }] }, 1))
    tui.event(ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'partial' } }, 2))
    expect(term.captured).toContain('q')
    expect(term.captured).not.toContain('partial')
    tui.event(ev('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'final' }] } }, 3))
    expect(term.captured).toContain('final')
    tui.dispose()
  })

  it('prints the full tool body in plain mode', () => {
    const term = new FakeTerminal()
    term.input.isTTY = false
    term.output.isTTY = false
    const tui = new LocalTui(term, 'm', false)
    const output = Array.from({ length: 14 }, (_, i) => 'plain-line-' + i).join('\n')
    tui.event(ev('tool/call', { callId: 'call-1', name: 'bash', arguments: '{}' }, 1))
    tui.event(ev('tool/result', {
      message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: output }] }] },
    }, 2))
    expect(term.captured).toContain('plain-line-13')
    expect(term.captured).not.toContain('ctrl+o')
    tui.dispose()
  })
})
