/**
 * TUI capability seam — local terminal provider.

 * Owns the tty: raw-mode key input (editing, history, slash/tab
 * autocomplete, /settings overlay, /copy picker, live Trajectory workspace, Ctrl-R history search,
 * PgUp/PgDn transcript scroll, Shift+Up/Down prompt history, Ctrl-O tool
 * expand, bracketed paste, double-Escape conversation rewind, double Ctrl-C exit, Ctrl-D quit),
 * SIGWINCH reflow, and the differential renderer. In non-tty mode
 * (pipes, CI) it degrades to line-based input with plain append-only
 * printing of settled blocks.
 * @module @agi-fans/dsh-tui
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  TUI_SERVICE,
  type TuiCommand,
  type TuiPrompt,
  type TuiNoticeOptions,
  type TuiRecentSession,
  type TuiService,
  type TuiSessionControls,
  type TuiSessionStats,
  type TuiSessionManagerResult,
  type TuiSessionManagerSource,
  type TuiActiveTranscriptSource,
  type TuiStatus,
  type TuiInputImage,
  type TuiInspectedSubagent,
  type TuiLoopStatus,
  type TuiSubagentRoster,
  type TuiSubmission,
  type TuiTrajectoryOptions,
  type TuiTrajectorySource,
} from '../definition.ts'
import {
  applySlashCompletion,
  formatHelpText,
  parseSlashInput,
  resolveSlashCommand,
  slashSuggestions,
  type AutocompleteItem,
  type SlashCommand,
  BUILTIN_SLASH_COMMANDS,
} from '../views/autocomplete.ts'
import {
  applyPathCompletion,
  defaultPathSource,
  editorLineAt,
  findPathToken,
  parsePathPrefix,
  pathSuggestions,
  searchPathSuggestions,
  type DirReader,
  type PathSearcher,
} from '../views/path-complete.ts'
import { activeAtToken } from '@deepseek-ai/dsh-file-reference/grammar'
import {
  nextSelectableAutocompleteIndex,
  searchAtSuggestions,
  type FileSearcher,
  type SessionSearcher,
} from '../views/at-complete.ts'
import { copyToClipboard, readFromClipboard, type ClipboardReader, type ClipboardWriter } from '../input/clipboard.ts'
import {
  applyCopySelectorEvent,
  createCopySelector,
  type CopySelectorState,
} from '../views/copy-selector.ts'
import { buildCopyTargets, extractCopyTarget, parseCopyKind } from '../views/copy-targets.ts'
import {
  applyHistorySearchEvent,
  createHistorySearch,
  type HistorySearchState,
} from '../views/history-search.ts'
import { type EditorCommand, InputEditor, lineEnd, lineStart } from '../input/editor.ts'
import {
  applySettingsEvent,
  createSettings,
  type SettingsState,
  type TuiPrefs,
} from '../views/settings-list.ts'
import {
  applyEvent,
  blockLines,
  initialTranscript,
  replayEvents,
  renderView,
  type Block,
  type TranscriptState,
} from '../views/event-views.ts'
import { flushPending, parseKeys, type KeyEvent } from '../input/keys.ts'
import { type RenderSink } from '../chrome/renderer.ts'
import { MainScreenRenderer } from '../chrome/main-screen-renderer.ts'
import { createTheme, detectTrueColor, parseThemeName, type ThemeName } from '../chrome/theme.ts'
import { cursorOnWrapped, indexOnWrapped, wrapIndexed } from '../chrome/width.ts'
import type { ToolInfo } from '../chrome/tools-list.ts'
import type { TuiToolPresentation } from '../chrome/tool-renderers.ts'
import { TUI_SETTINGS_NAMESPACE, TuiSettingsSchema } from '../session/tui-settings.ts'
import { defaultStatusBarConfig, resolveStatusBarConfig, type StatusBarConfig } from '../chrome/status-config.ts'
import { encodeHostTelemetryOsc, hostTelemetryPayload } from '../chrome/host-telemetry.ts'
import { sessionStatusGroups } from '../chrome/status-line.ts'
import { HistoryStore } from '../views/history-store.ts'
import {
  addTrajectoryDiagnostic,
  appendTrajectoryEvent,
  applyTrajectoryEvent,
  createTrajectoryState,
  parseTrajectoryOptions,
  renderTrajectory,
  setTrajectoryLoading,
  setTrajectorySessions,
  setTrajectorySnapshot,
  type TrajectoryState,
} from '../views/trajectory.ts'
import {
  applySessionManagerEvent,
  createSessionManagerState,
  renderSessionManager,
  setSessionManagerHydrating,
  setSessionManagerLoading,
  setSessionManagerSessions,
  setSessionManagerSnapshot,
  visibleManagerSessions,
  type SessionManagerState,
} from '../views/session-manager.ts'
import { loadKeybindings, type TuiAction } from '../input/keybindings-config.ts'
import { editExternally } from '../input/external-editor.ts'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-settings'
import {
  movePromptSelection,
  filteredPromptOptions,
  selectedPromptAnswer,
  selectedFilteredPromptAnswer,
  togglePromptSelection,
  type PromptSelectorState,
} from '../views/prompt-selector.ts'
import { resolveProjectContext } from '../session/project-context.ts'
import { pickWelcomeTips, type WelcomeTip } from '../chrome/welcome-tips.ts'
import { formatEssentialHotkeysText, formatHotkeysText, hotkeyCount } from '../views/hotkeys.ts'
import {
  imageMarker,
  imagePathCandidates,
  probeImageDimensions,
  stripComposerImageMarkers,
  readImageFile,
  readImageFromClipboard,
  readMacClipboardFiles,
  type ClipboardFileReader,
  type ClipboardImageReader,
  type ImagePathReader,
} from '../input/image-paste.ts'
import { APP_NAME, APP_VERSION } from '../session/package-metadata.ts'
import { ACTIVITY_DETAIL_MODES, isActivityDetailMode, type ActivityDetailMode } from '../session/activity-detail.ts'
import type { StartupChangelogMode } from '../session/release-notes.ts'

const DOUBLE_CTRL_C_MS = 500
const DOUBLE_ESCAPE_MS = 500
const MAX_PENDING_ESCAPE_BYTES = 4096
// Streaming reparses the growing live Markdown block; leave event-loop time for raw-key input.
const DEFAULT_STREAM_RENDER_MS = 50
// Spinner frames advance with real Agent/roster events. A cosmetic interval
// must never repaint the complete durable transcript while the model is idle
// between events: that periodic work competes directly with raw-key input.
const HOST_TELEMETRY_HEARTBEAT_MS = 30_000

/**
 * Recover a multiline clipboard write when the terminal host omitted bracketed-paste markers.
 *
 * Interactive typing arrives as separate raw-data chunks in practice. A single printable chunk
 * containing an embedded line break and more text afterwards is therefore paste-shaped. Treating
 * it as text keeps CR/LF inside the composer instead of turning every row into Enter/queued turns.
 */
export function unbracketedMultilinePaste(input: string): string | undefined {
  if (input.includes('\x1b') || !/[\r\n]/u.test(input)) return undefined
  for (const character of input) {
    const code = character.charCodeAt(0)
    if (code < 0x20 && character !== '\r' && character !== '\n' && character !== '\t') return undefined
  }
  const normalized = input.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  const firstBreak = normalized.indexOf('\n')
  if (firstBreak < 0 || normalized.slice(firstBreak + 1).length === 0) return undefined
  return normalized
}

function shortenPath(cwd: string): string {
  const home = homedir()
  if (cwd === home) return '~'
  if (cwd.startsWith(home + '/')) return '~' + cwd.slice(home.length)
  return cwd
}

export const name = 'omdsh-tui'

/** Plugin config: the model label shown on the status line. */
export interface Config {
  /** Model name for the status line. */
  model: string
  /** Emit SGR color sequences; defaults to the output stream's tty-ness. */
  colors?: boolean
  /** Shipped palette; defaults to dark. */
  theme?: string
  /** Optional JSONL prompt-history path. */
  historyPath?: string
  /** Optional `{ key-id: action }` JSON file. */
  keybindingsPath?: string
}

/** The minimal terminal surface a LocalTui drives (process streams satisfy it). */
export interface TerminalLike {
  output: RenderSink & { isTTY?: boolean }
  input: NodeJS.ReadableStream & {
    isTTY?: boolean
    setRawMode?(on: boolean): void
    destroy?(): void
  }
  /** Current width in columns. */
  width(): number
  /** Current height in rows. */
  height(): number
  /** Optional resize subscription; returns a disposer. */
  onResize?(listener: () => void): () => void
  /** Optional terminal-host bridge for the current safe transcript source. */
  bindActiveTranscriptSource?(source?: TuiActiveTranscriptSource): void
}

type PendingRead = { resolve: (submission: TuiSubmission | null) => void }
type PendingPrompt = PromptSelectorState & {
  resolve: (answer: string | null) => void
  offAbort?: () => void
}
/**
 * Local terminal presentation service.
 */
function detectTerminalProfile(): 'direct' | 'multiplexer' | 'conpty' {
  if (process.env.TMUX !== undefined || process.env.STY !== undefined || process.env.ZELLIJ !== undefined) {
    return 'multiplexer'
  }
  return process.platform === 'win32' ? 'conpty' : 'direct'
}

export class LocalTui implements TuiService {
  #deferInitialRender = false
  readonly #terminalProfile: 'direct' | 'multiplexer' | 'conpty'
  readonly #resizeDebounceMs: number
  #resizeTimer: ReturnType<typeof setTimeout> | null = null
  #renderedWidth: number
  #renderedHeight: number
  #resizeWidthChanged = false
  readonly #streamRenderMs: number
  #streamRenderTimer: ReturnType<typeof setTimeout> | null = null
  #pinnedOverflow = false
  readonly #term: TerminalLike
  #model: string
  #reasoningEffort: string | undefined
  #colors: boolean
  #themeName: ThemeName
  readonly #tty: boolean
  readonly #renderer: MainScreenRenderer
  #state: TranscriptState = initialTranscript()
  #renderedBlocks: TranscriptState['blocks'] = this.#state.blocks
  #handlingInput = false
  #inputActivated = false
  readonly #editor = new InputEditor()
  #history: string[] = []
  #historyIndex = 0
  #draft = ''
  #ac: { items: AutocompleteItem[]; selected: number } | null = null
  #search: HistorySearchState | null = null
  #settings: SettingsState | null = null
  #copySelector: CopySelectorState | null = null
  #trajectory: TrajectoryState | null = null
  #trajectorySource: TuiTrajectorySource | null = null
  #trajectoryResolve: (() => void) | null = null
  #trajectoryAbort: AbortController | null = null
  #trajectoryRequestId = 0
  #trajectoryPoll: ReturnType<typeof setInterval> | null = null
  #trajectoryMouseEnabled = false
  #activeTranscriptSource: TuiActiveTranscriptSource | null = null
  #sessionManager: SessionManagerState | null = null
  #sessionManagerSource: TuiSessionManagerSource | null = null
  #sessionManagerResolve: ((result: TuiSessionManagerResult | null) => void) | null = null
  #sessionManagerAbort: AbortController | null = null
  #sessionManagerHydrateAbort: AbortController | null = null
  #sessionManagerSignalCleanup: (() => void) | null = null
  #sessionManagerRequestId = 0
  #pending: PendingRead | null = null
  #queuedSubmissions: TuiSubmission[] = []
  /** Newer queue entries temporarily detached while Up browses backward. */
  #queueEditNewer: TuiSubmission[] | null = null
  #queueEditPending = false
  #quitRequested = false
  #resumeHintRequested = false
  #lastSigintTime = 0
  #lastEscapeTime = 0
  #interrupts = new Set<() => void>()
  #queueEdits = new Set<() => void>()
  #rewinds = new Set<() => void>()
  #inspects = new Set<(id: string) => void>()
  #inspectCloses = new Set<() => void>()
  #inspectSubmits = new Set<(submission: TuiSubmission) => void>()
  #disposed = false
  #pendingKeys = ''
  #escapeTimer: ReturnType<typeof setTimeout> | null = null
  #resumeAfterSuspend: (() => void) | null = null
  #autocompleteTimer: ReturnType<typeof setTimeout> | null = null
  #autocompleteAbort: AbortController | null = null
  #autocompleteRequestId = 0
  #paste = false
  #pasteBuf = ''
  #pasteInFlight = 0
  #deferredPasteEvents: KeyEvent[] = []
  #images: TuiInputImage[] = []
  #lineReader: Interface | null = null
  #plainPending: PendingRead | null = null
  #plainClosed = false
  #plainPrinted = 0
  #offData: (() => void) | null = null
  #offResize: (() => void) | null = null
  #pwd: string
  #branch: string | undefined
  #spinner = 0
  #scrollStart = 0
  #maxStart = 0
  #scrollBudget = 0
  #follow = true
  #composerStart = 0
  #verticalColumn: number | undefined
  #focusBlock: number | undefined
  #expandTools = false
  #activityDetail: ActivityDetailMode = 'standard'
  #checkUpdates = true
  #startupChangelog: StartupChangelogMode = 'summary'
  #statusBar: StatusBarConfig = defaultStatusBarConfig()
  #toolsExpanded = false
  #expandedToolCalls = new Set<string>()
  #tools: ToolInfo[] = []
  #runtimeCommands: TuiCommand[] = []
  #prompt: PendingPrompt | null = null
  #recentSessions: TuiRecentSession[] = []
  readonly #welcomeTips: readonly WelcomeTip[]
  #sessionId: string | undefined
  #sessionStats: TuiSessionStats | undefined
  readonly #hostTelemetry: boolean
  #hostTelemetrySignature: string | undefined
  #hostTelemetryHeartbeat: ReturnType<typeof setInterval> | null = null
  #sessionControls: TuiSessionControls | undefined
  #loopStatus: TuiLoopStatus | undefined
  #subagents: TuiSubagentRoster | undefined
  #subagentLauncherFocused = false
  #inspected: TuiInspectedSubagent | undefined
  #promptDocument: { start: number; maxStart: number; pageSize: number } | undefined
  readonly #trueColor: boolean
  readonly #copy: ClipboardWriter
  readonly #readClipboard: ClipboardReader
  readonly #readClipboardImage: ClipboardImageReader
  readonly #readClipboardFiles: ClipboardFileReader
  readonly #readImagePath: ImagePathReader
  readonly #historyStore: HistoryStore | undefined
  readonly #keybindings: Record<string, TuiAction>
  readonly #cwd: string
  readonly #projectRoot: string
  readonly #home: string
  readonly #listDir: DirReader
  readonly #searchFiles: PathSearcher
  #searchFileMentions: FileSearcher | undefined
  #searchSessions: SessionSearcher | undefined
  #validateImageDraft: ((image: TuiInputImage) => Promise<void>) | undefined
  readonly #autocompleteDebounceMs: number
  #persistPrefs: ((prefs: TuiPrefs) => void) | null = null

  /**
   * @param term - terminal surface (injectable for tests).
   * @param model - model label for the status line.
   * @param colors - SGR styling switch.
   * @param themeName - shipped palette.
   * @param copy - clipboard writer (defaults to the platform tool).
   * @param paths - cwd/home/listing used by `@` and path autocomplete.
   */
  constructor(
    term: TerminalLike,
    model: string,
    colors: boolean,
    themeName: ThemeName = 'dark',
    copy: ClipboardWriter = copyToClipboard,
    paths: {
      cwd?: string
      projectRoot?: string
      home?: string
      listDir?: DirReader
      searchFiles?: PathSearcher
      searchFileMentions?: FileSearcher
      searchSessions?: SessionSearcher
      autocompleteDebounceMs?: number
      historyPath?: string
      keybindingsPath?: string
      readClipboard?: ClipboardReader
      readClipboardImage?: ClipboardImageReader
      readClipboardFiles?: ClipboardFileReader
      readImagePath?: ImagePathReader
      deferInitialRender?: boolean
      terminalProfile?: 'direct' | 'multiplexer' | 'conpty'
      alternateScreenOverlays?: boolean
      resizeDebounceMs?: number
      streamRenderMs?: number
      hostTelemetry?: boolean
    } = {},
  ) {
    this.#term = term
    this.#model = model
    this.#hostTelemetry = paths.hostTelemetry === true
    this.#colors = colors
    this.#themeName = themeName
    this.#copy = copy
    this.#readClipboard = paths.readClipboard ?? readFromClipboard
    this.#readClipboardImage = paths.readClipboardImage ?? readImageFromClipboard
    this.#readClipboardFiles = paths.readClipboardFiles ?? readMacClipboardFiles
    this.#historyStore = paths.historyPath === undefined ? undefined : new HistoryStore(paths.historyPath)
    this.#history = this.#historyStore?.load() ?? []
    this.#keybindings = loadKeybindings(paths.keybindingsPath)
    const fallback = defaultPathSource()
    this.#cwd = paths.cwd ?? fallback.cwd
    this.#readImagePath = paths.readImagePath ?? (path => readImageFile(path, this.#cwd))
    const project = resolveProjectContext(this.#cwd)
    this.#projectRoot = paths.projectRoot ?? project.root
    this.#home = paths.home ?? fallback.home
    this.#listDir = paths.listDir ?? fallback.listDir
    this.#searchFiles = paths.searchFiles ?? fallback.searchFiles
    this.#searchFileMentions = paths.searchFileMentions
    this.#searchSessions = paths.searchSessions
    this.#autocompleteDebounceMs = Math.max(0, paths.autocompleteDebounceMs ?? 100)
    this.#welcomeTips = pickWelcomeTips()
    this.#deferInitialRender = paths.deferInitialRender === true
    this.#terminalProfile = paths.terminalProfile ?? detectTerminalProfile()
    this.#resizeDebounceMs = Math.max(0, paths.resizeDebounceMs ?? 120)
    this.#streamRenderMs = Math.max(0, paths.streamRenderMs ?? DEFAULT_STREAM_RENDER_MS)
    this.#trueColor = colors && detectTrueColor()
    this.#tty = term.input.isTTY === true
    this.#pwd = shortenPath(project.root)
    this.#branch = project.gitLabel
    this.#renderedWidth = this.#term.width()
    this.#renderedHeight = this.#term.height()
    this.#renderer = new MainScreenRenderer(
      this.#term.output,
      {
        width: this.#renderedWidth,
        height: this.#renderedHeight,
        synchronized: this.#tty,
        clearScrollback: this.#terminalProfile === 'direct',
        alternateScreenOverlays: paths.alternateScreenOverlays === true,
      },
    )
    if (this.#tty) this.#renderer.startEpoch()
    if (!this.#deferInitialRender) this.activateInput()
    this.#render()
  }

  /** Keep the renderer's cached grid synchronized with the live terminal geometry. */
  #reconcileGeometry(widthChangedSinceLastPaint = false, forceRepaint = false): boolean {
    const width = this.#term.width()
    const height = this.#term.height()
    const widthChanged = widthChangedSinceLastPaint || width !== this.#renderedWidth
    const geometryChanged = width !== this.#renderedWidth || height !== this.#renderedHeight
    if (!geometryChanged && !forceRepaint) return false
    this.#renderer.resize(width, height)
    this.#renderedWidth = width
    this.#renderedHeight = height
    if (widthChanged && this.#terminalProfile === 'direct') {
      this.#renderer.startEpoch({ replay: this.#state.status === 'idle' ? 'full' : 'pinned' })
    } else {
      this.#renderer.reset()
    }
    return true
  }

  /** Enable composer input only after the target Agent passed resume validation. */
  activateInput(): void {
    if (this.#inputActivated || this.#disposed) return
    this.#inputActivated = true
    if (!this.#tty) return
    this.#term.input.setRawMode?.(true)
    const readable = this.#term.input as NodeJS.ReadableStream & { read?: () => unknown }
    while (readable.read?.() !== null && readable.read !== undefined) { /* discard pre-validation input */ }
    const listener = (chunk: Buffer): void => { this.#onData(chunk) }
    this.#term.input.on('data', listener)
    this.#offData = () => { this.#term.input.off('data', listener) }
    this.#offResize = this.#term.onResize?.(() => {
      this.#resizeWidthChanged ||= this.#term.width() !== this.#renderedWidth
      const repaint = (): void => {
        this.#resizeTimer = null
        const widthChanged = this.#resizeWidthChanged
        this.#resizeWidthChanged = false
        this.#reconcileGeometry(widthChanged, true)
        this.#render()
      }
      const debounce = this.#terminalProfile === 'multiplexer' || this.#resizeWidthChanged
      if (debounce && this.#resizeDebounceMs > 0) {
        if (this.#resizeTimer !== null) clearTimeout(this.#resizeTimer)
        this.#resizeTimer = setTimeout(repaint, this.#resizeDebounceMs)
      } else {
        repaint()
      }
    }) ?? null
    if (this.#reconcileGeometry()) this.#render()
    this.#term.output.write('\x1b[?2004h\x1b[>4;2m')
    if (this.#hostTelemetry) {
      this.#hostTelemetryHeartbeat = setInterval(() => { this.#publishHostTelemetry(true) }, HOST_TELEMETRY_HEARTBEAT_MS)
      this.#hostTelemetryHeartbeat.unref?.()
    }
  }

  event(event: SessionEvent, presentation?: TuiToolPresentation): void {
    this.#state = applyEvent(this.#state, event, presentation)
    this.#spinner += 1
    if (this.#trajectory !== null && this.#sessionId !== undefined) {
      this.#trajectory = appendTrajectoryEvent(this.#trajectory, this.#sessionId, event)
    }
    if (this.#tty) {
      if (event.type === 'assistant/chunk' && this.#streamRenderMs > 0) {
        this.#scheduleStreamRender()
      } else {
        this.#render()
      }
    } else if (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result' || event.type === 'turn/end') {
      this.#printPlain()
    }
  }

  setStatus(status: TuiStatus): void {
    if (this.#state.status === 'compacting') return
    const previous = this.#state.status
    this.#state = { ...this.#state, status }
    this.#spinner += 1
    if (this.#tty) {
      this.#render()
      if (previous === 'running' && status === 'idle') this.#term.output.write('\x07')
    }
  }

  setModel(model: string, reasoningEffort?: string): void {
    this.#model = model
    this.#reasoningEffort = reasoningEffort
    if (this.#tty) this.#render()
  }

  setLoopStatus(status: TuiLoopStatus | undefined): void {
    this.#loopStatus = status === undefined ? undefined : { ...status }
    if (this.#tty) this.#render()
  }

  setSubagents(roster: TuiSubagentRoster | undefined): void {
    this.#subagents = roster === undefined
      ? undefined
      : { agents: roster.agents.map(agent => ({ ...agent, activity: [...agent.activity] })) }
    if ((this.#subagents?.agents.length ?? 0) === 0) this.#subagentLauncherFocused = false
    const inspected = this.#inspected
    if (inspected !== undefined) {
      const current = this.#subagents?.agents.find(agent => agent.id === inspected.id)
      if (current !== undefined) {
        this.#inspected = {
          id: current.id,
          label: current.label,
          phase: current.phase,
          ...(current.mode === undefined ? {} : { mode: current.mode }),
          writable: current.mode === 'continuable',
        }
      }
    }
    this.#spinner += 1
    if (this.#tty) this.#render()
  }

  setInspectedSubagent(inspected: TuiInspectedSubagent | undefined): void {
    this.#inspected = inspected === undefined ? undefined : { ...inspected }
    if (inspected !== undefined) this.#subagentLauncherFocused = false
    if (this.#tty) this.#render()
  }

  setTools(tools: readonly ToolInfo[]): void {
    this.#tools = tools.map((tool) => ({ name: tool.name, description: tool.description }))
  }

  setCommands(commands: readonly TuiCommand[]): void {
    this.#runtimeCommands = commands.map((command) => ({
      name: command.name,
      description: command.description,
      ...(command.inputHint === undefined ? {} : { inputHint: command.inputHint }),
      ...(command.kind === undefined ? {} : { kind: command.kind }),
    }))
    this.#refreshAutocomplete()
    if (this.#tty) this.#render()
  }

  setSessionSearch(search?: SessionSearcher): void {
    this.#searchSessions = search
    this.#refreshAutocomplete()
    if (this.#tty) this.#render()
  }

  setFileSearch(search?: FileSearcher): void {
    this.#searchFileMentions = search
    this.#refreshAutocomplete()
    if (this.#tty) this.#render()
  }

  setImageValidator(validate?: (image: TuiInputImage) => Promise<void>): void {
    this.#validateImageDraft = validate
  }

  notice(text: string, options: TuiNoticeOptions = {}): void {
    const block: Block = {
      kind: 'notice',
      level: options.level ?? 'info',
      text,
      ...(options.framed === true ? { framed: true } : {}),
    }
    this.#state = { ...this.#state, blocks: [...this.#state.blocks, block] }
    if (this.#tty) this.#render()
    else this.#printPlain()
  }

  commandOutput(command: string, text: string): void {
    this.#state = { ...this.#state, blocks: [...this.#state.blocks, { kind: 'commandOutput', command, text }] }
    if (this.#tty) this.#render()
    else this.#printPlain()
  }

  prompt(request: TuiPrompt): Promise<string | null> {
    if (this.#trajectory !== null || this.#sessionManager !== null) {
      return Promise.reject(new Error('omdsh-tui: a full-screen workspace owns the terminal'))
    }
    if (this.#prompt !== null) return Promise.reject(new Error('omdsh-tui: prompt already in flight'))
    if (this.#disposed || request.signal?.aborted === true) return Promise.resolve(null)
    this.#editor.setText('')
    this.#ac = null
    return new Promise((resolve) => {
      const selected = Math.max(0, request.options?.findIndex(option =>
        (option.value ?? option.label) === request.initialValue) ?? 0)
      const pending: PendingPrompt = { request, selected, checked: new Set(), resolve }
      if (request.signal !== undefined) {
        const onAbort = (): void => { this.#finishPrompt(null) }
        request.signal.addEventListener('abort', onAbort, { once: true })
        pending.offAbort = () => { request.signal?.removeEventListener('abort', onAbort) }
      }
      this.#prompt = pending
      if (this.#tty) {
        this.#render()
      } else {
        const lines = [request.question]
        if (request.detail !== undefined && request.detail !== '') lines.push('', request.detail)
        if (request.options !== undefined && request.options.length > 0) {
          lines.push('', ...request.options.map((option, index) =>
            `${index + 1}. ${option.label}${option.description === undefined ? '' : ' — ' + option.description}`))
          lines.push('', request.allowCustom === false
            ? 'Choose a label or number.'
            : request.multiSelect === true
              ? 'Choose labels/numbers separated by commas, or type a custom answer.'
              : 'Choose a label/number, or type a custom answer.')
        }
        this.notice(`${request.title}\n${lines.join('\n')}`)
      }
    })
  }

  setTrajectorySource(source?: TuiTrajectorySource): void {
    this.#trajectorySource = source ?? null
    if (source === undefined && this.#trajectory !== null) this.#closeTrajectory()
  }

  setActiveTranscriptSource(source?: TuiActiveTranscriptSource): void {
    this.#activeTranscriptSource = source ?? null
    this.#term.bindActiveTranscriptSource?.(source)
  }

  #setTrajectoryMouse(enabled: boolean): void {
    if (!this.#tty || this.#trajectoryMouseEnabled === enabled) return
    this.#trajectoryMouseEnabled = enabled
    this.#term.output.write(enabled ? '\x1b[?1000h\x1b[?1006h' : '\x1b[?1006l\x1b[?1000l')
  }

  openTrajectory(source: TuiTrajectorySource, options: TuiTrajectoryOptions = {}): Promise<void> {
    if (!this.#tty) return Promise.reject(new Error('Trajectory requires an interactive terminal'))
    if (this.#disposed) return Promise.resolve()
    if (this.#trajectory !== null) return Promise.reject(new Error('Trajectory is already open'))
    if (this.#sessionManager !== null || this.#prompt !== null || this.#settings !== null || this.#copySelector !== null) {
      return Promise.reject(new Error('Close the current terminal overlay before opening Trajectory'))
    }
    this.#search = null
    this.#ac = null
    this.#trajectorySource = source
    this.#trajectory = createTrajectoryState(source.activeSessionId, options)
    this.#setTrajectoryMouse(true)
    this.#deferInitialRender = false
    this.#render()
    void this.#refreshTrajectory(true, source.activeSessionId)
    const pollMs = Math.max(500, Math.min(30_000, source.pollIntervalMs ?? 1_500))
    this.#trajectoryPoll = setInterval(() => {
      if (this.#trajectoryAbort === null) void this.#refreshTrajectory(true)
    }, pollMs)
    this.#trajectoryPoll.unref?.()
    return new Promise((resolve) => { this.#trajectoryResolve = resolve })
  }

  openSessionManager(source: TuiSessionManagerSource, signal?: AbortSignal): Promise<TuiSessionManagerResult | null> {
    if (!this.#tty) return Promise.reject(new Error('Session manager requires an interactive terminal'))
    if (this.#disposed || signal?.aborted === true) return Promise.resolve(null)
    if (this.#sessionManager !== null) return Promise.reject(new Error('Session manager is already open'))
    if (this.#trajectory !== null || this.#prompt !== null || this.#settings !== null || this.#copySelector !== null) {
      return Promise.reject(new Error('Close the current terminal overlay before opening Session Manager'))
    }
    const pending = new Promise<TuiSessionManagerResult | null>((resolve) => { this.#sessionManagerResolve = resolve })
    this.#search = null
    this.#ac = null
    this.#sessionManagerSource = source
    this.#sessionManager = createSessionManagerState(source.activeSessionId)
    if (signal !== undefined) {
      const onAbort = () => this.#closeSessionManager(null)
      signal.addEventListener('abort', onAbort, { once: true })
      this.#sessionManagerSignalCleanup = () => signal.removeEventListener('abort', onAbort)
    }
    this.#deferInitialRender = false
    this.#render()
    void this.#refreshSessionManager(true)
    return pending
  }

  replaceViewportTail(events: readonly SessionEvent[], _totalEvents?: number): void {
    if (!this.#tty || events.length === 0) return
    const state = replayEvents(events)
    this.#state = { ...state, status: 'idle', compactCommandId: undefined }
    this.#followTail()
    this.#deferInitialRender = false
    // A preview owns only the visible screen. It never commits synthetic history;
    // the validated full target starts a fresh authoritative epoch later.
    this.#renderer.startEpoch({ replay: 'tail' })
    this.#render()
  }

  replaceSession(
    events: readonly SessionEvent[],
    presentations?: ReadonlyMap<number, TuiToolPresentation>,
    status: TuiStatus = 'idle',
  ): void {
    const state = replayEvents(events, presentations)
    this.#state = { ...state, status, compactCommandId: undefined }
    this.#plainPrinted = 0
    this.#followTail()
    this.#deferInitialRender = false
    this.#renderer.startEpoch({ replay: status === 'idle' ? 'full' : 'pinned' })
    if (this.#tty) this.#render()
    else this.#printPlain()
  }

  setSession(info: {
    id: string
    recent: readonly TuiRecentSession[]
    stats?: TuiSessionStats
    controls?: TuiSessionControls
  }): void {
    this.#sessionId = info.id
    this.#recentSessions = info.recent.map((session) => ({ ...session }))
    this.#sessionStats = info.stats === undefined ? undefined : { ...info.stats }
    this.#sessionControls = info.controls === undefined
      ? undefined
      : {
          ...info.controls,
          ...(info.controls.plan === undefined ? {} : { plan: { ...info.controls.plan } }),
        }
    if (this.#tty) {
      // SessionRuntime publishes aggregate stats after every transcript event.
      // A pending chunk repaint already owns the next frame, so fold footer
      // changes into it instead of defeating stream coalescing via setSession().
      if (this.#streamRenderTimer === null) this.#render()
    }
  }

  /** Apply prefs loaded from the settings document (does not persist). */
  applyStoredPrefs(prefs: TuiPrefs): void {
    const activityDetail = prefs.activityDetail ?? 'standard'
    const activityChanged = activityDetail !== this.#activityDetail
    const expandChanged = prefs.expandTools !== this.#expandTools
    this.#themeName = prefs.theme
    this.#colors = prefs.colors
    this.#expandTools = prefs.expandTools
    this.#activityDetail = activityDetail
    this.#checkUpdates = prefs.checkUpdates ?? true
    this.#startupChangelog = prefs.startupChangelog ?? 'summary'
    this.#statusBar = resolveStatusBarConfig(prefs.statusBar, prefs.statusPreset)
    this.#toolsExpanded = prefs.expandTools
    if (this.#settings !== null) this.#settings = { ...this.#settings, prefs }
    if (this.#tty && (activityChanged || expandChanged)) this.#restartPresentationEpoch()
    if (this.#tty) this.#render()
  }

  /** Called after a live `/settings` change. */
  setPrefsPersist(persist: (prefs: TuiPrefs) => void): void {
    this.#persistPrefs = persist
  }

  readInput(): Promise<TuiSubmission | null> {
    if (this.#pending !== null) return Promise.reject(new Error('omdsh-tui: input read already in flight'))
    if (this.#disposed) return Promise.resolve(null)
    // A Ctrl-D pressed while the previous turn was still settling lands here
    // (no pending readline existed to resolve); honor it now.
    if (this.#quitRequested) {
      this.#quitRequested = false
      return Promise.resolve(null)
    }
    if (!this.#tty) return this.#readlinePlain()
    // Lines submitted while a turn was still running were queued instead of
    // dropped; serve the oldest before waiting for fresh input.
    const queued = this.#queuedSubmissions.shift()
    if (queued !== undefined) {
      this.#render()
      return Promise.resolve(queued)
    }
    return new Promise((resolve) => {
      this.#pending = { resolve }
    })
  }

  /** Compatibility helper for provider-level text editing tests and embedders. */
  async readline(): Promise<string | null> {
    return (await this.readInput())?.text ?? null
  }

  restoreInput(submission: TuiSubmission): void {
    const currentText = this.#editor.text
    const currentImages = this.#images
    let rebasedCurrent = currentText
    for (let index = currentImages.length - 1; index >= 0; index -= 1) {
      const image = currentImages[index] as TuiInputImage
      rebasedCurrent = rebasedCurrent.replaceAll(
        imageMarker(index, image),
        imageMarker(index + submission.images.length, image),
      )
    }
    const separator = submission.text !== '' && rebasedCurrent !== '' ? '\n' : ''
    this.#images = [...submission.images.map(image => ({ ...image })), ...currentImages]
    this.#editor.setText(submission.text + separator + rebasedCurrent)
    this.#refreshAutocomplete()
    if (this.#tty) this.#render()
  }

  resolveQueueEdit(submission: TuiSubmission | null): void {
    if (!this.#queueEditPending) return
    this.#queueEditPending = false
    if (submission === null) {
      if (this.#editor.text === '' && this.#images.length === 0 && this.#queueEditNewer?.length === 0) {
        this.#queueEditNewer = null
      }
      return
    }
    if (this.#queueEditNewer === null) this.#queueEditNewer = []
    if (this.#editor.text !== '' || this.#images.length > 0) {
      this.#queueEditNewer.unshift(this.#currentSubmission())
    }
    this.#replaceInput(submission)
  }

  async #refreshTrajectory(reloadList: boolean, requestedId?: string): Promise<void> {
    const source = this.#trajectorySource
    const current = this.#trajectory
    if (source === null || current === null || this.#disposed) return
    const preferredId = requestedId
      ?? current.sessions[current.selectedSession]?.id
      ?? current.snapshot?.id
      ?? source.activeSessionId
    const baselineSeq = current.snapshot?.events.reduce((maximum, event) => Math.max(maximum, event.seq), -1) ?? -1
    const requestId = ++this.#trajectoryRequestId
    this.#trajectoryAbort?.abort()
    const controller = new AbortController()
    this.#trajectoryAbort = controller
    this.#trajectory = setTrajectoryLoading(current, true)
    this.#render()
    try {
      let next = this.#trajectory
      if (next === null) return
      if (reloadList) {
        const sessions = await source.list(controller.signal)
        if (requestId !== this.#trajectoryRequestId || controller.signal.aborted || this.#trajectory === null) return
        next = setTrajectorySessions(this.#trajectory, sessions)
      }
      const preferredIndex = next.sessions.findIndex(session => session.id === preferredId)
      const id = preferredIndex >= 0
        ? preferredId
        : next.sessions[next.selectedSession]?.id ?? next.snapshot?.id ?? source.activeSessionId
      const selectedSession = next.sessions.findIndex(session => session.id === id)
      next = {
        ...next,
        ...(selectedSession < 0 ? {} : { selectedSession }),
        loading: true,
        error: undefined,
      }
      this.#trajectory = next
      const snapshot = await source.inspect(id, controller.signal)
      if (requestId !== this.#trajectoryRequestId || controller.signal.aborted || this.#trajectory === null) return
      let latest = this.#trajectory
      const responseBySeq = new Map<number, SessionEvent>()
      const diagnostics: string[] = []
      for (const remote of snapshot.events) {
        const existing = responseBySeq.get(remote.seq)
        if (existing === undefined) responseBySeq.set(remote.seq, remote)
        else if (JSON.stringify(existing) !== JSON.stringify(remote)) diagnostics.push(`snapshot same-seq conflict #${remote.seq}: kept first ${existing.type}, ignored ${remote.type}`)
      }
      const localEvents = latest.snapshot?.id === snapshot.id ? latest.snapshot.events : []
      for (const local of localEvents) {
        const remote = responseBySeq.get(local.seq)
        if (remote === undefined) {
          responseBySeq.set(local.seq, local)
          diagnostics.push(local.seq > baselineSeq
            ? `preserved post-request live event #${local.seq}`
            : `inspect omitted previously loaded event #${local.seq}`)
          continue
        }
        if (local.seq > baselineSeq && JSON.stringify(remote) !== JSON.stringify(local)) {
          // The event observed live after this request started is the only copy
          // guaranteed to belong to the current process epoch. Keep it and make
          // the same-seq disagreement visible instead of duplicating the seq.
          responseBySeq.set(local.seq, local)
          diagnostics.push(`same-seq conflict #${local.seq}: kept post-request live ${local.type}, ignored snapshot ${remote.type}`)
        }
      }
      for (const diagnostic of diagnostics) latest = addTrajectoryDiagnostic(latest, diagnostic)
      const mergedEvents = [...responseBySeq.values()].sort((left, right) => left.seq - right.seq)
      const mergedSnapshot = {
        ...snapshot,
        events: mergedEvents,
        eventCount: Math.max(snapshot.eventCount ?? 0, mergedEvents.length),
        updatedAt: Math.max(snapshot.updatedAt ?? 0, ...mergedEvents.map(event => event.time)),
      }
      this.#trajectory = setTrajectorySnapshot(latest, mergedSnapshot)
      this.#trajectoryAbort = null
      this.#render()
    } catch (error: unknown) {
      if (requestId !== this.#trajectoryRequestId || controller.signal.aborted || this.#trajectory === null) return
      const message = error instanceof Error ? error.message : String(error)
      this.#trajectory = setTrajectoryLoading(this.#trajectory, false, message)
      this.#trajectoryAbort = null
      this.#render()
    }
  }

  #applyTrajectory(event: KeyEvent): void {
    const state = this.#trajectory
    if (state === null) return
    const command = applyTrajectoryEvent(state, event, this.#term.width(), this.#term.height())
    if (command.kind === 'update') {
      this.#trajectory = command.state
      this.#render()
      return
    }
    if (command.kind === 'inspect') {
      this.#trajectory = command.state
      this.#render()
      void this.#refreshTrajectory(false, command.id)
      return
    }
    if (command.kind === 'refresh') {
      this.#trajectory = command.state
      this.#render()
      void this.#refreshTrajectory(true)
      return
    }
    if (command.kind === 'copy') {
      this.#trajectory = command.state
      void this.#copy(command.text).catch((error: unknown) => {
        if (this.#trajectory === null) return
        this.#trajectory = setTrajectoryLoading(
          this.#trajectory,
          false,
          'Copy failed: ' + (error instanceof Error ? error.message : String(error)),
        )
        this.#render()
      })
      return
    }
    if (command.kind === 'close') this.#closeTrajectory()
  }

  #closeTrajectory(render = true): void {
    if (this.#trajectory === null && this.#trajectoryResolve === null && !this.#trajectoryMouseEnabled) return
    this.#setTrajectoryMouse(false)
    this.#trajectoryRequestId += 1
    this.#trajectoryAbort?.abort()
    this.#trajectoryAbort = null
    if (this.#trajectoryPoll !== null) clearInterval(this.#trajectoryPoll)
    this.#trajectoryPoll = null
    this.#trajectory = null
    const resolve = this.#trajectoryResolve
    this.#trajectoryResolve = null
    resolve?.()
    if (render && !this.#disposed) this.#render()
  }

  async #refreshSessionManager(reloadList: boolean, requestedId?: string): Promise<void> {
    const source = this.#sessionManagerSource
    const current = this.#sessionManager
    if (source === null || current === null || this.#disposed) return
    const requestId = ++this.#sessionManagerRequestId
    this.#sessionManagerAbort?.abort()
    const controller = new AbortController()
    this.#sessionManagerAbort = controller
    this.#sessionManager = setSessionManagerLoading(current, true)
    this.#render()
    try {
      let next = this.#sessionManager
      if (next === null) return
      if (reloadList) {
        next = setSessionManagerSessions(next, await source.list(controller.signal))
        if (requestId !== this.#sessionManagerRequestId || controller.signal.aborted || this.#sessionManager === null) return
      }
      const rows = visibleManagerSessions(next)
      if (rows.length === 0) {
        this.#sessionManager = setSessionManagerLoading(next, false)
        this.#sessionManagerAbort = null
        this.#render()
        if (reloadList) void this.#hydrateSessionManager()
        return
      }
      const id = requestedId ?? rows[next.selected]!.id
      const selected = rows.findIndex(session => session.id === id)
      next = { ...next, ...(selected < 0 ? {} : { selected }), loading: true, error: undefined }
      this.#sessionManager = next
      const snapshot = await source.inspect(id, controller.signal)
      if (requestId !== this.#sessionManagerRequestId || controller.signal.aborted || this.#sessionManager === null) return
      this.#sessionManager = setSessionManagerSnapshot(this.#sessionManager, snapshot)
      this.#sessionManagerAbort = null
      this.#render()
      if (reloadList) void this.#hydrateSessionManager()
    } catch (error: unknown) {
      if (requestId !== this.#sessionManagerRequestId || controller.signal.aborted || this.#sessionManager === null) return
      this.#sessionManager = setSessionManagerLoading(
        this.#sessionManager,
        false,
        error instanceof Error ? error.message : String(error),
      )
      this.#sessionManagerAbort = null
      this.#render()
    }
  }

  async #hydrateSessionManager(): Promise<void> {
    const source = this.#sessionManagerSource
    if (source?.hydrate === undefined || this.#sessionManager === null || this.#disposed) return
    this.#sessionManagerHydrateAbort?.abort()
    const controller = new AbortController()
    this.#sessionManagerHydrateAbort = controller
    this.#sessionManager = setSessionManagerHydrating(this.#sessionManager, true)
    this.#render()
    try {
      const rows = await source.hydrate(controller.signal)
      if (controller.signal.aborted || this.#sessionManager === null || source !== this.#sessionManagerSource) return
      this.#sessionManager = setSessionManagerHydrating(
        setSessionManagerSessions(this.#sessionManager, rows),
        false,
      )
      this.#sessionManagerHydrateAbort = null
      this.#render()
    } catch {
      if (!controller.signal.aborted && this.#sessionManager !== null) {
        this.#sessionManager = setSessionManagerHydrating(this.#sessionManager, false)
        this.#sessionManagerHydrateAbort = null
        this.#render()
      }
    }
  }

  #applySessionManager(event: KeyEvent): void {
    const state = this.#sessionManager
    if (state === null) return
    const command = applySessionManagerEvent(state, event, Math.max(1, this.#term.height() - 8))
    if (command.kind === 'update') {
      this.#sessionManager = command.state
      this.#render()
      return
    }
    if (command.kind === 'inspect') {
      this.#sessionManager = command.state
      this.#render()
      void this.#refreshSessionManager(false, command.id)
      return
    }
    if (command.kind === 'refresh') {
      this.#sessionManager = command.state
      this.#render()
      void this.#refreshSessionManager(true)
      return
    }
    if (command.kind === 'copy') {
      this.#sessionManager = command.state
      void this.#copy(command.text).catch((error: unknown) => {
        if (this.#sessionManager === null) return
        this.#sessionManager = setSessionManagerLoading(
          this.#sessionManager,
          false,
          'Copy failed: ' + (error instanceof Error ? error.message : String(error)),
        )
        this.#render()
      })
      return
    }
    if (command.kind === 'resume') {
      this.#closeSessionManager({ kind: 'resume', id: command.id })
      return
    }
    if (command.kind === 'close') this.#closeSessionManager(null)
  }

  #closeSessionManager(result: TuiSessionManagerResult | null, render = true): void {
    if (this.#sessionManager === null && this.#sessionManagerResolve === null) return
    this.#sessionManagerRequestId += 1
    this.#sessionManagerAbort?.abort()
    this.#sessionManagerAbort = null
    this.#sessionManagerHydrateAbort?.abort()
    this.#sessionManagerHydrateAbort = null
    this.#sessionManagerSignalCleanup?.()
    this.#sessionManagerSignalCleanup = null
    this.#sessionManager = null
    this.#sessionManagerSource = null
    const resolve = this.#sessionManagerResolve
    this.#sessionManagerResolve = null
    resolve?.(result)
    if (render && !this.#disposed) this.#render()
  }

  #currentSubmission(): TuiSubmission {
    return {
      text: this.#editor.text,
      images: this.#images.map(image => ({ ...image })),
    }
  }

  #replaceInput(submission: TuiSubmission): void {
    this.#images = submission.images.map(image => ({ ...image }))
    this.#editor.setText(submission.text)
    this.#historyIndex = 0
    this.#refreshAutocomplete()
    if (this.#tty) this.#render()
  }

  onInterrupt(listener: () => void): () => void {
    this.#interrupts.add(listener)
    return () => { this.#interrupts.delete(listener) }
  }

  onQueueEdit(listener: () => void): () => void {
    this.#queueEdits.add(listener)
    return () => { this.#queueEdits.delete(listener) }
  }

  onRewind(listener: () => void): () => void {
    this.#rewinds.add(listener)
    return () => { this.#rewinds.delete(listener) }
  }

  onInspectSubagent(listener: (id: string) => void): () => void {
    this.#inspects.add(listener)
    return () => { this.#inspects.delete(listener) }
  }

  onInspectClose(listener: () => void): () => void {
    this.#inspectCloses.add(listener)
    return () => { this.#inspectCloses.delete(listener) }
  }

  onInspectSubmit(listener: (submission: TuiSubmission) => void): () => void {
    this.#inspectSubmits.add(listener)
    return () => { this.#inspectSubmits.delete(listener) }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    if (this.#resumeAfterSuspend !== null) {
      process.off('SIGCONT', this.#resumeAfterSuspend)
      this.#resumeAfterSuspend = null
    }
    if (this.#resizeTimer !== null) {
      clearTimeout(this.#resizeTimer)
      this.#resizeTimer = null
    }
    if (this.#streamRenderTimer !== null) {
      clearTimeout(this.#streamRenderTimer)
      this.#streamRenderTimer = null
    }
    if (this.#hostTelemetryHeartbeat !== null) {
      clearInterval(this.#hostTelemetryHeartbeat)
      this.#hostTelemetryHeartbeat = null
    }
    this.#closeSessionManager(null, false)
    this.#closeTrajectory(false)
    this.#trajectorySource = null
    if (this.#activeTranscriptSource !== null) {
      this.#activeTranscriptSource = null
      this.#term.bindActiveTranscriptSource?.()
    }
    if (this.#tty) {
      this.#offData?.()
      this.#offResize?.()
      if (this.#inputActivated) this.#term.input.setRawMode?.(false)
      if (this.#hostTelemetrySignature !== undefined) {
        this.#term.output.write(encodeHostTelemetryOsc())
        this.#hostTelemetrySignature = undefined
      }
      // Leave the cursor on a fresh line below the last frame so the shell
      // prompt does not overwrite the transcript. Restore terminal input modes
      // before the next shell owns the tty.
      this.#renderer.finish()
      this.#term.output.write((this.#inputActivated ? '\x1b[>4m\x1b[?2004l' : '') + '\x1b[?25h\r\n')
      if (this.#resumeHintRequested && this.#sessionId !== undefined) {
        this.#term.output.write(`\r\nResume this session with ${APP_NAME} --resume ${this.#sessionId}\r\n`)
      }
      // A tty stdin keeps the event loop alive after the tree disposes;
      // release the descriptor so natural completion can exit the process.
      this.#term.input.destroy?.()
    }
    if (this.#escapeTimer !== null) clearTimeout(this.#escapeTimer)
    if (this.#autocompleteTimer !== null) clearTimeout(this.#autocompleteTimer)
    this.#autocompleteAbort?.abort()
    this.#autocompleteTimer = null
    this.#autocompleteAbort = null
    this.#lineReader?.close()
    this.#pending?.resolve(null)
    this.#pending = null
    this.#finishPrompt(null)
  }

  /** Re-render the current frame (resize reflow). */
  refresh(): void {
    this.#render()
  }

  #readlinePlain(): Promise<TuiSubmission | null> {
    return new Promise((resolve) => {
      if (this.#lineReader === null) {
        this.#lineReader = createInterface({ input: this.#term.input })
        // Permanent listeners: once() handlers would auto-pause the input
        // stream after one line and miss the EOF close.
        this.#lineReader.on('line', (line: string) => { this.#plainResolve(line) })
        this.#lineReader.on('close', () => {
          this.#plainClosed = true
          this.#plainResolve(null)
        })
      }
      if (this.#plainClosed) {
        resolve(null)
        return
      }
      this.#plainPending = { resolve }
    })
  }

  #plainResolve(line: string | null): void {
    if (this.#prompt !== null && line !== null) {
      const value = line.trim()
      if (value === '') {
        this.#finishPrompt(null)
      } else if (this.#prompt.request.allowCustom === false) {
        const options = this.#prompt.request.options ?? []
        const numeric = /^\d+$/u.test(value) ? Number(value) - 1 : -1
        const option = numeric >= 0
          ? options[numeric]
          : options.find(item => item.label.toLowerCase() === value.toLowerCase())
        this.#finishPrompt(option?.value ?? option?.label ?? null)
      } else {
        this.#finishPrompt(value)
      }
      return
    }
    if (this.#prompt !== null) this.#finishPrompt(null)
    const pending = this.#plainPending
    this.#plainPending = null
    pending?.resolve(line === null ? null : { text: line, images: [] })
  }

  /** Print plain-mode blocks that settled since the last flush. */
  #printPlain(): void {
    const theme = createTheme(false, false)
    const width = this.#term.width()
    const fresh = this.#state.blocks.slice(this.#plainPrinted)
    let out = ''
    for (const block of fresh) {
      // Pipe / CI output is not a viewport: print the full tool body.
      for (const line of blockLines(block, theme, width, 0, true)) out += line + '\n'
    }
    this.#plainPrinted = this.#state.blocks.length
    if (out !== '') this.#term.output.write(out)
  }

  #publishHostTelemetry(force = false): void {
    if (!this.#tty || !this.#hostTelemetry) return
    const groups = this.#sessionStats === undefined || !this.#statusBar.enabled
      ? []
      : sessionStatusGroups(this.#sessionStats)
    const payload = groups.length === 0 ? undefined : hostTelemetryPayload(groups)
    const signature = payload === undefined ? '' : JSON.stringify(payload)
    if (signature === this.#hostTelemetrySignature && (!force || payload === undefined)) return
    this.#hostTelemetrySignature = signature
    this.#term.output.write(encodeHostTelemetryOsc(payload))
  }

  #render(): void {
    const deferStreamBlocks = this.#handlingInput && this.#streamRenderTimer !== null
    if (this.#streamRenderTimer !== null && !deferStreamBlocks) {
      clearTimeout(this.#streamRenderTimer)
      this.#streamRenderTimer = null
    }
    if (this.#deferInitialRender) return
    if (this.#reconcileGeometry(this.#resizeWidthChanged) && this.#resizeTimer !== null) {
      clearTimeout(this.#resizeTimer)
      this.#resizeTimer = null
      this.#resizeWidthChanged = false
    }
    const width = this.#term.width()
    const renderState = deferStreamBlocks
      ? { ...this.#state, blocks: this.#renderedBlocks }
      : this.#state
    const theme = createTheme(this.#colors, this.#trueColor, this.#themeName)
    const frame = this.#tty
      ? this.#sessionManager !== null
        ? renderSessionManager(
          this.#sessionManager,
          theme,
          width,
          this.#term.height(),
          APP_NAME,
          this.#spinner,
        )
        : this.#trajectory !== null
          ? renderTrajectory(
            this.#trajectory,
            theme,
            width,
            this.#term.height(),
            APP_NAME,
            this.#spinner,
          )
          : renderView(renderState, {
        width,
        height: this.#term.height(),
        model: this.#model,
        ...(this.#reasoningEffort === undefined ? {} : { reasoningEffort: this.#reasoningEffort }),
        input: this.#editor.text,
        inputCursor: this.#editor.cursor,
        composerStart: this.#composerStart,
        ...(this.#editor.selection === null ? {} : { inputSelection: this.#editor.selection }),
        inputImages: this.#images.length,
        queuedSubmissions: this.#queueEditNewer === null
          ? this.#queuedSubmissions
          : [...this.#queuedSubmissions, ...this.#queueEditNewer],
        colors: this.#colors,
        pwd: this.#pwd,
        ...(this.#branch !== undefined ? { branch: this.#branch } : {}),
        version: APP_VERSION,
        appName: APP_NAME,
        spinnerFrame: this.#spinner,
        trueColor: this.#trueColor,
        themeName: this.#themeName,
        scrollStart: this.#follow ? Number.POSITIVE_INFINITY : this.#scrollStart,
        ...(this.#focusBlock === undefined ? {} : { focusBlock: this.#focusBlock }),
        activityDetail: this.#activityDetail,
        toolsExpanded: this.#toolsExpanded,
        expandedTools: this.#expandedToolCalls,
        commands: this.#commands(),
        recentSessions: this.#recentSessions,
        welcomeTips: this.#welcomeTips,
        ...(this.#sessionStats === undefined ? {} : { sessionStats: this.#sessionStats }),
        ...(this.#sessionControls === undefined ? {} : { sessionControls: this.#sessionControls }),
        ...(this.#loopStatus === undefined ? {} : { loopStatus: this.#loopStatus }),
        ...(this.#subagents === undefined ? {} : { subagents: this.#subagents }),
        subagentLauncherFocused: this.#subagentLauncherFocused,
        ...(this.#inspected === undefined ? {} : { inspected: this.#inspected }),
        statusBar: this.#statusBar,
        ...(this.#prompt === null ? {} : { promptSelector: this.#prompt }),
        ...(this.#settings !== null
          ? { settings: this.#settings }
          : this.#copySelector !== null
            ? { copySelector: this.#copySelector }
            : this.#search !== null
              ? { historySearch: this.#search }
              : this.#ac !== null ? { autocomplete: this.#ac } : {}),
      })
      : { lines: [] }
    this.#focusBlock = undefined
    this.#promptDocument = frame.promptDocument
    if (frame.composer !== undefined) this.#composerStart = frame.composer.start
    this.#syncScroll(frame.transcript)
    if (this.#trajectory === null && this.#sessionManager === null) {
      const assistantStreaming = this.#state.blocks.some(block => block.kind === 'assistant' && block.streaming)
      const pendingSpan = frame.livePinned === true
        ? frame.lines.length - (frame.liveStart ?? frame.lines.length)
        : 0
      if (this.#pinnedOverflow && frame.livePinned !== true && this.#terminalProfile === 'direct') {
        // A long mutable suffix lived only on the physical screen while it streamed.
        // Rebuild once at settlement so terminal hosts cannot retain only its tail.
        this.#renderer.startEpoch({ replay: 'full' })
      }
      this.#pinnedOverflow = assistantStreaming && frame.livePinned === true && pendingSpan > this.#term.height()
    }
    this.#renderer.render(frame)
    this.#publishHostTelemetry()
    if (!deferStreamBlocks && this.#trajectory === null && this.#sessionManager === null) {
      this.#renderedBlocks = this.#state.blocks
    }
  }

  #scheduleStreamRender(): void {
    if (this.#streamRenderTimer !== null) return
    this.#streamRenderTimer = setTimeout(() => {
      this.#streamRenderTimer = null
      if (!this.#disposed) this.#render()
    }, this.#streamRenderMs)
  }

  #syncScroll(scroll: { start: number; maxStart: number; budget: number } | undefined): void {
    if (scroll === undefined) {
      this.#scrollStart = 0
      this.#maxStart = 0
      this.#scrollBudget = 0
      this.#follow = true
      return
    }
    this.#scrollStart = scroll.start
    this.#maxStart = scroll.maxStart
    this.#scrollBudget = scroll.budget
    if (this.#follow || this.#scrollStart >= this.#maxStart) {
      this.#follow = true
      this.#scrollStart = this.#maxStart
    }
  }

  #pageSize(): number {
    return Math.max(1, this.#scrollBudget > 2 ? this.#scrollBudget - 2 : 1)
  }

  #scrollBy(delta: number): void {
    if (delta === 0 && this.#maxStart === 0) return
    this.#follow = false
    this.#scrollStart += delta
    if (this.#scrollStart <= 0) this.#scrollStart = 0
    this.#render()
  }

  #followTail(): void {
    this.#follow = true
    this.#scrollStart = this.#maxStart
  }

  #onData(chunk: Buffer): void {
    const input = this.#pendingKeys + chunk.toString('utf8')
    const recoveredPaste = this.#pendingKeys === '' && !this.#paste
      ? unbracketedMultilinePaste(input)
      : undefined
    if (this.#escapeTimer !== null) {
      clearTimeout(this.#escapeTimer)
      this.#escapeTimer = null
    }
    if (recoveredPaste !== undefined) {
      this.#startAsyncPaste(this.#acceptPastedText(recoveredPaste))
      return
    }
    const { events, rest } = parseKeys(input)
    this.#pendingKeys = rest
    this.#dispatchInputEvents(events)
    if (rest.startsWith('\x1b') && rest.length <= MAX_PENDING_ESCAPE_BYTES) {
      this.#escapeTimer = setTimeout(() => {
        this.#pendingKeys = ''
        this.#escapeTimer = null
        this.#dispatchInputEvents(flushPending(rest))
      }, 80)
    } else if (rest.length > 0) {
      this.#pendingKeys = ''
    }
  }

  #dispatchInputEvents(events: readonly KeyEvent[]): void {
    const wasHandlingInput = this.#handlingInput
    this.#handlingInput = true
    try {
      for (const event of events) this.#dispatch(event)
    } finally {
      this.#handlingInput = wasHandlingInput
    }
  }

  #startAsyncPaste(operation: Promise<void>): void {
    this.#pasteInFlight += 1
    void operation.catch((error: unknown) => {
      this.notice('Paste failed: ' + (error instanceof Error ? error.message : String(error)), { level: 'error' })
    }).finally(() => {
      this.#pasteInFlight = Math.max(0, this.#pasteInFlight - 1)
      if (this.#pasteInFlight !== 0 || this.#deferredPasteEvents.length === 0) return
      const deferred = this.#deferredPasteEvents.splice(0)
      for (let index = 0; index < deferred.length; index += 1) {
        this.#dispatch(deferred[index] as KeyEvent)
        if (this.#pasteInFlight === 0) continue
        this.#deferredPasteEvents.unshift(...deferred.slice(index + 1))
        break
      }
    })
  }

  async #acceptPastedText(text: string): Promise<void> {
    if (this.#prompt !== null) {
      this.#editor.handle({ type: 'text', value: text })
      this.#render()
      return
    }
    if (this.#settings !== null || this.#copySelector !== null) return
    if (this.#search !== null) {
      this.#applySearch({ type: 'text', value: text })
      return
    }
    const paths = imagePathCandidates(text)
    if (paths.length > 0) {
      const images = await Promise.all(paths.map(path => this.#readImagePath(path)))
      if (images.every((image): image is TuiInputImage => image !== null)) {
        let inserted = false
        for (const image of images) {
          if (await this.#admitImage(image)) {
            this.#insertImageDraft(image)
            inserted = true
          }
        }
        if (inserted) {
          this.#refreshAutocomplete()
          this.#render()
        }
        return
      }
      // Screenshot tools sometimes paste a transient cache path and remove
      // it before Node reads it. OMP falls back to the still-live clipboard
      // image instead of leaking that stale path into the prompt.
      const clipboardImage = await this.#readClipboardImage()
      if (clipboardImage !== null) {
        this.#insertImageDraft(clipboardImage)
        this.#refreshAutocomplete()
        this.#render()
        return
      }
    }
    this.#editor.handle({ type: 'text', value: text })
    this.#refreshAutocomplete()
    this.#render()
  }

  async #pasteClipboard(): Promise<void> {
    if (this.#search === null && this.#settings === null && this.#copySelector === null) {
      const image = await this.#readClipboardImage()
      if (image !== null) {
        if (await this.#admitImage(image)) {
          this.#insertImageDraft(image)
          this.#refreshAutocomplete()
          this.#render()
        }
        return
      }
      const files = await this.#readClipboardFiles()
      const imagePaths = files.filter(path => imagePathCandidates(path).length === 1)
      if (imagePaths.length > 0) {
        const images = (await Promise.all(imagePaths.map(path => this.#readImagePath(path))))
          .filter((candidate): candidate is TuiInputImage => candidate !== null)
        if (images.length > 0) {
          let inserted = false
          for (const candidate of images) {
            if (await this.#admitImage(candidate)) {
              this.#insertImageDraft(candidate)
              inserted = true
            }
          }
          if (inserted) {
            this.#refreshAutocomplete()
            this.#render()
          }
          return
        }
      }
    }
    const text = await this.#readClipboard()
    if (text !== '') await this.#acceptPastedText(text)
  }

  /**
   * Run the Harness image-admission check for one paste candidate. A refusal
   * becomes an error notice and skips the draft, instead of failing the whole
   * submission after the user has typed a prompt around it.
   */
  async #admitImage(image: TuiInputImage): Promise<boolean> {
    if (this.#validateImageDraft === undefined) return true
    try {
      await this.#validateImageDraft(image)
      return true
    } catch (error: unknown) {
      this.notice(error instanceof Error ? error.message : String(error), { level: 'error' })
      return false
    }
  }

  #insertImageDraft(input: TuiInputImage): void {
    const size = input.width === undefined || input.height === undefined
      ? probeImageDimensions(input.data, input.mediaType)
      : undefined
    const image: TuiInputImage = {
      ...input,
      ...(input.width === undefined && size !== undefined ? { width: size.width } : {}),
      ...(input.height === undefined && size !== undefined ? { height: size.height } : {}),
    }
    const marker = imageMarker(this.#images.length, image)
    const before = this.#editor.cursor > 0 && !/\s/u.test(this.#editor.text[this.#editor.cursor - 1] ?? '') ? ' ' : ''
    const after = this.#editor.cursor >= this.#editor.text.length || !/\s/u.test(this.#editor.text[this.#editor.cursor] ?? '')
      ? ' '
      : ''
    this.#images.push(image)
    this.#editor.handle({ type: 'text', value: before + marker + after })
  }

  #removeImageAtCursor(key: 'backspace' | 'delete'): boolean {
    const cursor = this.#editor.cursor
    for (let index = 0; index < this.#images.length; index += 1) {
      const image = this.#images[index] as TuiInputImage
      const marker = imageMarker(index, image)
      const start = this.#editor.text.indexOf(marker)
      if (start < 0) continue
      let from = start
      let to = start + marker.length
      const touches = key === 'backspace'
        ? cursor > start && cursor <= to
        : cursor >= start && cursor < to
      if (!touches) continue
      if (this.#editor.text[to] === ' ') to += 1
      else if (from > 0 && this.#editor.text[from - 1] === ' ') from -= 1
      const oldImages = this.#images
      let text = this.#editor.text.slice(0, from) + this.#editor.text.slice(to)
      const nextImages = oldImages.filter((_, oldIndex) => oldIndex !== index)
      let nextIndex = 0
      for (let oldIndex = 0; oldIndex < oldImages.length; oldIndex += 1) {
        if (oldIndex === index) continue
        const remaining = oldImages[oldIndex] as TuiInputImage
        text = text.replaceAll(imageMarker(oldIndex, remaining), imageMarker(nextIndex, remaining))
        nextIndex += 1
      }
      this.#images = nextImages
      this.#editor.setText(text, Math.min(from, text.length))
      this.#refreshAutocomplete()
      this.#render()
      return true
    }
    return false
  }

  #reconcileImageDrafts(): void {
    if (this.#images.length === 0) return
    const oldImages = this.#images
    const retained = oldImages.filter((image, index) => this.#editor.text.includes(imageMarker(index, image)))
    if (retained.length === oldImages.length) return
    let text = this.#editor.text
    let nextIndex = 0
    for (let oldIndex = 0; oldIndex < oldImages.length; oldIndex += 1) {
      const image = oldImages[oldIndex] as TuiInputImage
      const oldMarker = imageMarker(oldIndex, image)
      if (!text.includes(oldMarker)) continue
      text = text.replaceAll(oldMarker, imageMarker(nextIndex, image))
      nextIndex += 1
    }
    this.#images = retained
    this.#editor.setText(text, Math.min(this.#editor.cursor, text.length))
  }

  #dispatch(event: KeyEvent): void {
    if (this.#state.status === 'compacting') {
      if (event.type === 'key' && event.id === 'pageUp') {
        this.#scrollBy(-this.#pageSize())
        return
      }
      if (event.type === 'key' && event.id === 'pageDown') {
        this.#scrollBy(this.#pageSize())
        return
      }
      if (event.type !== 'key' || event.id !== 'ctrl+c') return
    }
    if (this.#sessionManager !== null) {
      this.#applySessionManager(event)
      return
    }
    if (this.#trajectory !== null) {
      this.#applyTrajectory(event)
      return
    }
    // Clipboard image inspection is asynchronous. Preserve the exact key
    // order so a fast Ctrl+V, Enter submits the finished image draft rather
    // than an empty prompt.
    if (this.#pasteInFlight > 0) {
      this.#deferredPasteEvents.push(event)
      return
    }
    if (this.#paste) {
      if (event.type === 'paste-end') {
        this.#paste = false
        const text = this.#pasteBuf.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
        this.#pasteBuf = ''
        if (text !== '') this.#startAsyncPaste(this.#acceptPastedText(text))
        return
      }
      if (event.type === 'text') this.#pasteBuf += event.value
      else if (event.type === 'key' && (event.id === 'enter' || event.id === 'ctrl+j')) this.#pasteBuf += '\n'
      return
    }
    if (event.type === 'paste-start') {
      this.#paste = true
      this.#pasteBuf = ''
      return
    }
    if (event.type !== 'key' || event.id !== 'escape') this.#lastEscapeTime = 0
    if (this.#handlePrompt(event)) return
    if (event.type === 'key') {
      const action = this.#keybindings[event.id]
      if (action !== undefined) {
        this.#runAction(action)
        return
      }
    }
    if (this.#inspected !== undefined && this.#inspected.writable !== true && event.type === 'text'
      && this.#prompt === null && this.#settings === null && this.#copySelector === null && this.#search === null) {
      return
    }
    if (event.type === 'key' && event.id === 'ctrl+c') {
      if (this.#prompt !== null) {
        this.#finishPrompt(null)
        this.#editor.setText('')
        this.#render()
        return
      }
      if (this.#settings !== null) {
        this.#settings = null
        this.#render()
        return
      }
      if (this.#copySelector !== null) {
        this.#copySelector = null
        this.#render()
        return
      }
      if (this.#search !== null) {
        this.#search = null
        this.#render()
        return
      }
      const now = Date.now()
      if (now - this.#lastSigintTime < DOUBLE_CTRL_C_MS) {
        this.#lastSigintTime = 0
        this.#quit()
        return
      }
      this.#lastSigintTime = now
      if (this.#state.status !== 'idle') {
        for (const listener of this.#interrupts) listener()
      } else {
        this.#editor.clear()
        this.#images = []
        this.#historyIndex = 0
        this.#ac = null
        this.#render()
      }
      return
    }
    if (this.#settings !== null) {
      this.#applySettings(event)
      return
    }
    if (this.#copySelector !== null) {
      this.#applyCopySelector(event)
      return
    }
    if (event.type === 'key' && event.id === 'ctrl+r') {
      if (this.#images.length > 0) return
      this.#search = createHistorySearch(this.#history)
      this.#ac = null
      this.#render()
      return
    }
    if (this.#search !== null) {
      this.#applySearch(event)
      return
    }
    if (this.#handleAutocomplete(event)) {
      if (event.type === 'key' && event.id === 'escape') this.#lastEscapeTime = 0
      return
    }
    if (this.#handleSubagentLauncher(event)) return
    if (event.type === 'key' && (event.id === 'up' || event.id === 'down')) {
      if (this.#moveEditorVisual(event.id === 'up' ? -1 : 1)) return
    } else {
      this.#verticalColumn = undefined
    }
    if (event.type === 'key' && event.id === 'escape') {
      if (this.#inspected !== undefined) {
        if (this.#inspected.writable === true && (this.#editor.text !== '' || this.#images.length > 0)) {
          this.#editor.clear()
          this.#images = []
          this.#ac = null
          this.#render()
          return
        }
        this.#closeInspect()
        return
      }
      if (this.#state.status !== 'idle' || this.#pending === null
        || this.#editor.text !== '' || this.#images.length > 0) {
        this.#lastEscapeTime = 0
      } else {
        const now = Date.now()
        if (now - this.#lastEscapeTime < DOUBLE_ESCAPE_MS) {
          this.#lastEscapeTime = 0
          for (const listener of this.#rewinds) listener()
        } else {
          this.#lastEscapeTime = now
        }
        return
      }
    }
    if (event.type === 'key' && (event.id === 'backspace' || event.id === 'delete')
      && this.#editor.selection === null && this.#removeImageAtCursor(event.id)) return
    if (event.type === 'key') {
      if (event.id === 'pageUp') {
        this.#scrollBy(-this.#pageSize())
        return
      }
      if (event.id === 'pageDown') {
        this.#scrollBy(this.#pageSize())
        return
      }
      if (event.id === 'ctrl+t') {
        this.#follow = true
        this.#scrollStart = this.#maxStart
        this.#renderer.startEpoch({ replay: 'full' })
        this.#render()
        return
      }
      if (event.id === 'ctrl+o') {
        const last = this.#state.blocks.at(-1)
        const tool = last?.kind === 'toolCatalog'
          ? undefined
          : this.#state.blocks.findLast(block => block.kind === 'tool')
        if (last?.kind === 'toolCatalog') {
          this.#toolsExpanded = !this.#toolsExpanded
        } else if (tool?.kind === 'tool') {
          if (this.#expandedToolCalls.has(tool.callId)) this.#expandedToolCalls.delete(tool.callId)
          else this.#expandedToolCalls.add(tool.callId)
        } else {
          this.#toolsExpanded = !this.#toolsExpanded
        }
        if (this.#activityDetail !== 'standard') this.#restartPresentationEpoch()
        this.#render()
        return
      }
    }
    this.#applyCommand(this.#editor.handle(event))
  }

  #handlePrompt(event: KeyEvent): boolean {
    const prompt = this.#prompt
    if (prompt === null) return false
    if (prompt.request.presentation === 'plan-review') return this.#handlePlanReview(event, prompt)
    if (event.type === 'text' && event.value === ' ' && prompt.request.multiSelect === true && this.#editor.text === '') {
      this.#prompt = togglePromptSelection(prompt) as PendingPrompt
      this.#render()
      return true
    }
    if (event.type === 'text' && prompt.request.filterable === true) {
      const command = this.#editor.handle(event)
      if (command.kind === 'changed') {
        this.#prompt = { ...prompt, selected: 0 }
        this.#render()
      }
      return true
    }
    if (event.type === 'text' && prompt.request.allowCustom === false) return true
    if (event.type !== 'key') return false
    const submit = event.id === 'enter' || event.id === 'ctrl+j'
    const filtered = filteredPromptOptions(prompt.request, this.#editor.text)
    const count = filtered.length
    if (event.id === 'escape' || event.id === 'ctrl+c') {
      this.#editor.setText('')
      this.#finishPrompt(null)
      this.#render()
      return true
    }
    if (count === 0) {
      if (prompt.request.filterable !== true) {
        if (submit) {
          this.#submit(this.#editor.text)
          return true
        }
        return false
      }
      if (submit) return true
      const command = this.#editor.handle(event)
      if (command.kind === 'changed') {
        this.#prompt = { ...prompt, selected: 0 }
        this.#render()
      }
      return true
    }
    let next: number | undefined
    if (event.id === 'up' || event.id === 'shift+tab') next = prompt.selected - 1
    else if (event.id === 'down' || event.id === 'tab') next = prompt.selected + 1
    else if (event.id === 'pageUp') next = prompt.selected - 10
    else if (event.id === 'pageDown') next = prompt.selected + 10
    else if (event.id === 'home') next = 0
    else if (event.id === 'end') next = count - 1
    if (next !== undefined) {
      this.#prompt = movePromptSelection(prompt, next, count) as PendingPrompt
      this.#render()
      return true
    }
    if (submit && this.#editor.text === '') {
      let answer = selectedPromptAnswer(prompt)
      if (prompt.request.multiSelect === true && answer === null) {
        const current = prompt.request.options?.[prompt.selected]
        answer = current?.value ?? current?.label ?? null
      }
      this.#finishPrompt(answer)
      this.#render()
      return true
    }
    if (submit && prompt.request.filterable === true) {
      this.#finishPrompt(selectedFilteredPromptAnswer(prompt, this.#editor.text))
      this.#editor.setText('')
      this.#render()
      return true
    }
    if (prompt.request.filterable === true) {
      const command = this.#editor.handle(event)
      if (command.kind === 'changed') {
        this.#prompt = { ...prompt, selected: 0 }
        this.#render()
      }
      return true
    }
    if (submit) {
      this.#submit(this.#editor.text)
      return true
    }
    return false
  }

  #handlePlanReview(event: KeyEvent, prompt: PendingPrompt): boolean {
    if (prompt.feedback === true) {
      if (event.type === 'key' && event.id === 'ctrl+c') {
        this.#editor.setText('')
        this.#finishPrompt(null)
        this.#render()
        return true
      }
      if (event.type === 'key' && event.id === 'escape') {
        this.#editor.setText('')
        this.#prompt = { ...prompt, feedback: false }
        this.#render()
        return true
      }
      if (event.type === 'key' && (event.id === 'enter' || event.id === 'ctrl+j')) {
        const feedback = this.#editor.text.trim()
        this.#editor.setText('')
        this.#finishPrompt(feedback === '' ? selectedPromptAnswer(prompt) : feedback)
        this.#render()
        return true
      }
      const command = this.#editor.handle(event)
      if (command.kind === 'changed') this.#render()
      return true
    }

    if (event.type === 'text') return true
    if (event.type !== 'key') return false
    if (event.id === 'escape' || event.id === 'ctrl+c') {
      this.#editor.setText('')
      this.#finishPrompt(null)
      this.#render()
      return true
    }
    const scroll = this.#promptDocument
    let documentScroll: number | undefined
    if (event.id === 'up') documentScroll = (scroll?.start ?? prompt.documentScroll ?? 0) - 1
    else if (event.id === 'down') documentScroll = (scroll?.start ?? prompt.documentScroll ?? 0) + 1
    else if (event.id === 'pageUp') documentScroll = (scroll?.start ?? 0) - (scroll?.pageSize ?? 8)
    else if (event.id === 'pageDown') documentScroll = (scroll?.start ?? 0) + (scroll?.pageSize ?? 8)
    else if (event.id === 'home') documentScroll = 0
    else if (event.id === 'end') documentScroll = scroll?.maxStart ?? prompt.documentScroll ?? 0
    if (documentScroll !== undefined) {
      this.#prompt = {
        ...prompt,
        documentScroll: Math.max(0, Math.min(documentScroll, scroll?.maxStart ?? Number.POSITIVE_INFINITY)),
      }
      this.#render()
      return true
    }
    if (event.id === 'tab' || event.id === 'right') {
      this.#prompt = movePromptSelection(prompt, prompt.selected + 1) as PendingPrompt
      this.#render()
      return true
    }
    if (event.id === 'shift+tab' || event.id === 'left') {
      this.#prompt = movePromptSelection(prompt, prompt.selected - 1) as PendingPrompt
      this.#render()
      return true
    }
    if (event.id === 'enter' || event.id === 'ctrl+j') {
      const answer = selectedPromptAnswer(prompt)
      if (answer === null) return true
      const approve = prompt.request.approveValue ?? prompt.request.options?.[0]?.value
        ?? prompt.request.options?.[0]?.label
      if (answer === approve) {
        this.#finishPrompt(answer)
      } else {
        this.#editor.setText('')
        this.#prompt = { ...prompt, feedback: true }
      }
      this.#render()
      return true
    }
    return true
  }

  #openInspect(id: string): void {
    for (const listener of this.#inspects) listener(id)
  }

  #handleSubagentLauncher(event: KeyEvent): boolean {
    const hasAgents = (this.#subagents?.agents.length ?? 0) > 0
    if (this.#subagentLauncherFocused) {
      if (!hasAgents) {
        this.#subagentLauncherFocused = false
        return false
      }
      if (event.type === 'key' && event.id === 'enter') {
        this.#subagentLauncherFocused = false
        void this.#pickSubagent()
        return true
      }
      if (event.type === 'key' && (event.id === 'escape' || event.id === 'up')) {
        this.#subagentLauncherFocused = false
        this.#render()
        return true
      }
      if (event.type === 'key' && event.id === 'down') return true
      this.#subagentLauncherFocused = false
      return false
    }
    if (!hasAgents || event.type !== 'key' || event.id !== 'down') return false
    if (this.#editor.text !== '' || this.#images.length > 0 || this.#historyIndex !== 0 || this.#ac !== null) return false
    if (this.#queuedSubmissions.length > 0 || this.#queueEditNewer !== null || this.#queueEditPending) return false
    this.#subagentLauncherFocused = true
    this.#render()
    return true
  }

  #closeInspect(): void {
    if (this.#inspected === undefined) return
    for (const listener of this.#inspectCloses) listener()
  }

  async #pickSubagent(): Promise<void> {
    this.#subagentLauncherFocused = false
    const agents = this.#subagents?.agents ?? []
    if (agents.length === 0) {
      this.notice('No subagents are available in this session.')
      return
    }
    const initialValue = this.#inspected?.id ?? agents[0]?.id
    const answer = await this.prompt({
      title: 'Agent Hub',
      question: 'Open a subagent transcript',
      options: agents.map(agent => ({
        label: agent.label,
        value: agent.id,
        description: agent.activity.at(-1)?.text ?? agent.phase,
      })),
      ...(initialValue === undefined ? {} : { initialValue }),
      allowCustom: false,
      presentation: 'fullscreen-list',
      filterable: true,
      submitLabel: 'open',
    })
    if (answer === null || answer === '') return
    this.#openInspect(answer)
  }

  #restartPresentationEpoch(): void {
    this.#renderer.startEpoch({ replay: this.#terminalProfile === 'direct' ? 'pinned' : 'tail' })
  }

  #prefs(): TuiPrefs {
    return {
      theme: this.#themeName,
      colors: this.#colors,
      expandTools: this.#expandTools,
      activityDetail: this.#activityDetail,
      checkUpdates: this.#checkUpdates,
      startupChangelog: this.#startupChangelog,
      statusBar: {
        ...this.#statusBar,
        groups: [...this.#statusBar.groups],
        ...(this.#statusBar.order === undefined ? {} : { order: [...this.#statusBar.order] }),
        ...(this.#statusBar.meta === undefined ? {} : { meta: [...this.#statusBar.meta] }),
        ...(this.#statusBar.metaOrder === undefined ? {} : { metaOrder: [...this.#statusBar.metaOrder] }),
        ...(this.#statusBar.colors === undefined ? {} : { colors: { ...this.#statusBar.colors } }),
        ...(this.#statusBar.sides === undefined ? {} : { sides: { ...this.#statusBar.sides } }),
      },
    }
  }

  #applyPrefs(prefs: TuiPrefs): void {
    const expandChanged = prefs.expandTools !== this.#expandTools
    const activityDetail = prefs.activityDetail ?? 'standard'
    const activityChanged = activityDetail !== this.#activityDetail
    this.#themeName = prefs.theme
    this.#colors = prefs.colors
    this.#expandTools = prefs.expandTools
    this.#activityDetail = activityDetail
    this.#checkUpdates = prefs.checkUpdates ?? true
    this.#startupChangelog = prefs.startupChangelog ?? 'summary'
    this.#statusBar = resolveStatusBarConfig(prefs.statusBar, prefs.statusPreset)
    if (expandChanged) this.#toolsExpanded = prefs.expandTools
    if (this.#tty && (activityChanged || expandChanged)) this.#restartPresentationEpoch()
    this.#persistPrefs?.(prefs)
  }

  #applySettings(event: KeyEvent): void {
    if (this.#settings === null) return
    const command = applySettingsEvent(this.#settings, event)
    if (command.kind === 'update') {
      this.#settings = command.state
      this.#render()
      return
    }
    if (command.kind === 'apply') {
      this.#settings = command.state
      this.#applyPrefs(command.state.prefs)
      this.#render()
      return
    }
    if (command.kind === 'close') {
      this.#settings = null
      this.#render()
    }
  }

  #applyCopySelector(event: KeyEvent): void {
    if (this.#copySelector === null) return
    const command = applyCopySelectorEvent(this.#copySelector, event)
    if (command.kind === 'update') {
      this.#copySelector = command.state
      this.#render()
      return
    }
    if (command.kind === 'pick') {
      this.#copySelector = null
      void this.#copyPicked(command.item.text, command.item.copyMessage)
      return
    }
    if (command.kind === 'close') {
      this.#copySelector = null
      this.#render()
    }
  }

  async #copyPicked(text: string, label: string): Promise<void> {
    try {
      await this.#copy(text)
      this.#notice('Copied ' + label)
    } catch {
      this.#notice('Copy failed')
    }
    this.#render()
  }

  #applySearch(event: KeyEvent): void {
    if (this.#search === null) return
    const command = applyHistorySearchEvent(this.#search, event, this.#history)
    if (command.kind === 'update') {
      this.#search = command.state
      this.#render()
      return
    }
    if (command.kind === 'select') {
      this.#search = null
      this.#editor.setText(command.text)
      this.#historyIndex = 0
      this.#refreshAutocomplete()
      this.#render()
      return
    }
    if (command.kind === 'cancel') {
      this.#search = null
      this.#render()
    }
  }

  #handleAutocomplete(event: KeyEvent): boolean {
    if (event.type !== 'key') return false
    if (event.id === 'tab') {
      if (this.#ac !== null) {
        this.#applySelectedCompletion()
      } else {
        this.#refreshAutocomplete(true)
      }
      this.#render()
      return true
    }
    if (this.#ac === null) return false
    if (event.id === 'shift+tab' || event.id === 'up') {
      this.#moveAutocomplete(-1)
      this.#render()
      return true
    }
    if (event.id === 'down') {
      this.#moveAutocomplete(1)
      this.#render()
      return true
    }
    if (event.id === 'escape') {
      this.#ac = null
      this.#render()
      return true
    }
    if (event.id === 'enter') {
      this.#applySelectedCompletion()
      this.#submit(this.#editor.text)
      return true
    }
    return false
  }

  #refreshAutocomplete(forcePath = false): void {
    const requestId = ++this.#autocompleteRequestId
    if (this.#autocompleteTimer !== null) {
      clearTimeout(this.#autocompleteTimer)
      this.#autocompleteTimer = null
    }
    this.#autocompleteAbort?.abort()
    this.#autocompleteAbort = null
    if (this.#prompt !== null) {
      this.#ac = null
      return
    }
    const commands = this.#commands()
    const slashResult = slashSuggestions(this.#editor.text, this.#editor.cursor, commands)
    if (slashResult !== null) {
      this.#setAutocomplete(slashResult)
      return
    }
    const pathOptions = {
      cwd: this.#cwd,
      projectRoot: this.#projectRoot,
      home: this.#home,
      listDir: this.#listDir,
      force: forcePath,
    }
    const token = findPathToken(this.#editor.text, this.#editor.cursor, forcePath)
    const { line, col } = editorLineAt(this.#editor.text, this.#editor.cursor)
    const at = forcePath ? undefined : activeAtToken(line, col)
    const atPrefix = at?.query.replaceAll('\\', '/')
      ?? (token?.kind === 'at' ? parsePathPrefix(token.prefix).raw.replaceAll('\\', '/') : '')
    const fuzzyAt = (at !== undefined || token?.kind === 'at') && atPrefix !== '' && !atPrefix.endsWith('/')
    const harnessAt = at !== undefined
      && (this.#searchFileMentions !== undefined || this.#searchSessions !== undefined)
    if (fuzzyAt || harnessAt) {
      if (harnessAt && !fuzzyAt) {
        this.#setAutocomplete(pathSuggestions(this.#editor.text, this.#editor.cursor, pathOptions, commands))
      } else {
        this.#ac = null
      }
      const text = this.#editor.text
      const cursor = this.#editor.cursor
      this.#autocompleteTimer = setTimeout(() => {
        this.#autocompleteTimer = null
        if (this.#disposed || requestId !== this.#autocompleteRequestId) return
        const controller = new AbortController()
        this.#autocompleteAbort = controller
        const search = this.#searchFileMentions === undefined && this.#searchSessions === undefined
          ? searchPathSuggestions(text, cursor, {
            ...pathOptions,
            searchFiles: this.#searchFiles,
            signal: controller.signal,
          }, commands)
          : searchAtSuggestions(text, cursor, {
            ...pathOptions,
            searchFiles: this.#searchFiles,
            ...(this.#searchFileMentions === undefined ? {} : { searchFileMentions: this.#searchFileMentions }),
            ...(this.#searchSessions === undefined ? {} : { searchSessions: this.#searchSessions }),
            signal: controller.signal,
          }, commands)
        void search.then((result) => {
          if (this.#disposed || controller.signal.aborted || requestId !== this.#autocompleteRequestId) return
          this.#autocompleteAbort = null
          this.#setAutocomplete(result)
          this.#render()
        }).catch((error: unknown) => {
          if (controller.signal.aborted || requestId !== this.#autocompleteRequestId) return
          this.#autocompleteAbort = null
          this.#ac = null
          if ((error as { name?: unknown }).name !== 'AbortError') this.#render()
        })
      }, this.#autocompleteDebounceMs)
      return
    }
    const result = pathSuggestions(this.#editor.text, this.#editor.cursor, pathOptions, commands)
    this.#setAutocomplete(result)
  }

  #setAutocomplete(result: { items: AutocompleteItem[]; prefix: string } | null): void {
    if (result === null) {
      this.#ac = null
      return
    }
    const prev = this.#ac?.items[this.#ac.selected]?.value
    let selected = nextSelectableAutocompleteIndex(result.items, 0, 1)
    if (prev !== undefined) {
      const idx = result.items.findIndex((item) => item.value === prev && item.kind !== 'heading')
      if (idx >= 0) selected = idx
    }
    this.#ac = { items: result.items, selected }
  }

  #moveAutocomplete(dir: -1 | 1): void {
    if (this.#ac === null || this.#ac.items.length === 0) return
    this.#ac = {
      ...this.#ac,
      selected: nextSelectableAutocompleteIndex(this.#ac.items, this.#ac.selected + dir, dir),
    }
  }

  #applySelectedCompletion(): void {
    const item = this.#ac?.items[this.#ac.selected]
    if (item === undefined || item.kind === 'heading') return
    const next = item.kind === 'path' || item.kind === 'session'
      ? applyPathCompletion(this.#editor.text, this.#editor.cursor, item)
      : applySlashCompletion(this.#editor.text, this.#editor.cursor, item)
    this.#editor.setText(next.text, next.cursor)
    this.#refreshAutocomplete()
  }

  #moveEditorVisual(direction: -1 | 1): boolean {
    const text = this.#editor.text
    const rows = wrapIndexed(text, Math.max(1, this.#term.width() - 4))
    const caret = cursorOnWrapped(rows, this.#editor.cursor, text)
    const target = rows[caret.row + direction]
    if (target === undefined) return false
    const column = this.#verticalColumn ?? caret.column
    this.#verticalColumn = column
    this.#editor.setCursor(indexOnWrapped(target, column, text))
    this.#refreshAutocomplete()
    this.#render()
    return true
  }

  #suspend(): void {
    if (process.platform === 'win32') return
    if (this.#resumeAfterSuspend !== null) process.off('SIGCONT', this.#resumeAfterSuspend)
    this.#term.output.write('\x1b[>4m\x1b[?2004l')
    const resume = (): void => {
      this.#resumeAfterSuspend = null
      if (this.#disposed || !this.#inputActivated) return
      this.#term.output.write('\x1b[?2004h\x1b[>4;2m')
      this.#renderer.reset()
      this.#render()
    }
    this.#resumeAfterSuspend = resume
    process.once('SIGCONT', resume)
    try {
      process.kill(process.pid, 'SIGTSTP')
    } catch {
      process.off('SIGCONT', resume)
      this.#resumeAfterSuspend = null
      this.#term.output.write('\x1b[?2004h\x1b[>4;2m')
    }
  }

  #applyCommand(command: EditorCommand): void {
    if (command.kind === 'changed') {
      this.#reconcileImageDrafts()
      if (command.edited === true) this.#historyIndex = 0
      this.#refreshAutocomplete()
      this.#render()
      return
    }
    if (command.kind === 'submit') {
      if (this.#inspected !== undefined) {
        if (this.#inspected.writable === true) this.#submitInspect(command.text)
        return
      }
      this.#submit(command.text)
      return
    }
    if (command.kind === 'historyPrev') {
      if (this.#restoreLatestQueuedSubmission()) return
      this.#historyPrev()
      return
    }
    if (command.kind === 'historyNext') {
      this.#historyNext()
      return
    }
    if (command.kind === 'interrupt') {
      if (this.#state.status === 'running') {
        for (const listener of this.#interrupts) listener()
      }
      return
    }
    if (command.kind === 'clear') {
      this.#editor.clear()
      this.#images = []
      this.#queueEditNewer = null
      this.#queueEditPending = false
      this.#historyIndex = 0
      this.#ac = null
      this.#search = null
      this.#render()
      return
    }
    if (command.kind === 'quit') {
      this.#quit()
      return
    }
    if (command.kind === 'suspend') {
      this.#suspend()
      return
    }
    if (command.kind === 'resetDisplay') {
      this.#renderer.reset()
      this.#render()
    }
  }

  #historyPrev(): void {
    if (this.#images.length > 0) return
    if (this.#history.length === 0 || this.#historyIndex >= this.#history.length) return
    if (this.#historyIndex === 0) this.#draft = this.#editor.text
    this.#historyIndex += 1
    this.#editor.setText(this.#history[this.#history.length - this.#historyIndex] ?? '')
    this.#refreshAutocomplete()
    this.#render()
  }

  #restoreLatestQueuedSubmission(): boolean {
    if (this.#queueEditPending) return true
    if (this.#queueEditNewer !== null) {
      const previous = this.#queuedSubmissions.pop()
      if (previous !== undefined) {
        this.#queueEditNewer.unshift(this.#currentSubmission())
        this.#replaceInput(previous)
        return true
      }
      const hasDurableFollowup = this.#state.nextTurnInbox.some(message => message.source.kind === 'user')
      if (!hasDurableFollowup || this.#queueEdits.size === 0) return true
      this.#queueEditPending = true
      for (const listener of this.#queueEdits) listener()
      return true
    }
    if (this.#editor.text !== '' || this.#images.length > 0 || this.#historyIndex !== 0) return false
    const submission = this.#queuedSubmissions.pop()
    if (submission !== undefined) {
      this.#queueEditNewer = []
      this.#replaceInput(submission)
      return true
    }
    const hasDurableFollowup = this.#state.nextTurnInbox.some(message => message.source.kind === 'user')
    if (!hasDurableFollowup || this.#queueEdits.size === 0) return false
    this.#queueEditNewer = []
    this.#queueEditPending = true
    for (const listener of this.#queueEdits) listener()
    return true
  }

  #historyNext(): void {
    if (this.#images.length > 0) return
    if (this.#historyIndex === 0) return
    this.#historyIndex -= 1
    this.#editor.setText(
      this.#historyIndex === 0 ? this.#draft : (this.#history[this.#history.length - this.#historyIndex] ?? ''),
    )
    this.#refreshAutocomplete()
    this.#render()
  }

  #quit(): void {
    this.#resumeHintRequested = true
    if (this.#pending !== null) {
      const pending = this.#pending
      this.#pending = null
      pending.resolve(null)
    } else {
      this.#quitRequested = true
    }
  }

  #submit(text: string): void {
    if (this.#prompt !== null) {
      this.#editor.setText('')
      this.#finishPrompt(text.trim() === '' ? null : text.trim())
      this.#render()
      return
    }
    const images = this.#images.map(image => ({ ...image }))
    const submittedText = images.length > 0 ? text.trim() : text
    const queueEditNewer = this.#queueEditNewer
    const historyText = stripComposerImageMarkers(submittedText, images)
      .replace(/[ \t]{2,}/gu, ' ')
      .trim()
    if (historyText !== '' && this.#history[this.#history.length - 1] !== historyText) {
      this.#history.push(historyText)
      this.#historyStore?.add(historyText)
    }
    this.#historyIndex = 0
    this.#draft = ''
    this.#queueEditNewer = null
    this.#queueEditPending = false
    this.#editor.setText('')
    this.#images = []
    this.#ac = null
    this.#search = null
    this.#settings = null
    this.#copySelector = null
    this.#followTail()
    // Image placeholders are TUI-owned. Mixed image+slash drafts stay a
    // submission so restore can keep the original markers; the runner strips
    // them only to detect and execute Harness commands.
    const slash = images.length === 0 ? parseSlashInput(submittedText) : null
    if (slash !== null) {
      if (queueEditNewer !== null) this.#queuedSubmissions.push(...queueEditNewer)
      this.#runSlash(slash.name, slash.args)
      return
    }
    const pending = this.#pending
    if (pending !== null) {
      this.#pending = null
      pending.resolve({ text: submittedText, images })
      if (queueEditNewer !== null) this.#queuedSubmissions.push(...queueEditNewer)
    } else if (submittedText !== '' || images.length > 0 || queueEditNewer !== null) {
      if (submittedText !== '' || images.length > 0) {
        this.#queuedSubmissions.push({ text: submittedText, images })
      }
      if (queueEditNewer !== null) this.#queuedSubmissions.push(...queueEditNewer)
    }
    this.#render()
  }

  #submitInspect(text: string): void {
    const images = this.#images.map(image => ({ ...image }))
    const submittedText = images.length > 0 ? text.trim() : text
    const historyText = stripComposerImageMarkers(submittedText, images)
      .replace(/[ \t]{2,}/gu, ' ')
      .trim()
    if (historyText !== '' && this.#history[this.#history.length - 1] !== historyText) {
      this.#history.push(historyText)
      this.#historyStore?.add(historyText)
    }
    this.#historyIndex = 0
    this.#draft = ''
    this.#editor.setText('')
    this.#images = []
    this.#ac = null
    this.#search = null
    this.#followTail()
    const slash = images.length === 0 ? parseSlashInput(submittedText) : null
    if (slash !== null) {
      this.#runSlash(slash.name, slash.args)
      return
    }
    if (submittedText === '' && images.length === 0) {
      this.#render()
      return
    }
    for (const listener of this.#inspectSubmits) listener({ text: submittedText, images })
    this.#render()
  }

  #runSlash(name: string, args = ''): void {
    if (name === '') {
      this.#render()
      return
    }
    const command = resolveSlashCommand(name, this.#commands())
    if (command === undefined) {
      this.#notice('unknown command: /' + name)
      this.#render()
      return
    }
    if (command.name === 'quit') {
      this.#render()
      this.#quit()
      return
    }
    if (command.name === 'clear') {
      this.#state = initialTranscript()
      this.#followTail()
      this.#renderer.startEpoch()
      this.#render()
      return
    }
    if (command.name === 'trajectory' && this.#trajectorySource !== null) {
      const words = args.trim().split(/\s+/u).filter(Boolean)
      const firstArgument = words[0] ?? ''
      const textMode = firstArgument === 'text' || firstArgument === 'ledger'
      if (!textMode) {
        const companionMode = firstArgument === 'companion' || firstArgument === 'block' || firstArgument === 'detached'
        if (companionMode && this.#trajectorySource.openCompanion === undefined) {
          this.#notice('Trajectory companion requires a direct Surfterm block.')
          this.#render()
          return
        }
        let options: TuiTrajectoryOptions
        try {
          options = parseTrajectoryOptions(companionMode ? words.slice(1).join(' ') : args)
        } catch (error: unknown) {
          this.#notice(error instanceof Error ? error.message : String(error))
          this.#render()
          return
        }
        const opened = companionMode
          ? this.#trajectorySource.openCompanion!(options)
          : this.openTrajectory(this.#trajectorySource, options)
        void opened.catch((error: unknown) => {
          this.#notice(error instanceof Error ? error.message : String(error))
          this.#render()
        })
        return
      }
    }
    if (command.name === 'settings') {
      this.#runSettings(args)
      return
    }
    if (command.name === 'detail') {
      this.#runDetail(args)
      return
    }
    if (command.name === 'copy') {
      void this.#runCopy(args)
      return
    }
    if (command.name === 'tools') {
      this.#toolCatalog()
      this.#render()
      return
    }
    if (!BUILTIN_SLASH_COMMANDS.some((entry) => entry.name === command.name)) {
      if (this.#inspected !== undefined) {
        this.#notice('Return to the parent session to run /' + command.name + '.')
        this.#render()
        return
      }
      const raw = '/' + name + (args === '' ? '' : ' ' + args)
      const pending = this.#pending
      if (pending !== null) {
        this.#pending = null
        pending.resolve({ text: raw, images: [] })
      } else {
        this.#queuedSubmissions.push({ text: raw, images: [] })
      }
      this.#render()
      return
    }
    if (args !== '' && args !== 'full') {
      this.#notice('Usage: /help [full]')
      this.#render()
      return
    }
    const full = args === 'full'
    this.#state = {
      ...this.#state,
      blocks: [...this.#state.blocks, {
        kind: 'commandOutput',
        command: 'help',
        text: [
          formatHelpText(this.#commands()),
          '',
          full
            ? `**Keyboard Shortcuts · ${hotkeyCount(this.#keybindings)} bindings**`
            : '**Essential Shortcuts**',
          '',
          full
            ? formatHotkeysText(this.#keybindings)
            : formatEssentialHotkeysText(this.#keybindings),
          ...(full ? [] : ['', 'Use `/help full` to view every keyboard shortcut.']),
        ].join('\n'),
      }],
    }
    this.#focusLatestBlock()
    this.#render()
  }

  #commands(): readonly SlashCommand[] {
    const localNames = new Set(BUILTIN_SLASH_COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])]))
    const runtime: SlashCommand[] = this.#runtimeCommands
      .filter((command) => !localNames.has(command.name))
      .map((command) => ({
        name: command.name,
        description: command.description,
        ...(command.inputHint === undefined ? {} : { inputHint: command.inputHint }),
      }))
    return [...BUILTIN_SLASH_COMMANDS, ...runtime]
  }

  #finishPrompt(answer: string | null): void {
    const pending = this.#prompt
    if (pending === null) return
    this.#prompt = null
    pending.offAbort?.()
    pending.resolve(answer)
  }

  async #runCopy(args: string): Promise<void> {
    if (args.trim() === '') {
      const items = buildCopyTargets(this.#state.blocks)
      if (items.length === 0) {
        this.#notice('Nothing to copy.')
        this.#render()
        return
      }
      this.#search = null
      this.#ac = null
      this.#settings = null
      this.#copySelector = createCopySelector(items)
      this.#render()
      return
    }
    const kind = parseCopyKind(args)
    if (kind === undefined) {
      this.#notice('Usage: /copy [code|cmd]')
      this.#render()
      return
    }
    const target = extractCopyTarget(this.#state.blocks, kind)
    if (target === undefined) {
      this.#notice(kind === 'code' ? 'No code block to copy.' : kind === 'cmd' ? 'No command to copy.' : 'Nothing to copy.')
      this.#render()
      return
    }
    await this.#copyPicked(target.text, target.label)
  }

  #runDetail(args: string): void {
    const value = args.trim().toLowerCase()
    if (value === '') {
      this.#search = null
      this.#ac = null
      this.#settings = createSettings(this.#prefs(), 'activityDetail')
      this.#render()
      return
    }
    if (!isActivityDetailMode(value)) {
      this.#notice(`Usage: /detail [${ACTIVITY_DETAIL_MODES.join('|')}]`)
      this.#render()
      return
    }
    this.#applyPrefs({ ...this.#prefs(), activityDetail: value })
    this.#notice('Activity detail: ' + value)
    this.#render()
  }

  #runSettings(args: string): void {
    if (args.trim() !== '') {
      this.#notice('Usage: /settings')
      this.#render()
      return
    }
    this.#search = null
    this.#ac = null
    this.#settings = createSettings(this.#prefs())
    this.#render()
  }

  #notice(text: string): void {
    this.#state = {
      ...this.#state,
      blocks: [...this.#state.blocks, { kind: 'notice', level: 'info', text }],
    }
  }

  #toolCatalog(): void {
    this.#state = {
      ...this.#state,
      blocks: [...this.#state.blocks, { kind: 'toolCatalog', tools: this.#tools }],
    }
    this.#focusLatestBlock()
  }

  #focusLatestBlock(): void {
    this.#follow = false
    this.#focusBlock = Math.max(0, this.#state.blocks.length - 1)
  }

  #runAction(action: TuiAction): void {
    if (this.#prompt !== null || this.#settings !== null || this.#copySelector !== null) return
    if (action === 'trajectory') {
      if (this.#trajectorySource === null) {
        this.#notice('Trajectory source is not available in this session.')
        this.#render()
      } else {
        void this.openTrajectory(this.#trajectorySource).catch((error: unknown) => {
          this.#notice(error instanceof Error ? error.message : String(error))
          this.#render()
        })
      }
      return
    }
    if (action === 'inspect-subagent') {
      void this.#pickSubagent()
      return
    }
    if (action === 'retry') {
      this.#submit('/retry')
      return
    }
    if (action === 'copy-prompt') {
      void this.#copyPicked(this.#editor.text, 'current prompt')
      return
    }
    if (action === 'copy-line') {
      const text = this.#editor.text.slice(
        lineStart(this.#editor.text, this.#editor.cursor),
        lineEnd(this.#editor.text, this.#editor.cursor),
      )
      void this.#copyPicked(text, 'current line')
      return
    }
    if (action === 'paste-clipboard') {
      this.#startAsyncPaste(this.#pasteClipboard())
      return
    }
    try {
      this.#term.input.setRawMode?.(false)
      const text = editExternally(this.#editor.text)
      this.#editor.setText(text)
      this.#reconcileImageDrafts()
    } catch (error: unknown) {
      this.notice(error instanceof Error ? error.message : String(error), { level: 'error' })
    } finally {
      this.#term.input.setRawMode?.(true)
      this.#renderer.reset()
      this.#refreshAutocomplete()
      this.#render()
    }
  }
}

function processTerminal(): TerminalLike {
  return {
    output: process.stdout,
    input: process.stdin,
    width: () => process.stdout.columns ?? 80,
    height: () => process.stdout.rows ?? 24,
    onResize: (listener) => {
      process.stdout.on('resize', listener)
      return () => { process.stdout.removeListener('resize', listener) }
    },
  }
}

export interface TrajectoryTerminalConfig {
  terminal?: TerminalLike
  colors?: boolean
  theme?: string
  copy?: ClipboardWriter
  signal?: AbortSignal
}

/** Run the native Trajectory renderer as a dedicated read-only terminal application. */
export async function runTrajectoryTerminal(
  source: TuiTrajectorySource,
  options: TuiTrajectoryOptions = {},
  config: TrajectoryTerminalConfig = {},
): Promise<void> {
  const term = config.terminal ?? processTerminal()
  const tui = new LocalTui(
    term,
    'Trajectory',
    config.colors ?? term.output.isTTY === true,
    parseThemeName(config.theme),
    config.copy ?? copyToClipboard,
    {
      deferInitialRender: true,
      terminalProfile: 'direct',
      alternateScreenOverlays: true,
    },
  )
  tui.activateInput()
  const abort = (): void => { tui.dispose() }
  if (config.signal?.aborted === true) abort()
  else config.signal?.addEventListener('abort', abort, { once: true })
  try {
    await tui.openTrajectory(source, options)
  } finally {
    config.signal?.removeEventListener('abort', abort)
    tui.dispose()
  }
}

/**
 * Mount the local terminal provider as the tui service.
 * @param ctx - plugin context.
 * @param config - model label and color switch.
 */
export function apply(ctx: Context, config: Config): void {
  const dshHome = process.env.OMDSH_HOME ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const terminalProfile = detectTerminalProfile()
  const term = processTerminal()
  const tui = new LocalTui(
    term,
    config.model,
    config.colors ?? term.output.isTTY === true,
    parseThemeName(config.theme),
    copyToClipboard,
    {
      deferInitialRender: true,
      terminalProfile,
      alternateScreenOverlays: terminalProfile === 'direct',
      hostTelemetry: terminalProfile === 'direct'
        && process.env.WAVETERM !== undefined
        && process.env.WAVETERM_BLOCKID !== undefined,
      historyPath: config.historyPath ?? join(dshHome, 'omdsh', 'history.jsonl'),
      keybindingsPath: config.keybindingsPath ?? join(dshHome, 'omdsh', 'keybindings.json'),
    },
  )
  ctx.provide(TUI_SERVICE, tui)
  ctx.effect(() => () => { tui.dispose() })
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(
      settingsNamespace(TUI_SETTINGS_NAMESPACE),
      TuiSettingsSchema,
      { base: { theme: parseThemeName(config.theme), colors: config.colors ?? term.output.isTTY === true, expandTools: false, activityDetail: 'standard' } },
    )
    tui.applyStoredPrefs(scope.get())
    tui.setPrefsPersist((prefs) => { void scope.update(prefs) })
    scope.watch((next) => { tui.applyStoredPrefs(next) })
  })
}
