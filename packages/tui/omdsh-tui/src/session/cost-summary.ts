/**
 * Token cost summary of one conversation: per-step usage and the totals that
 * answer "what did this session cost" without reading the journal by hand.
 * Money stays in the harness telemetry; this card is the token breakdown the
 * TUI can compute from the events it already has.
 * @module @agi-fans/dsh-tui
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { formatTokens } from '../chrome/status-line.ts'

/** One model step's prompt and output buckets. */
export interface CostStep {
  turn?: number | undefined
  step?: number | undefined
  /** Prompt tokens that were not served from the cache. */
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  /** Whole prompt this step sent: uncached + cache read + cache write. */
  promptTokens: number
  /** Context the step left behind: prompt + output. */
  contextTokens: number
}

/** Whole-conversation token cost. */
export interface CostSummary {
  steps: readonly CostStep[]
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  /** Largest context any step reached. */
  peakContextTokens: number
  /** Share of all prompt tokens served from the cache, when any prompt was sent. */
  cacheHitRate?: number | undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stepCost(event: SessionEvent): CostStep | undefined {
  if (event.type !== 'assistant/message') return undefined
  const data = event.data as { usage?: unknown; turn?: unknown; step?: unknown } | undefined
  const usage = data?.usage as Record<string, unknown> | undefined
  if (usage === undefined || typeof usage !== 'object') return undefined
  const uncached = num(usage.inputTokens)
  const cacheRead = num(usage.cacheReadTokens)
  const cacheWrite = num(usage.cacheWriteTokens)
  const output = num(usage.outputTokens)
  const reasoning = num(usage.reasoningTokens)
  if (uncached === undefined && cacheRead === undefined && cacheWrite === undefined && output === undefined) return undefined
  const promptTokens = (uncached ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
  const turn = num(data?.turn)
  const step = num(data?.step)
  return {
    ...(turn === undefined ? {} : { turn }),
    ...(step === undefined ? {} : { step }),
    uncachedInputTokens: uncached ?? 0,
    cacheReadTokens: cacheRead ?? 0,
    cacheWriteTokens: cacheWrite ?? 0,
    outputTokens: output ?? 0,
    reasoningTokens: reasoning ?? 0,
    promptTokens,
    contextTokens: promptTokens + (output ?? 0),
  }
}

/** Fold every model step of a conversation into per-step rows and totals. */
export function summarizeCost(events: readonly SessionEvent[]): CostSummary {
  const steps: CostStep[] = []
  for (const event of events) {
    const step = stepCost(event)
    if (step !== undefined) steps.push(step)
  }
  const sum = (pick: (step: CostStep) => number): number => steps.reduce((total, step) => total + pick(step), 0)
  const cacheReadTokens = sum(step => step.cacheReadTokens)
  const promptTokens = sum(step => step.promptTokens)
  return {
    steps,
    uncachedInputTokens: sum(step => step.uncachedInputTokens),
    cacheReadTokens,
    cacheWriteTokens: sum(step => step.cacheWriteTokens),
    outputTokens: sum(step => step.outputTokens),
    reasoningTokens: sum(step => step.reasoningTokens),
    peakContextTokens: steps.reduce((peak, step) => Math.max(peak, step.contextTokens), 0),
    ...(promptTokens === 0 ? {} : { cacheHitRate: cacheReadTokens / promptTokens }),
  }
}

/** Compact `/cost` table: one row per model step, then the session totals. */
export function formatCostSummary(summary: CostSummary): string {
  if (summary.steps.length === 0) return 'No model steps with usage in this session yet.'
  const header = ['#', 'turn', 'step', 'uncached', 'read', 'write', 'out', 'context']
  const table = summary.steps.map((step, index) => [
    String(index + 1),
    step.turn === undefined ? '·' : String(step.turn),
    step.step === undefined ? '·' : String(step.step),
    formatTokens(step.uncachedInputTokens),
    formatTokens(step.cacheReadTokens),
    formatTokens(step.cacheWriteTokens),
    formatTokens(step.outputTokens),
    formatTokens(step.contextTokens),
  ])
  const widths = header.map((cell, column) => Math.max(cell.length, ...table.map(row => (row[column] ?? '').length)))
  const line = (cells: readonly string[]): string => cells.map((cell, column) => cell.padStart(widths[column] ?? 0)).join('  ')
  const totals = [
    'total',
    `${summary.steps.length} steps`,
    '',
    formatTokens(summary.uncachedInputTokens),
    formatTokens(summary.cacheReadTokens),
    formatTokens(summary.cacheWriteTokens),
    formatTokens(summary.outputTokens),
    `${formatTokens(summary.peakContextTokens)} peak`,
  ]
  const hit = summary.cacheHitRate === undefined ? [] : [`cache hit ${Math.round(summary.cacheHitRate * 100)}% of prompt tokens`]
  return [line(header), ...table.map(row => line(row)), line(totals), ...hit].join('\n')
}
