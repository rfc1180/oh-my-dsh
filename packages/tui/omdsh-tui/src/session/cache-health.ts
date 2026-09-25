/**
 * Cache health of one assistant step: how much of the prompt the provider
 * served from its prompt cache and how much it charged again. A step that
 * re-reads a large reusable prefix at full price is the most expensive single
 * event in a session and is otherwise invisible — the totals look normal.
 * @module @agi-fans/dsh-tui
 */

/** A step must re-read at least this many tokens before it counts as a miss. */
export const CACHE_MISS_MIN_TOKENS = 20_000

/**
 * …and at least this share of the prefix that was reusable. A partial hit is a
 * cold patch, not a lost cache, so it stays quiet.
 */
export const CACHE_MISS_MIN_SHARE = 0.5

/** One step's prompt-cache outcome. */
export interface StepCacheHealth {
  /** Prompt-side tokens the step sent. */
  promptTokens: number
  /** Prompt-side tokens the provider served from its cache. */
  cachedTokens: number
  /** Reusable prefix tokens the step paid for again. */
  missedTokens: number
}

/**
 * Tokens a step charged without a cache hit, or undefined when the step either
 * had nothing reusable before it or reused enough of the prefix to be normal.
 * @param input - prompt size, cache reads, and the previous step's prompt size.
 * @returns the missed token count when the step lost its cache, else undefined.
 */
export function missedCacheTokens(input: {
  promptTokens: number
  cachedTokens: number
  previousPromptTokens?: number | undefined
}): number | undefined {
  const reusable = Math.min(Math.max(0, input.previousPromptTokens ?? 0), Math.max(0, input.promptTokens))
  if (reusable <= 0) return undefined
  const missed = Math.max(0, reusable - Math.max(0, input.cachedTokens))
  if (missed < CACHE_MISS_MIN_TOKENS) return undefined
  if (missed < reusable * CACHE_MISS_MIN_SHARE) return undefined
  return missed
}

/** Resolve one assistant step's cache health, or undefined without prompt figures. */
export function stepCacheHealth(input: {
  promptTokens: number
  cachedTokens: number
  previousPromptTokens?: number | undefined
}): StepCacheHealth | undefined {
  const missed = missedCacheTokens(input)
  if (missed === undefined) return undefined
  return { promptTokens: input.promptTokens, cachedTokens: input.cachedTokens, missedTokens: missed }
}
