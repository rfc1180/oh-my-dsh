/**
 * Fixed two-line session footer rendered below the composer.
 *
 * The caller supplies one stable projection; this module owns copy,
 * responsive group selection, color hierarchy, and terminal layout. English
 * copy deliberately stays local until a runtime language module provides a
 * second locale — then this is the single seam where a dictionary is chosen.
 * @module @agi-fans/dsh-tui/status-line
 */

import type { TuiLoopStatus, TuiSessionControls, TuiSessionStats } from '../definition.ts'
import { formatAgentPreset, formatToolPresentation } from '../session/session-configuration.ts'
import {
  defaultStatusBarConfig,
  itemSide,
  resolveStatusBarConfig,
  type StatusBarConfig,
  type StatusColorToken,
  type StatusGroupId,
  type StatusItemId,
  type StatusMetaId,
} from './status-config.ts'
import type { Theme, ThemeColor } from './theme.ts'
import { padToWidth, truncateToWidth, visibleWidth } from './width.ts'

type StatusTone = 'label' | 'value' | 'positive' | 'token' | 'separator'

interface StatusPart {
  text: string
  tone: StatusTone
}

interface StatusGroup {
  id: StatusGroupId
  parts: StatusPart[]
  /** Shortest loss-aware form used only by the compact responsive layout. */
  denseParts?: StatusPart[]
}

interface StatusGroupSelection {
  groups: StatusGroup[]
  separator: string
}

const LABEL_PADDING = 2
const GROUP_SEPARATOR = ' • '
const DENSE_GROUP_SEPARATOR = '·'
const FOOTER_PADDING = 2
const COLUMN_GAP = 3
const TELEMETRY_COLUMN_GAP = 1
/** Context needed to render the fixed session footer. */
export interface StatusFooterOptions {
  model: string
  reasoningEffort?: string
  controls?: TuiSessionControls
  loop?: TuiLoopStatus
  pwd?: string
  branch?: string
  stats?: TuiSessionStats
  config: StatusBarConfig
  width: number
  /** Settings preview: underline the focused item. */
  focus?: StatusItemId
}

/** Compact token count: 517 / 12.2K / 517K / 1.2M. */
export function formatTokens(value: number): string {
  const scaled = (n: number): string => n >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10)
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${scaled(value / 1_000)}K`
  return `${scaled(value / 1_000_000)}M`
}

/** Compact duration: 45.2s under a minute, 2m42s from there on. */
export function formatDuration(ms: number): string {
  const seconds = ms / 1_000
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

/** Dense clock form: 45.2s, 16:51, then 16h40m for long sessions. */
function formatDenseDuration(ms: number): string {
  const wholeSeconds = Math.round(ms / 1_000)
  if (wholeSeconds < 60) return `${Math.round(ms / 100) / 10}s`
  const wholeMinutes = Math.floor(wholeSeconds / 60)
  if (wholeMinutes < 60) return `${wholeMinutes}:${String(wholeSeconds % 60).padStart(2, '0')}`
  return `${Math.floor(wholeMinutes / 60)}h${wholeMinutes % 60}m`
}

/** Human-readable model throughput with the same precision as dsh web. */
export function formatTokensPerSecond(value: number): string {
  return value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10)
}

function formatContextPercent(tokens: number, window: number): string {
  const percent = Math.max(0, tokens) / window * 100
  const rounded = percent < 10 ? Math.round(percent * 10) / 10 : Math.round(percent)
  return String(rounded)
}

function part(text: string, tone: StatusTone): StatusPart {
  return { text, tone }
}

function metric(label: string, value: string, tone: StatusTone = 'value'): StatusPart[] {
  return [part(label + ' ', 'label'), part(value, tone)]
}

/**
 * English semantic groups; language selection will replace copy here. Dense
 * prefixes are T/S (turns/steps), L/Tl (LLM/tools), F/R (first token/rate),
 * C (cache), I/O (tokens), and X (context).
 */
function buildStatusGroups(stats: TuiSessionStats, config: StatusBarConfig): StatusGroup[] {
  const groups: StatusGroup[] = []
  if (stats.contextWindow !== undefined && stats.contextWindow > 0) {
    const used = stats.contextTokens ?? 0
    groups.push({
      id: 'context',
      parts: [
        ...metric(config.labels === 'compact' ? 'Ctx' : 'Context', `${formatContextPercent(used, stats.contextWindow)}%`),
        part(' · ', 'separator'),
        part(`${formatTokens(used)}/${formatTokens(stats.contextWindow)}`, 'token'),
      ],
      denseParts: [part(`X${formatContextPercent(used, stats.contextWindow)}%`, 'token')],
    })
  }
  const countParts = [
    part(String(stats.turns), 'value'),
    part(stats.turns === 1 ? ' turn' : ' turns', 'label'),
    part(' · ', 'separator'),
    part(String(stats.steps), 'value'),
    part(stats.steps === 1 ? ' step' : ' steps', 'label'),
  ]
  groups.push({
    id: 'counts',
    parts: countParts,
    denseParts: [part(`T${stats.turns}/S${stats.steps}`, 'value')],
  })
  if (stats.steps > 0) {
    const durations: StatusPart[] = []
    const denseDurations: StatusPart[] = []
    if (stats.llmMs > 0) {
      durations.push(...metric('LLM', formatDuration(stats.llmMs)))
      denseDurations.push(part(`L${formatDenseDuration(stats.llmMs)}`, 'value'))
    }
    if (stats.llmMs > 0 && stats.toolMs > 0) {
      durations.push(part(' · ', 'separator'))
      denseDurations.push(part('/', 'separator'))
    }
    if (stats.toolMs > 0) {
      durations.push(...metric('Tools', formatDuration(stats.toolMs)))
      denseDurations.push(part(`Tl${formatDenseDuration(stats.toolMs)}`, 'value'))
    }
    if (durations.length > 0) groups.push({ id: 'durations', parts: durations, denseParts: denseDurations })

    const speed: StatusPart[] = []
    const denseSpeed: StatusPart[] = []
    if (stats.ttftSteps > 0) {
      const ttft = stats.ttftMs / stats.ttftSteps
      speed.push(...metric('TTFT', formatDuration(ttft)))
      denseSpeed.push(part(`F${formatDenseDuration(ttft)}`, 'value'))
    }
    if (stats.ttftSteps > 0 && stats.decodeMs > 0) {
      speed.push(part(' · ', 'separator'))
      denseSpeed.push(part('/', 'separator'))
    }
    if (stats.decodeMs > 0) {
      const rate = formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000))
      speed.push(part(`${rate} tok/s`, 'value'))
      denseSpeed.push(part(`R${rate}`, 'value'))
    }
    if (speed.length > 0) groups.push({ id: 'speed', parts: speed, denseParts: denseSpeed })
  }

  if (stats.inputTokens > 0 || stats.outputTokens > 0) {
    if (stats.inputTokens > 0) {
      const cachePercent = `${Math.round(stats.cacheReadTokens / stats.inputTokens * 100)}%`
      groups.push({
        id: 'cache',
        parts: metric('Cache', cachePercent, 'positive'),
        denseParts: [part(`C${cachePercent}`, 'positive')],
      })
    }
    groups.push({
      id: 'tokens',
      parts: [
        part(formatTokens(stats.inputTokens), 'token'),
        part(' in', 'label'),
        part(' · ', 'separator'),
        part(formatTokens(stats.outputTokens), 'token'),
        part(' out', 'label'),
      ],
      denseParts: [
        part(`I${formatTokens(stats.inputTokens)}`, 'token'),
        part('/', 'separator'),
        part(`O${formatTokens(stats.outputTokens)}`, 'token'),
      ],
    })
  }
  const visible = new Set(config.groups)
  return (config.order ?? config.groups)
    .filter(id => visible.has(id))
    .flatMap(id => groups.filter(group => group.id === id))
}

function groupText(group: StatusGroup): string {
  return group.parts.map(item => item.text).join('')
}

function denseGroup(group: StatusGroup): StatusGroup {
  return group.denseParts === undefined ? group : { ...group, parts: group.denseParts }
}

/** Build the unpainted English groups for diagnostics and tests. */
export function sessionStatusGroups(
  stats: TuiSessionStats,
  config: StatusBarConfig = defaultStatusBarConfig(),
): string[] {
  const normalized = resolveStatusBarConfig(config)
  if (!normalized.enabled) return []
  return buildStatusGroups(stats, normalized).map(groupText)
}

function groupsWidth(groups: readonly StatusGroup[], separator = GROUP_SEPARATOR): number {
  if (groups.length === 0) return 0
  return groups.reduce((total, group) => total + visibleWidth(groupText(group)), 0)
    + visibleWidth(separator) * (groups.length - 1)
}

function layoutWidth(groups: readonly StatusGroup[], separator = GROUP_SEPARATOR): number {
  return LABEL_PADDING + groupsWidth(groups, separator)
}

/** Maximize complete groups, using configured order to break equal-size ties. */
function selectBestGroups(
  groups: readonly StatusGroup[],
  fits: (selection: readonly StatusGroup[]) => boolean,
): StatusGroup[] {
  let best: StatusGroup[] = []
  const bestIds = (): Set<StatusGroupId> => new Set(best.map(group => group.id))
  for (let mask = 1; mask < 1 << groups.length; mask += 1) {
    const selection = groups.filter((_, index) => (mask & (1 << index)) !== 0)
    if (!fits(selection) || selection.length < best.length) continue
    if (selection.length > best.length) {
      best = selection
      continue
    }
    const selected = new Set(selection.map(group => group.id))
    const previous = bestIds()
    const firstDifference = groups.find(group => selected.has(group.id) !== previous.has(group.id))
    if (firstDifference !== undefined && selected.has(firstDifference.id)) best = selection
  }
  return best
}

/**
 * Follow configured priority greedily, but retain the previous high-water group
 * count when a newly fitting wide group would otherwise evict several metrics.
 */
function selectStableGroups(
  groups: readonly StatusGroup[],
  capacity: number,
  measure: (selection: readonly StatusGroup[]) => number,
): StatusGroup[] {
  const greedyAt = (width: number): StatusGroup[] => {
    const selected: StatusGroup[] = []
    for (const group of groups) {
      const candidate = [...selected, group]
      if (measure(candidate) <= width) selected.push(group)
    }
    return selected
  }
  const greedy = greedyAt(capacity)
  let highWaterCount = greedy.length
  const thresholds = new Set<number>()
  for (let mask = 1; mask < 1 << groups.length; mask += 1) {
    const selection = groups.filter((_, index) => (mask & (1 << index)) !== 0)
    const threshold = measure(selection)
    if (threshold <= capacity) thresholds.add(threshold)
  }
  for (const threshold of thresholds) {
    highWaterCount = Math.max(highWaterCount, greedyAt(threshold).length)
  }
  if (greedy.length === highWaterCount) return greedy
  return selectBestGroups(groups, selection =>
    selection.length <= highWaterCount && measure(selection) <= capacity)
}

/**
 * Preserve normal copy when every requested group fits, tightening only the
 * separators when that avoids abbreviation. Otherwise compact mode switches
 * the whole row to a dense, stable vocabulary and skips only groups that still
 * cannot fit, allowing smaller later groups to use the remaining cells.
 */
function selectGroups(
  groups: readonly StatusGroup[],
  width: number,
  config: StatusBarConfig,
): StatusGroupSelection {
  if (layoutWidth(groups) <= width) return { groups: [...groups], separator: GROUP_SEPARATOR }
  const dense = config.labels === 'compact'
  if (dense && layoutWidth(groups, DENSE_GROUP_SEPARATOR) <= width) {
    return { groups: [...groups], separator: DENSE_GROUP_SEPARATOR }
  }
  const candidates = dense ? groups.map(denseGroup) : [...groups]
  const separator = dense ? DENSE_GROUP_SEPARATOR : GROUP_SEPARATOR
  const selected = selectStableGroups(candidates, width, candidate => layoutWidth(candidate, separator))
  return { groups: selected, separator }
}

function tokenThemeColor(token: StatusColorToken | undefined, fallback: ThemeColor): ThemeColor {
  if (token === undefined || token === 'default') return fallback
  return token === 'label' ? 'customMessageLabel' : token
}

function itemColor(config: StatusBarConfig, id: StatusItemId, fallback: ThemeColor): ThemeColor {
  const direct = config.colors?.[id]
  if (direct !== undefined && direct !== 'default') return tokenThemeColor(direct, fallback)
  return fallback
}

function toneColor(tone: StatusTone, config: StatusBarConfig, group: StatusGroupId): ThemeColor {
  if (tone === 'positive') return 'success'
  if (tone === 'separator') return 'dim'
  if (tone === 'label') return 'muted'
  const custom = itemColor(config, group, 'text')
  if (config.colors?.[group] !== undefined && config.colors[group] !== 'default') return custom
  if (config.colors?.metrics !== undefined && config.colors.metrics !== 'default') return tokenThemeColor(config.colors.metrics, 'text')
  return tone === 'value' ? 'text' : 'customMessageLabel'
}

function paintGroup(group: StatusGroup, theme: Theme, config: StatusBarConfig, focus?: StatusItemId): string {
  const painted = group.parts.map(item => theme.fg(toneColor(item.tone, config, group.id), item.text)).join('')
  return focus === group.id ? theme.underline(painted) : painted
}

function paintColumn(
  groups: readonly StatusGroup[],
  theme: Theme,
  config: StatusBarConfig,
  separatorText = GROUP_SEPARATOR,
  focus?: StatusItemId,
): string {
  const separator = theme.fg('dim', separatorText)
  return groups.map(group => paintGroup(group, theme, config, focus)).join(separator)
}

function splitWidth(
  left: readonly StatusGroup[],
  right: readonly StatusGroup[],
  separator = GROUP_SEPARATOR,
): number {
  const leftWidth = groupsWidth(left, separator)
  const rightWidth = groupsWidth(right, separator)
  return leftWidth + rightWidth + (leftWidth > 0 && rightWidth > 0 ? TELEMETRY_COLUMN_GAP : 0)
}

/** Select whole groups in user order, then place each on its configured column. */
function selectFooterGroups(
  groups: readonly StatusGroup[],
  width: number,
  config: StatusBarConfig,
): { left: StatusGroup[]; right: StatusGroup[]; separator: string } {
  const distribute = (candidates: readonly StatusGroup[], separator: string) => {
    const left = candidates.filter(group => itemSide(config, group.id) === 'left')
    const right = candidates.filter(group => itemSide(config, group.id) === 'right')
    return { left, right, separator }
  }
  const natural = distribute(groups, GROUP_SEPARATOR)
  if (splitWidth(natural.left, natural.right) <= width) return natural
  const dense = config.labels === 'compact'
  if (dense) {
    const tight = distribute(groups, DENSE_GROUP_SEPARATOR)
    if (splitWidth(tight.left, tight.right, DENSE_GROUP_SEPARATOR) <= width) return tight
  }
  const candidates = dense ? groups.map(denseGroup) : [...groups]
  const separator = dense ? DENSE_GROUP_SEPARATOR : GROUP_SEPARATOR
  const selected = selectStableGroups(candidates, width, selection => {
    const columns = distribute(selection, separator)
    return splitWidth(columns.left, columns.right, separator)
  })
  return distribute(selected, separator)
}

function renderSplitRow(left: string, right: string, width: number): string {
  if (width <= 0) return ''
  const padding = width >= FOOTER_PADDING * 2 ? FOOTER_PADDING : 0
  const innerWidth = Math.max(0, width - padding * 2)
  const leftWidth = visibleWidth(left)
  const rightWidth = visibleWidth(right)
  if (leftWidth === 0 || rightWidth === 0) {
    const content = leftWidth > 0 ? truncateToWidth(left, innerWidth) : truncateToWidth(right, innerWidth)
    return padToWidth(' '.repeat(padding) + content, width)
  }
  const gap = Math.max(1, innerWidth - leftWidth - rightWidth)
  return padToWidth(' '.repeat(padding) + left + ' '.repeat(gap) + right, width)
}

function sessionConfigurationStatus(controls: TuiSessionControls | undefined): { text: string; tone: ThemeColor } | undefined {
  if (controls === undefined) return undefined
  const agent = formatAgentPreset(controls.agentPreset ?? 'standard').toLowerCase()
  const parts = [agent]
  if (controls.plan?.pending === true) parts.push(controls.plan.active ? 'plan off…' : 'plan…')
  else if (controls.plan?.active === true) parts.push('plan')
  if (controls.tools !== undefined && controls.tools !== 'native') {
    parts.push(formatToolPresentation(controls.tools).toLowerCase())
  }
  return {
    text: parts.join(' · '),
    tone: controls.plan?.pending === true ? 'warning' : 'accent',
  }
}

function loopStatus(loop: TuiLoopStatus | undefined): { text: string; tone: ThemeColor } | undefined {
  if (loop === undefined) return undefined
  const repeatProgress = loop.total === undefined ? undefined : `${loop.repeats ?? 0}/${loop.total} REPEATS`
  if (loop.phase === 'completed') {
    const completed = loop.repeats === undefined ? '' : ` · ${loop.repeats} ${loop.repeats === 1 ? 'REPEAT' : 'REPEATS'}`
    return { text: `LOOP DONE${completed}`, tone: 'success' }
  }
  if (loop.phase === 'paused') return { text: 'LOOP PAUSED · SEND TO RESUME', tone: 'warning' }
  if (loop.phase === 'waiting') {
    const budget = repeatProgress ?? loop.limit
    return { text: `LOOP WAITING · SEND PROMPT${budget === undefined ? '' : ` · ${budget}`}`, tone: 'accent' }
  }
  if (repeatProgress !== undefined) return { text: `LOOP · ${repeatProgress}`, tone: 'accent' }
  if (loop.deadline !== undefined) {
    const remainingMs = Math.max(0, loop.deadline - Date.now())
    return { text: `LOOP · ${formatDuration(Math.max(1_000, remainingMs))} LEFT`, tone: 'accent' }
  }
  if (loop.limit !== undefined) return { text: `LOOP · ${loop.limit}`, tone: 'accent' }
  return { text: 'LOOP', tone: 'accent' }
}

function gitTone(branch: string, config: StatusBarConfig): ThemeColor {
  const custom = config.colors?.git
  if (custom !== undefined && custom !== 'default') return tokenThemeColor(custom, 'muted')
  return /(?:^|\s)[*?]\d+/.test(branch) ? 'warning' : 'muted'
}

function visibleMetaIds(config: StatusBarConfig): StatusMetaId[] {
  const order = config.metaOrder ?? ['model', 'effort', 'path', 'git']
  const visible = new Set(config.meta ?? ['model', 'effort', 'path', 'git'])
  return order.filter(id => visible.has(id))
}

function buildMetaParts(
  options: Pick<StatusFooterOptions, 'model' | 'reasoningEffort' | 'pwd' | 'branch'>,
  config: StatusBarConfig,
): { id: StatusItemId; text: string; color: ThemeColor }[] {
  const parts: { id: StatusItemId; text: string; color: ThemeColor }[] = []
  for (const id of visibleMetaIds(config)) {
    if (id === 'model' && options.model !== '') {
      parts.push({ id, text: options.model, color: itemColor(config, 'model', 'text') })
    }
    if (id === 'effort' && options.reasoningEffort !== undefined && options.reasoningEffort !== '') {
      parts.push({ id, text: options.reasoningEffort, color: itemColor(config, 'effort', 'customMessageLabel') })
    }
    if (id === 'path' && options.pwd !== undefined && options.pwd !== '') {
      parts.push({ id, text: options.pwd, color: itemColor(config, 'path', 'muted') })
    }
    if (id === 'git' && options.branch !== undefined && options.branch !== '') {
      parts.push({ id, text: options.branch, color: gitTone(options.branch, config) })
    }
  }
  return parts
}

function permissionTone(permission: string): ThemeColor {
  if (permission === 'danger-full-access' || permission === 'custom') return 'error'
  if (permission === 'read-only') return 'accent'
  return 'success'
}

/** Human-facing permission preset used consistently across terminal surfaces. */
export function formatPermission(permission: string): string {
  if (permission === 'danger-full-access') return 'Full access'
  if (permission === 'workspace-write') return 'Workspace write'
  if (permission === 'read-only') return 'Read only'
  return permission === 'custom' ? 'Custom access' : permission
}

function permissionLabel(permission: string): string {
  return formatPermission(permission).toLowerCase()
}

/** Painted permission mode for the composer top-right cap. */
export function renderPermissionBadge(permission: string | undefined, theme: Theme): string {
  if (permission === undefined || permission === '') return ''
  return theme.fg(permissionTone(permission), permissionLabel(permission))
}

function splitMetaParts(
  options: Pick<StatusFooterOptions, 'model' | 'reasoningEffort' | 'pwd' | 'branch'>,
  config: StatusBarConfig,
): { left: ReturnType<typeof buildMetaParts>; right: ReturnType<typeof buildMetaParts> } {
  const left: ReturnType<typeof buildMetaParts> = []
  const right: ReturnType<typeof buildMetaParts> = []
  for (const part of buildMetaParts(options, config)) {
    if (itemSide(config, part.id) === 'right') right.push(part)
    else left.push(part)
  }
  return { left, right }
}

function metadataColumns(
  options: StatusFooterOptions,
  theme: Theme,
  innerWidth: number,
  config: StatusBarConfig,
  focus?: StatusItemId,
): { left: string; right: string } {
  const separator = ' · '
  const statuses = [sessionConfigurationStatus(options.controls), loopStatus(options.loop)].filter(
    (status): status is { text: string; tone: ThemeColor } => status !== undefined,
  )
  const columns = splitMetaParts(options, config)
  const statusWidth = statuses.reduce((total, status) => total + visibleWidth(status.text), 0)
    + Math.max(0, statuses.length - 1) * visibleWidth(separator)
  const rightNatural = columns.right.reduce((total, part) => total + visibleWidth(part.text), 0)
    + Math.max(0, columns.right.length - 1) * visibleWidth(separator)
  const leftNatural = columns.left.reduce((total, part) => total + visibleWidth(part.text), 0)
    + Math.max(0, columns.left.length - 1) * visibleWidth(separator)
    + (statusWidth === 0 ? 0 : visibleWidth(separator) + statusWidth)
  const gap = leftNatural > 0 && rightNatural > 0 ? COLUMN_GAP : 0
  let leftWidth = leftNatural
  let rightWidth = rightNatural
  if (leftWidth + gap + rightWidth > innerWidth) {
    const available = Math.max(2, innerWidth - gap)
    leftWidth = Math.min(leftNatural, Math.max(1, Math.floor(available * 0.45)))
    rightWidth = Math.max(1, available - leftWidth)
  }
  const statusPainted = statuses.map((status, index) =>
    (index === 0 ? '' : theme.fg('dim', separator)) + theme.fg(status.tone, status.text)).join('')
  const metaLeft = packPreviewParts(columns.left, theme, Math.max(1, leftWidth - (statusWidth === 0 ? 0 : visibleWidth(separator) + statusWidth)), focus)
  const left = metaLeft === ''
    ? statusPainted
    : statusPainted === '' ? metaLeft : metaLeft + theme.fg('dim', separator) + statusPainted
  const right = packPreviewParts(columns.right, theme, rightWidth, focus)
  return { left, right }
}

/**
 * Render the fixed footer: model/workspace metadata first, customizable
 * session telemetry second. Both rows use left/right columns and exact width.
 */
export function renderStatusFooter(options: StatusFooterOptions, theme: Theme): string[] {
  const normalized = resolveStatusBarConfig(options.config)
  const width = Math.max(0, options.width)
  if (width === 0) return ['', '']
  const innerWidth = Math.max(0, width - FOOTER_PADDING * 2)
  const metadata = metadataColumns({ ...options, config: normalized }, theme, innerWidth, normalized, options.focus)
  const telemetryGroups = options.stats === undefined || !normalized.enabled
    ? { left: [], right: [], separator: GROUP_SEPARATOR }
    : selectFooterGroups(buildStatusGroups(options.stats, normalized), innerWidth, normalized)
  return [
    renderSplitRow(metadata.left, metadata.right, width),
    renderSplitRow(
      paintColumn(telemetryGroups.left, theme, normalized, telemetryGroups.separator, options.focus),
      paintColumn(telemetryGroups.right, theme, normalized, telemetryGroups.separator, options.focus),
      width,
    ),
  ]
}

function packPreviewParts(
  parts: readonly { text: string; color: ThemeColor; id?: StatusItemId }[],
  theme: Theme,
  width: number,
  focus?: StatusItemId,
): string {
  if (width <= 0) return ''
  const separator = ' · '
  const separatorWidth = visibleWidth(separator)
  let used = 0
  let out = ''
  for (const part of parts) {
    if (part.text === '') continue
    const prefix = out === '' ? 0 : separatorWidth
    const textWidth = visibleWidth(part.text)
    const paint = (text: string): string => {
      const colored = theme.fg(part.color, text)
      return focus !== undefined && part.id === focus ? theme.underline(colored) : colored
    }
    if (used + prefix + textWidth <= width) {
      if (out !== '') out += theme.fg('dim', separator)
      out += paint(part.text)
      used += prefix + textWidth
      continue
    }
    const remaining = width - used - prefix
    if (remaining <= 0) break
    if (out !== '') out += theme.fg('dim', separator)
    out += paint(truncateToWidth(part.text, remaining))
    break
  }
  return out
}

/**
 * Status sample for `/settings`. Uses the same left/right footer layout as
 * the live two-line status bar.
 */
export function renderStatusPreviewLines(
  options: {
    model: string
    reasoningEffort?: string
    pwd?: string
    branch?: string
    stats?: TuiSessionStats
    config: StatusBarConfig
    width: number
    focus?: StatusItemId
  },
  theme: Theme,
): string[] {
  const normalized = resolveStatusBarConfig(options.config)
  const width = Math.max(0, options.width)
  if (width === 0) return ['', '']
  return renderStatusFooter({
    model: options.model,
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    ...(options.pwd === undefined ? {} : { pwd: options.pwd }),
    ...(options.branch === undefined ? {} : { branch: options.branch }),
    ...(options.stats === undefined ? {} : { stats: options.stats }),
    config: normalized,
    width,
    ...(options.focus === undefined ? {} : { focus: options.focus }),
  }, theme).map(line => line.trim())
}

/**
 * Render the telemetry row without footer metadata. Used by the settings
 * preview and retained as a compatibility seam for direct render callers.
 */
export function renderSessionStatusLabel(
  stats: TuiSessionStats | undefined,
  config: StatusBarConfig,
  theme: Theme,
  width: number,
): string {
  const normalized = resolveStatusBarConfig(config)
  if (stats === undefined || !normalized.enabled || width <= LABEL_PADDING) return ''
  const selection = selectGroups(buildStatusGroups(stats, normalized), width, normalized)
  if (selection.groups.length === 0) return ''
  const line = ' ' + paintColumn(selection.groups, theme, normalized, selection.separator) + ' '
  return truncateToWidth(line, width)
}
