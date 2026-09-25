import { describe, expect, it } from 'vitest'
import {
  CACHE_MISS_MIN_SHARE,
  CACHE_MISS_MIN_TOKENS,
  missedCacheTokens,
  stepCacheHealth,
} from './cache-health.ts'

describe('missedCacheTokens', () => {
  it('reports a full cold prefix', () => {
    expect(missedCacheTokens({ promptTokens: 200_000, cachedTokens: 0, previousPromptTokens: 197_000 })).toBe(197_000)
  })

  it('ignores a first step that had nothing reusable before it', () => {
    expect(missedCacheTokens({ promptTokens: 200_000, cachedTokens: 0 })).toBeUndefined()
  })

  it('ignores a normal cached step', () => {
    expect(missedCacheTokens({ promptTokens: 200_500, cachedTokens: 197_000, previousPromptTokens: 197_000 })).toBeUndefined()
  })

  it('ignores a cold patch below the token floor', () => {
    expect(missedCacheTokens({ promptTokens: 30_000, cachedTokens: 20_000, previousPromptTokens: 28_000 })).toBeUndefined()
  })

  it('ignores a partial miss below the share floor', () => {
    expect(missedCacheTokens({ promptTokens: 200_000, cachedTokens: 150_000, previousPromptTokens: 200_000 })).toBeUndefined()
  })

  it('never claims more reusable tokens than the step sent', () => {
    expect(missedCacheTokens({ promptTokens: 40_000, cachedTokens: 0, previousPromptTokens: 400_000 })).toBe(40_000)
  })

  it('treats cache writes as cache coverage, not a miss', () => {
    // cachedTokens receives read + write coverage from the caller.
    expect(missedCacheTokens({ promptTokens: 120_000, cachedTokens: 118_000, previousPromptTokens: 118_000 })).toBeUndefined()
  })
})

describe('stepCacheHealth', () => {
  it('carries the figures when the cache is lost', () => {
    expect(stepCacheHealth({ promptTokens: 120_000, cachedTokens: 0, previousPromptTokens: 118_000 })).toEqual({
      promptTokens: 120_000,
      cachedTokens: 0,
      missedTokens: 118_000,
    })
  })

  it('is undefined on a healthy step', () => {
    expect(stepCacheHealth({ promptTokens: 120_000, cachedTokens: 119_000, previousPromptTokens: 118_000 })).toBeUndefined()
  })

  it('exposes stable thresholds', () => {
    expect(CACHE_MISS_MIN_TOKENS).toBe(20_000)
    expect(CACHE_MISS_MIN_SHARE).toBe(0.5)
  })
})
