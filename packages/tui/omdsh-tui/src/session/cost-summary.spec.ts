import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { formatCostSummary, summarizeCost } from './cost-summary.ts'

const event = (type: string, data: unknown): SessionEvent => ({ type, seq: 0, time: 0, data }) as SessionEvent

describe('summarizeCost', () => {
  it('folds per-step usage into rows and totals', () => {
    const summary = summarizeCost([
      event('assistant/message', { turn: 1, step: 1, usage: { inputTokens: 1_000, cacheReadTokens: 20_000, cacheWriteTokens: 2_000, outputTokens: 500, reasoningTokens: 100 } }),
      event('assistant/message', { turn: 1, step: 2, usage: { inputTokens: 200, cacheReadTokens: 23_000, outputTokens: 400 } }),
      event('user/message', { content: [] }),
      event('assistant/message', { turn: 1, step: 3, message: { content: [] } }),
    ])
    expect(summary.steps).toHaveLength(2)
    expect(summary.uncachedInputTokens).toBe(1_200)
    expect(summary.cacheReadTokens).toBe(43_000)
    expect(summary.cacheWriteTokens).toBe(2_000)
    expect(summary.outputTokens).toBe(900)
    expect(summary.reasoningTokens).toBe(100)
    expect(summary.peakContextTokens).toBe(23_600)
    expect(summary.cacheHitRate).toBeCloseTo(43_000 / 46_200, 6)
  })

  it('returns empty totals without any usage', () => {
    const summary = summarizeCost([event('user/message', { content: [] })])
    expect(summary.steps).toEqual([])
    expect(summary.peakContextTokens).toBe(0)
    expect(summary.cacheHitRate).toBeUndefined()
  })
})

describe('formatCostSummary', () => {
  it('renders a table with totals and the cache-hit share', () => {
    const text = formatCostSummary(summarizeCost([
      event('assistant/message', { turn: 1, step: 1, usage: { inputTokens: 1_000, cacheReadTokens: 20_000, outputTokens: 500 } }),
    ]))
    expect(text).toContain('uncached')
    expect(text).toContain('20K')
    expect(text).toContain('1 steps')
    expect(text).toContain('cache hit 95% of prompt tokens')
  })

  it('explains an empty session instead of printing a header', () => {
    expect(formatCostSummary(summarizeCost([]))).toBe('No model steps with usage in this session yet.')
  })
})
