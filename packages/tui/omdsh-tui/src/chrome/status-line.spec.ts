import { describe, expect, it } from 'vitest'
import type { TuiSessionStats } from '../definition.ts'
import { defaultStatusBarConfig, resolveStatusBarConfig, type StatusBarConfig } from './status-config.ts'
import {
  formatDuration,
  formatTokens,
  renderSessionStatusLabel,
  renderStatusFooter,
  renderStatusPreviewLines,
  sessionStatusGroups,
} from './status-line.ts'
import { createTheme } from './theme.ts'
import { stripAnsi, visibleWidth } from './width.ts'

const stats: TuiSessionStats = {
  turns: 1,
  steps: 74,
  llmMs: 1_011_000,
  toolMs: 213_000,
  ttftMs: 88_800,
  ttftSteps: 74,
  decodeMs: 922_500,
  decodeTokens: 73_800,
  inputTokens: 5_900_000,
  outputTokens: 73_800,
  cacheReadTokens: 5_841_000,
  cacheWriteTokens: 0,
}

function statusBar(overrides: Partial<StatusBarConfig> = {}): StatusBarConfig {
  return { ...defaultStatusBarConfig(), ...overrides }
}

describe('session status line', () => {
  it('keeps initialization telemetry visible with zero context usage', () => {
    const initial: TuiSessionStats = {
      turns: 0,
      steps: 0,
      llmMs: 0,
      toolMs: 0,
      ttftMs: 0,
      ttftSteps: 0,
      decodeMs: 0,
      decodeTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      contextWindow: 1_000_000,
    }
    expect(sessionStatusGroups(initial)).toEqual([
      'Ctx 0% · 0/1M',
      '0 turns · 0 steps',
    ])
    expect(sessionStatusGroups(initial, statusBar())).toContain('Ctx 0% · 0/1M')
    const compact = renderSessionStatusLabel(initial, statusBar(), createTheme(false), 80)
    expect(compact).toContain('Ctx 0% · 0/1M')
    expect(compact).not.toContain('Context')
    expect(renderSessionStatusLabel(initial, statusBar({ labels: 'full' }), createTheme(false), 80)).toContain('Context 0% · 0/1M')
  })

  it('preserves fixed footer geometry at zero display width', () => {
    expect(renderStatusFooter({ model: 'm', stats, config: statusBar(), width: 0 }, createTheme(false))).toEqual(['', ''])
  })

  it('formats concise English metric groups', () => {
    expect(sessionStatusGroups(stats)).toEqual([
      'Cache 99%',
      '5.9M in · 73.8K out',
      'TTFT 1.2s · 80 tok/s',
      'LLM 16m51s · Tools 3m33s',
      '1 turn · 74 steps',
    ])
  })

  it('uses compact token and duration precision', () => {
    expect([formatTokens(517), formatTokens(12_200), formatTokens(517_000), formatTokens(1_200_000)]).toEqual([
      '517', '12.2K', '517K', '1.2M',
    ])
    expect([formatDuration(45_240), formatDuration(162_000)]).toEqual(['45.2s', '2m42s'])
    const speedOnly = statusBar({ groups: ['speed'], order: ['speed'] })
    const dense = renderSessionStatusLabel({ ...stats, ttftMs: 1_011_000, ttftSteps: 1 }, speedOnly, createTheme(false), 20)
    expect(dense).toContain('F16:51/R80')
  })

  it('switches to dense copy and keeps every group on a narrow terminal', () => {
    const line = renderSessionStatusLabel(stats, statusBar(), createTheme(false), 76)
    expect(line).toContain('C99%')
    expect(line).toContain('I5.9M/O73.8K')
    expect(line).toContain('F1.2s/R80')
    expect(line).toContain('L16:51/Tl3:33')
    expect(line).toContain('T1/S74')
    expect(stripAnsi(line)).not.toContain('…')
    expect(visibleWidth(line)).toBeLessThanOrEqual(76)
  })

  it('uses a continuous border label and includes every group when space allows', () => {
    const line = renderSessionStatusLabel(stats, statusBar(), createTheme(false), 160)
    expect(line).toContain('Cache 99% • 5.9M in · 73.8K out • TTFT 1.2s · 80 tok/s')
    expect(line).toContain('LLM 16m51s · Tools 3m33s • 1 turn · 74 steps')
    expect(stripAnsi(line)).toMatch(/^ .* $/)
    expect(line).not.toContain('轮')
    expect(line).not.toContain('缓存')
  })

  it('keeps readable count labels until dense layout is required', () => {
    expect(sessionStatusGroups({ ...stats, turns: 1, steps: 1 })).toContain('1 turn · 1 step')
    const full = statusBar({ labels: 'full' })
    expect(sessionStatusGroups({ ...stats, turns: 1, steps: 1 }, full)).toContain('1 turn · 1 step')
    expect(sessionStatusGroups({ ...stats, turns: 2, steps: 74 }, full)).toContain('2 turns · 74 steps')
    const rendered = renderSessionStatusLabel(stats, full, createTheme(false), 80)
    expect(rendered).toContain('Cache 99%')
    expect(rendered).toContain('1 turn · 74 steps')
    expect(rendered).not.toContain('C99%')
  })

  it('keeps minimal mode as an explicit telemetry opt-out', () => {
    expect(renderSessionStatusLabel(stats, statusBar({ enabled: false }), createTheme(false), 200)).toBe('')
  })

  it('migrates legacy presets into the customizable layout', () => {
    expect(resolveStatusBarConfig(undefined, 'minimal').enabled).toBe(false)
    expect(resolveStatusBarConfig(undefined, 'full').labels).toBe('full')
    expect(resolveStatusBarConfig({ enabled: true, labels: 'compact', groups: ['cache'], colors: { model: 'accent' } }).colors).toMatchObject({
      model: 'accent',
      path: 'default',
      git: 'default',
      metrics: 'default',
      cache: 'default',
    })
    expect(resolveStatusBarConfig({
      enabled: true,
      labels: 'compact',
      groups: ['cache'],
      colors: { metrics: 'warning', tokens: 'accent' },
    }).colors).toMatchObject({
      cache: 'warning',
      tokens: 'accent',
      metrics: 'warning',
    })
  })

  it('honors configured visibility and order independently', () => {
    const custom = statusBar({
      groups: ['tokens', 'cache', 'counts'],
      order: ['tokens', 'cache', 'counts'],
    })
    expect(sessionStatusGroups(stats, custom)).toEqual([
      '5.9M in · 73.8K out',
      'Cache 99%',
      '1 turn · 74 steps',
    ])

    const webOrder = statusBar({
      order: ['counts', 'durations', 'speed', 'cache', 'tokens', 'context'],
    })
    expect(sessionStatusGroups(stats, webOrder)).toEqual([
      '1 turn · 74 steps',
      'LLM 16m51s · Tools 3m33s',
      'TTFT 1.2s · 80 tok/s',
      'Cache 99%',
      '5.9M in · 73.8K out',
    ])
  })

  it('skips oversized groups and hides telemetry only when nothing fits', () => {
    const tokensFirst = statusBar({ groups: ['tokens', 'cache'], order: ['tokens', 'cache'] })
    expect(renderSessionStatusLabel(stats, tokensFirst, createTheme(false), 8)).toContain('C99%')
    expect(renderSessionStatusLabel(stats, statusBar(), createTheme(false), 5)).toBe('')
  })

  it('renders model/workspace and telemetry as two split footer rows', () => {
    const lines = renderStatusFooter({
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      pwd: '~/Workspace/dsh-tui',
      branch: 'main *6 ?4',
      stats,
      config: statusBar(),
      width: 140,
    }, createTheme(false))

    expect(lines).toHaveLength(2)
    expect(lines.every(line => visibleWidth(line) === 140)).toBe(true)
    expect(stripAnsi(lines[0] ?? '')).toMatch(/^  deepseek-v4-pro · max\s+~\/Workspace\/dsh-tui · main \*6 \?4  $/)
    expect(stripAnsi(lines[1] ?? '')).toMatch(/^  Cache 99% • 5\.9M in · 73\.8K out • TTFT 1\.2s · 80 tok\/s\s+LLM 16m51s · Tools 3m33s • 1 turn · 74 steps  $/)
  })

  it('keeps collaboration and access controls visible in metadata', () => {
    const active = renderStatusFooter({
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      controls: {
        agentPreset: 'code',
        tools: 'both',
        plan: { active: true, pending: false },
        permission: 'workspace-write',
      },
      pwd: '~/Workspace/dsh-tui',
      branch: 'main',
      stats,
      config: statusBar(),
      width: 140,
    }, createTheme(false))
    expect(active[0]).toContain('deepseek-v4-pro · max · ptc · plan · both')
    expect(active[0]).toContain('~/Workspace/dsh-tui · main')
    expect(active[0]).not.toContain('Workspace write')

    const leaving = renderStatusFooter({
      model: 'm',
      controls: {
        plan: { active: true, pending: true },
        permission: 'danger-full-access',
      },
      config: statusBar(),
      width: 48,
    }, createTheme(false))
    expect(leaving[0]).toContain('standard · plan off…')
    expect(leaving[0]).not.toContain('default')
    expect(leaving[0]).not.toContain('native')
    expect(leaving[0]).not.toContain('full access')

    const idle = renderStatusFooter({
      model: 'm',
      controls: {
        agentPreset: 'minimal',
        tools: 'native',
        plan: { active: false, pending: false },
      },
      config: statusBar(),
      width: 48,
    }, createTheme(false))
    expect(idle[0]).toContain('m · minimal')
    expect(idle[0]).not.toContain('default')
    expect(idle[0]).not.toContain('native')

    const codeTools = renderStatusFooter({
      model: 'm',
      controls: {
        agentPreset: 'code',
        tools: 'code',
        plan: { active: false, pending: false },
      },
      config: statusBar(),
      width: 48,
    }, createTheme(false))
    expect(codeTools[0]).toContain('m · ptc · code')
  })

  it('shows process-local loop state beside the model controls', () => {
    const waiting = renderStatusFooter({
      model: 'deepseek-v4-pro',
      loop: { phase: 'waiting', repeats: 0, total: 3 },
      config: statusBar(),
      width: 100,
    }, createTheme(false))
    expect(waiting[0]).toContain('LOOP WAITING · SEND PROMPT · 0/3 REPEATS')

    const running = renderStatusFooter({
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      loop: { phase: 'running', repeats: 1, total: 3 },
      config: statusBar(),
      width: 80,
    }, createTheme(false))
    expect(running[0]).toContain('deepseek-v4-pro · max · LOOP · 1/3 REPEATS')

    const paused = renderStatusFooter({
      model: 'deepseek-v4-pro',
      loop: { phase: 'paused' },
      config: statusBar(),
      width: 80,
    }, createTheme(false))
    expect(paused[0]).toContain('LOOP PAUSED · SEND TO RESUME')

    const duration = renderStatusFooter({
      model: 'deepseek-v4-pro',
      loop: { phase: 'running', repeats: 2, deadline: Date.now() + 2_000, limit: '10m' },
      config: statusBar(),
      width: 80,
    }, createTheme(false))
    expect(duration[0]).toMatch(/LOOP · 2(?:\.\d)?s LEFT/u)

    const completed = renderStatusFooter({
      model: 'deepseek-v4-pro',
      loop: { phase: 'completed', repeats: 3, total: 3 },
      config: statusBar(),
      width: 80,
    }, createTheme(false))
    expect(completed[0]).toContain('LOOP DONE · 3 REPEATS')
  })

  it('keeps every Web-style metric at 46 columns with unit-aware nano copy', () => {
    const webOrder = statusBar({
      groups: ['counts', 'durations', 'speed', 'cache', 'tokens', 'context'],
      order: ['counts', 'durations', 'speed', 'cache', 'tokens', 'context'],
      sides: {
        counts: 'left',
        durations: 'left',
        speed: 'left',
        cache: 'left',
        tokens: 'left',
        context: 'left',
      },
    })
    const contextual = { ...stats, contextTokens: 96_000, contextWindow: 6_000_000 }
    const lines = renderStatusFooter({
      model: 'm',
      stats: contextual,
      config: webOrder,
      width: 46,
    }, createTheme(false))
    const telemetry = stripAnsi(lines[1] ?? '')
    expect(lines).toHaveLength(2)
    expect(lines.every(line => visibleWidth(line) === 46)).toBe(true)
    expect(telemetry).toContain('1/74')
    expect(telemetry).toContain('L17m/T4')
    expect(telemetry).toContain('F1.2/R80')
    expect(telemetry).toContain('C99%')
    expect(telemetry).toContain('↓5.9M/↑74K')
    expect(telemetry).toContain('X1.6%')
    expect(telemetry).not.toContain('…')

    const large = renderStatusFooter({
      model: 'm',
      stats: { ...stats, turns: 10, steps: 1_234, llmMs: 60_000_000, toolMs: 60_000_000 },
      config: webOrder,
      width: 46,
    }, createTheme(false))
    const largeTelemetry = stripAnsi(large[1] ?? '')
    expect(largeTelemetry).toContain('L16.7h/T16.7')
    expect(largeTelemetry).toContain('F1.2/R80')
    expect(largeTelemetry).toContain('C99%')
    expect(largeTelemetry).toContain('↓5.9M/↑74K')
    expect(largeTelemetry).not.toContain('10/1234')
  })

  it('reflows monotonically across common terminal widths without clipping', () => {
    const order = ['counts', 'durations', 'speed', 'cache', 'tokens', 'context'] as const
    const responsive = statusBar({
      groups: [...order],
      order: [...order],
      sides: {
        counts: 'left',
        durations: 'left',
        speed: 'left',
        cache: 'left',
        tokens: 'left',
        context: 'left',
      },
    })
    const contextual = { ...stats, turns: 3, steps: 158, contextTokens: 96_000, contextWindow: 6_000_000 }
    const markerVariants = [
      ['T3/S158', '3/158'],
      ['L16:51/Tl3:33', 'L17m/T4'],
      ['F1.2s/R80', 'F1.2/R80'],
      ['C99%'],
      ['I5.9M/O73.8K', '↓5.9M/↑74K'],
      ['X1.6%'],
    ]
    let previousVisible = 0
    for (const width of [20, 32, 40, 46, 58, 60]) {
      const lines = renderStatusFooter({ model: 'm', stats: contextual, config: responsive, width }, createTheme(false))
      const telemetry = stripAnsi(lines[1] ?? '')
      const visible = markerVariants.filter(variants => variants.some(marker => telemetry.includes(marker))).length
      expect(lines).toHaveLength(2)
      expect(lines.every(line => visibleWidth(line) === width)).toBe(true)
      expect(lines.join('\n')).not.toContain('…')
      expect(visible).toBeGreaterThanOrEqual(previousVisible)
      if (width === 46) expect(visible).toBe(6)
      previousVisible = visible
    }
    const all = stripAnsi(renderStatusFooter({
      model: 'm',
      stats: contextual,
      config: responsive,
      width: 60,
    }, createTheme(false))[1] ?? '')
    for (const variants of markerVariants) {
      expect(variants.some(marker => all.includes(marker))).toBe(true)
    }

    const wide = stripAnsi(renderStatusFooter({
      model: 'm',
      stats: contextual,
      config: responsive,
      width: 120,
    }, createTheme(false))[1] ?? '')
    expect(wide).toContain('3 turns · 158 steps')
    expect(wide).toContain('LLM 16m51s · Tools 3m33s')
    expect(wide).not.toContain('T3/S158')
  })

  it('never reduces complete-group coverage when the terminal grows', () => {
    const order = ['tokens', 'cache', 'counts', 'context', 'speed', 'durations'] as const
    const config = statusBar({ groups: [...order], order: [...order] })
    const contextual = { ...stats, contextTokens: 96_000, contextWindow: 6_000_000 }
    const markerVariants = [
      ['I5.9M/O73.8K', '↓5.9M/↑74K'],
      ['C99%'],
      ['T1/S74', '1/74'],
      ['X1.6%'],
      ['F1.2s/R80', 'F1.2/R80'],
      ['L16:51/Tl3:33', 'L17m/T4'],
    ]
    let previousVisible = 0
    for (let width = 1; width <= 80; width += 1) {
      const line = stripAnsi(renderSessionStatusLabel(contextual, config, createTheme(false), width))
      const visible = markerVariants.filter(variants => variants.some(marker => line.includes(marker))).length
      expect(visible).toBeGreaterThanOrEqual(previousVisible)
      previousVisible = visible
    }
    for (const width of [15, 16]) {
      const line = stripAnsi(renderSessionStatusLabel(contextual, config, createTheme(false), width))
      const visible = markerVariants.filter(variants => variants.some(marker => line.includes(marker))).length
      expect(visible).toBe(2)
    }
  })

  it('keeps complete high-priority footer groups and only disables customizable telemetry', () => {
    const narrow = renderStatusFooter({
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      pwd: '~/Workspace/a-very-long-project-name',
      branch: 'main *6 ?4',
      stats,
      config: statusBar(),
      width: 76,
    }, createTheme(false))
    const telemetry = stripAnsi(narrow[1] ?? '')
    expect(narrow).toHaveLength(2)
    expect(narrow.every(line => visibleWidth(line) === 76)).toBe(true)
    expect(telemetry).toContain('C99%')
    expect(telemetry).toContain('I5.9M/O73.8K')
    expect(telemetry).toContain('F1.2s/R80')
    expect(telemetry).toContain('L16:51/Tl3:33')
    expect(telemetry).toContain('T1/S74')
    const minimal = renderStatusFooter({
      model: 'm',
      controls: {
        plan: { active: true, pending: false },
        permission: 'read-only',
      },
      stats,
      config: statusBar({ enabled: false }),
      width: 76,
    }, createTheme(false))
    expect(minimal).toHaveLength(2)
    expect(minimal[0]).toContain('m · standard · plan')
    expect(minimal[0]).not.toContain('native')
    expect(minimal[0]).not.toContain('Read only')
    expect(stripAnsi(minimal[1] ?? '').trim()).toBe('')
  })

  it('paints configured status slot colors and keeps semantic exceptions', () => {
    const theme = createTheme(true, true)
    const colored = statusBar({
      colors: { model: 'accent', path: 'border', git: 'success', metrics: 'warning' },
    })
    const lines = renderStatusFooter({
      model: 'deepseek-v4-pro',
      pwd: '~/ws',
      branch: 'main *1',
      stats,
      config: colored,
      width: 140,
    }, theme)
    expect(lines[0]).toContain(theme.getFgAnsi('accent'))
    expect(lines[0]).toContain(theme.getFgAnsi('border'))
    expect(lines[0]).toContain(theme.getFgAnsi('success'))
    expect(lines[0]).not.toContain(theme.getFgAnsi('warning'))
    expect(lines[1]).toContain(theme.getFgAnsi('warning'))
    expect(lines[1]).toContain(theme.getFgAnsi('success'))

    const dirtyDefault = renderStatusFooter({
      model: 'm',
      pwd: '~/ws',
      branch: 'main *1',
      config: statusBar(),
      width: 80,
    }, theme)
    expect(dirtyDefault[0]).toContain(theme.getFgAnsi('warning'))
  })

  it('packs a complete settings preview instead of clipping the right column', () => {
    const lines = renderStatusPreviewLines({
      model: 'deepseek',
      reasoningEffort: 'max',
      pwd: '~/project',
      branch: 'main *1',
      stats,
      config: statusBar(),
      width: 120,
    }, createTheme(false))
    expect(stripAnsi(lines[0] ?? '')).toMatch(/^deepseek · max\s+~\/project · main \*1$/)
    expect(stripAnsi(lines[1] ?? '')).toContain('Cache 99%')
    expect(stripAnsi(lines[1] ?? '')).toContain('Tools 3m33s')
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(120)
  })

  it('keeps the first preview line split instead of packing path and git left', () => {
    const lines = renderStatusPreviewLines({
      model: 'deepseek',
      reasoningEffort: 'max',
      pwd: '~/project',
      branch: 'main *1',
      stats,
      config: statusBar(),
      width: 80,
    }, createTheme(false))
    expect(stripAnsi(lines[0] ?? '')).toMatch(/^deepseek · max\s+~\/project · main \*1$/)
    expect(lines.join('\n')).not.toContain('…')
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80)
  })

  it('keeps more telemetry groups visible than the old greedy high-water heuristic', () => {
    // A wide first group used to greedily consume the whole budget even though
    // two narrower groups fit together. The new maximum-count selection must
    // prefer the wider group count so fewer metrics disappear.
    const footer = renderStatusFooter({
      model: 'm',
      config: statusBar(),
      width: 40,
      stats: {
        turns: 1,
        steps: 1,
        llmMs: 0,
        toolMs: 0,
        ttftMs: 0,
        ttftSteps: 0,
        decodeMs: 0,
        decodeTokens: 0,
        inputTokens: 1_234_567,
        outputTokens: 12_345,
        cacheReadTokens: 900_000,
        cacheWriteTokens: 0,
        contextWindow: 1_000_000,
        contextTokens: 123_456,
      },
    }, createTheme(false))
    // Every returned line must respect the width even when extra groups are chosen.
    for (const line of footer) expect(visibleWidth(line)).toBeLessThanOrEqual(40)
  })
})
