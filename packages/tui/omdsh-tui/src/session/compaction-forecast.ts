/**
 * Compaction economics: how much prompt context one summarizing compaction
 * frees, what that single summarizing turn costs, and whether the freed
 * context repays it within the steps still estimated ahead. Pure — the
 * terminal provider owns when the forecast is shown, and `/settings` owns the
 * threshold and step-horizon choices.
 * @module @agi-fans/dsh-tui
 */

import { formatTokens } from '../chrome/status-line.ts'

/**
 * Steps assumed ahead when the caller has no better estimate. Ten steps is the
 * scale of a normal task slice: long enough that a compaction repays itself,
 * short enough to stay honest for work that is nearly finished.
 */
export const DEFAULT_COMPACTION_FORECAST_STEPS = 10

/**
 * Default context size that makes omdsh offer a compaction. 100K tokens is
 * roughly a tenth of a 1M-token window and already large enough that the one
 * summarizing turn repays itself well inside the default ten-step horizon.
 */
export const DEFAULT_COMPACTION_THRESHOLD_TOKENS = 100_000

/** Threshold choices offered by `/settings`; `off` disables the offer. */
export const COMPACTION_THRESHOLD_CHOICES = ['50k', '100k', '200k', '400k', 'off'] as const
export type CompactionThresholdChoice = typeof COMPACTION_THRESHOLD_CHOICES[number]

/** Step-horizon choices offered by `/settings`. */
export const COMPACTION_STEP_CHOICES = ['5', '10', '20', '30'] as const
export type CompactionStepChoice = typeof COMPACTION_STEP_CHOICES[number]

/** Default choice values, shared by the schema and the settings overlay. */
export const DEFAULT_COMPACTION_THRESHOLD_CHOICE: CompactionThresholdChoice = '100k'
export const DEFAULT_COMPACTION_STEP_CHOICE: CompactionStepChoice = '10'

/** Share of the prompt a compaction keeps as summary plus recent tail. */
const RETAINED_CONTEXT_RATIO = 0.25
/** Smallest kept context, so a short session is not modeled as fully freed. */
const RETAINED_CONTEXT_FLOOR = 4_000
/** Share of the prompt the summarizing turn writes back as a summary. */
const SUMMARY_WRITE_RATIO = 0.05
const SUMMARY_WRITE_FLOOR = 500
const SUMMARY_WRITE_CEILING = 8_000

/** One compaction projection: what it frees, what it costs, whether it pays off. */
export interface CompactionForecast {
  /** Prompt context before the compaction. */
  contextTokens: number
  contextWindow?: number
  /** Tokens the compaction removes from every following prompt. */
  freedTokens: number
  /** Tokens the compaction keeps — summary plus recent tail. */
  retainedTokens: number
  /** Tokens the summarizing turn reads: the whole history once. */
  readTokens: number
  /** Tokens the summarizing turn writes back. */
  summaryTokens: number
  /** Whole cost of the single summarizing turn, in tokens. */
  costTokens: number
  /** Steps still estimated ahead when the forecast was taken. */
  stepsRemaining: number
  /** Freed context over the remaining steps minus the summarizing turn. */
  netTokens: number
  /** Steps needed before the freed context repays the summarizing turn. */
  breakEvenSteps: number
  verdict: 'pays-off' | 'not-worth-it'
}

/** True when a value is one of the {@link COMPACTION_THRESHOLD_CHOICES}. */
export function isCompactionThreshold(value: unknown): value is CompactionThresholdChoice {
  return COMPACTION_THRESHOLD_CHOICES.includes(value as CompactionThresholdChoice)
}

/** True when a value is one of the {@link COMPACTION_STEP_CHOICES}. */
export function isCompactionStep(value: unknown): value is CompactionStepChoice {
  return COMPACTION_STEP_CHOICES.includes(value as CompactionStepChoice)
}

/** Resolve a persisted threshold choice to tokens, or undefined when it is off. */
export function compactionThresholdTokens(choice: string | undefined): number | undefined {
  if (choice === undefined) return DEFAULT_COMPACTION_THRESHOLD_TOKENS
  if (choice === 'off') return undefined
  const match = /^(\d+)k$/u.exec(choice.trim())
  if (match === null) return DEFAULT_COMPACTION_THRESHOLD_TOKENS
  return Number(match[1]) * 1_000
}

/** Resolve a persisted step-horizon choice to a positive step count. */
export function compactionForecastSteps(choice: string | undefined): number {
  const parsed = Number.parseInt(choice ?? '', 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_COMPACTION_FORECAST_STEPS
}

/** True when the context has grown past the configured offer threshold. */
export function shouldOfferCompaction(contextTokens: number | undefined, thresholdTokens: number | undefined): boolean {
  if (contextTokens === undefined || thresholdTokens === undefined) return false
  return contextTokens >= thresholdTokens
}

/** Estimate what one summarizing compaction frees and what it costs. */
export function forecastCompaction(input: {
  contextTokens: number
  contextWindow?: number | undefined
  stepsRemaining?: number | undefined
}): CompactionForecast | undefined {
  if (!Number.isFinite(input.contextTokens) || input.contextTokens <= 0) return undefined
  const contextTokens = Math.round(input.contextTokens)
  const stepsRemaining = Number.isSafeInteger(input.stepsRemaining) && (input.stepsRemaining ?? 0) > 0
    ? input.stepsRemaining as number
    : DEFAULT_COMPACTION_FORECAST_STEPS
  const retainedTokens = Math.min(
    contextTokens,
    Math.max(RETAINED_CONTEXT_FLOOR, Math.round(contextTokens * RETAINED_CONTEXT_RATIO)),
  )
  const freedTokens = contextTokens - retainedTokens
  const readTokens = contextTokens
  const summaryTokens = Math.min(
    SUMMARY_WRITE_CEILING,
    Math.max(SUMMARY_WRITE_FLOOR, Math.round(contextTokens * SUMMARY_WRITE_RATIO)),
  )
  const costTokens = readTokens + summaryTokens
  const netTokens = freedTokens * stepsRemaining - costTokens
  return {
    contextTokens,
    ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
    freedTokens,
    retainedTokens,
    readTokens,
    summaryTokens,
    costTokens,
    stepsRemaining,
    netTokens,
    breakEvenSteps: freedTokens === 0 ? Number.POSITIVE_INFINITY : Math.ceil(costTokens / freedTokens),
    verdict: netTokens > 0 ? 'pays-off' : 'not-worth-it',
  }
}

function signedTokens(value: number): string {
  return (value < 0 ? '-' : '+') + formatTokens(Math.abs(value))
}

function verdictText(forecast: CompactionForecast): string {
  const steps = `${forecast.stepsRemaining} step${forecast.stepsRemaining === 1 ? '' : 's'}`
  return forecast.verdict === 'pays-off'
    ? `pays off after ${forecast.breakEvenSteps} step${forecast.breakEvenSteps === 1 ? '' : 's'} (${signedTokens(forecast.netTokens)} over ${steps})`
    : `not worth it (${signedTokens(forecast.netTokens)} over ${steps})`
}

/** `Compaction: frees 148K of 197K · costs ~205K for 1 turn · pays off after 2 steps (+1.3M over 10 steps)` */
export function formatCompactionForecast(forecast: CompactionForecast): string {
  return `Compaction: frees ${formatTokens(forecast.freedTokens)} of ${formatTokens(forecast.contextTokens)}`
    + ` · costs ~${formatTokens(forecast.costTokens)} for 1 turn · ${verdictText(forecast)}`
}

/** `Context 128K ≥ 100K · /compact frees 96K for ~134K · pays off after 2 steps (+826K over 10 steps)` */
export function formatCompactionOffer(forecast: CompactionForecast, thresholdTokens: number): string {
  return `Context ${formatTokens(forecast.contextTokens)} ≥ ${formatTokens(thresholdTokens)}`
    + ` · /compact frees ${formatTokens(forecast.freedTokens)} for ~${formatTokens(forecast.costTokens)}`
    + ` · ${verdictText(forecast)}`
}
