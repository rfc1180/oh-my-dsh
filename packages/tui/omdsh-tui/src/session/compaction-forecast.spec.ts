import { describe, expect, it } from 'vitest'
import {
  COMPACTION_STEP_CHOICES,
  COMPACTION_THRESHOLD_CHOICES,
  DEFAULT_COMPACTION_FORECAST_STEPS,
  compactionForecastSteps,
  compactionThresholdTokens,
  forecastCompaction,
  formatCompactionForecast,
  formatCompactionOffer,
  isCompactionStep,
  isCompactionThreshold,
  shouldOfferCompaction,
} from './compaction-forecast.ts'

describe('forecastCompaction', () => {
  it('pays off when the freed context repays the summarizing turn', () => {
    const forecast = forecastCompaction({ contextTokens: 197_000, stepsRemaining: 10 })
    expect(forecast).toMatchObject({
      contextTokens: 197_000,
      retainedTokens: 49_250,
      freedTokens: 147_750,
      readTokens: 197_000,
      summaryTokens: 8_000,
      costTokens: 205_000,
      stepsRemaining: 10,
      netTokens: 1_272_500,
      breakEvenSteps: 2,
      verdict: 'pays-off',
    })
  })

  it('does not pay off when too few steps remain to repay the turn', () => {
    const forecast = forecastCompaction({ contextTokens: 120_000, stepsRemaining: 1 })
    expect(forecast).toMatchObject({
      freedTokens: 90_000,
      costTokens: 126_000,
      netTokens: -36_000,
      breakEvenSteps: 2,
      verdict: 'not-worth-it',
    })
  })

  it('flips at the break-even step and keeps the same context window', () => {
    const below = forecastCompaction({ contextTokens: 200_000, stepsRemaining: 1 })
    const at = forecastCompaction({ contextTokens: 200_000, stepsRemaining: 2 })
    expect(below?.breakEvenSteps).toBe(2)
    expect(below?.verdict).toBe('not-worth-it')
    expect(at?.verdict).toBe('pays-off')
    expect(forecastCompaction({ contextTokens: 200_000, contextWindow: 1_000_000 })?.contextWindow).toBe(1_000_000)
  })

  it('keeps the whole prompt when nothing could be shadowed and defaults the horizon', () => {
    const tiny = forecastCompaction({ contextTokens: 2_000 })
    expect(tiny).toMatchObject({ freedTokens: 0, breakEvenSteps: Number.POSITIVE_INFINITY, verdict: 'not-worth-it' })
    expect(tiny?.stepsRemaining).toBe(DEFAULT_COMPACTION_FORECAST_STEPS)
    expect(forecastCompaction({ contextTokens: 0 })).toBeUndefined()
    expect(forecastCompaction({ contextTokens: Number.NaN })).toBeUndefined()
  })
})

describe('compaction threshold policy', () => {
  it('resolves persisted threshold choices and defaults', () => {
    expect(compactionThresholdTokens('100k')).toBe(100_000)
    expect(compactionThresholdTokens('50k')).toBe(50_000)
    expect(compactionThresholdTokens('off')).toBeUndefined()
    expect(compactionThresholdTokens(undefined)).toBe(100_000)
    expect(compactionThresholdTokens('nonsense')).toBe(100_000)
  })

  it('offers only at or above the threshold and never without one', () => {
    expect(shouldOfferCompaction(100_000, 100_000)).toBe(true)
    expect(shouldOfferCompaction(99_999, 100_000)).toBe(false)
    expect(shouldOfferCompaction(400_000, undefined)).toBe(false)
    expect(shouldOfferCompaction(undefined, 100_000)).toBe(false)
  })

  it('resolves persisted step horizons', () => {
    expect(compactionForecastSteps('10')).toBe(10)
    expect(compactionForecastSteps('30')).toBe(30)
    expect(compactionForecastSteps('0')).toBe(10)
    expect(compactionForecastSteps(undefined)).toBe(10)
  })

  it('guards the choices the settings overlay may persist', () => {
    for (const choice of COMPACTION_THRESHOLD_CHOICES) expect(isCompactionThreshold(choice)).toBe(true)
    for (const choice of COMPACTION_STEP_CHOICES) expect(isCompactionStep(choice)).toBe(true)
    expect(isCompactionThreshold('100K')).toBe(false)
    expect(isCompactionStep(15)).toBe(false)
  })
})

function forecastOf(contextTokens: number, stepsRemaining: number) {
  const forecast = forecastCompaction({ contextTokens, stepsRemaining })
  if (forecast === undefined) throw new Error('expected a forecast for a positive context')
  return forecast
}

describe('compaction forecast copy', () => {
  it('states the freed context, the one-turn cost, and the verdict', () => {
    expect(formatCompactionForecast(forecastOf(197_000, 10)))
      .toBe('Compaction: frees 148K of 197K · costs ~205K for 1 turn · pays off after 2 steps (+1.3M over 10 steps)')
  })

  it('states a negative verdict without a leading plus', () => {
    expect(formatCompactionForecast(forecastOf(120_000, 1)))
      .toBe('Compaction: frees 90K of 120K · costs ~126K for 1 turn · not worth it (-36K over 1 step)')
  })

  it('frames the automatic offer around the crossed threshold', () => {
    expect(formatCompactionOffer(forecastOf(128_000, 10), 100_000))
      .toBe('Context 128K ≥ 100K · /compact frees 96K for ~134K · pays off after 2 steps (+826K over 10 steps)')
  })
})
