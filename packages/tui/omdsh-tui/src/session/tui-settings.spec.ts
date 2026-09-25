import { describe, expect, it } from 'vitest'
import { TuiSettingsSchema } from './tui-settings.ts'
import { THEME_NAMES } from '../chrome/theme.ts'

describe('TuiSettingsSchema', () => {
  it('defaults to dark + colors and accepts light', () => {
    const validate = TuiSettingsSchema as unknown as (input: object) => {
      theme: string
      colors: boolean
      expandTools: boolean
      activityDetail: string
      statusBar?: { enabled: boolean; labels: string; groups: string[]; order?: string[] }
      statusPreset?: string
    }
    expect(validate({})).toEqual({
      theme: 'dark',
      colors: true,
      expandTools: false,
      activityDetail: 'standard',
      checkUpdates: true,
      startupChangelog: 'summary',
      compactionThreshold: '100k',
      compactionForecastSteps: '10',
      modelFavorites: {},
    })
    expect(validate({ theme: 'light', colors: false, expandTools: true })).toEqual({
      theme: 'light',
      colors: false,
      expandTools: true,
      activityDetail: 'standard',
      checkUpdates: true,
      startupChangelog: 'summary',
      compactionThreshold: '100k',
      compactionForecastSteps: '10',
      modelFavorites: {},
    })
    expect(validate({ statusBar: { enabled: false, labels: 'full', groups: ['tokens', 'cache'] } })).toMatchObject({
      statusBar: { enabled: false, labels: 'full', groups: ['tokens', 'cache'] },
    })
    expect(validate({
      statusBar: {
        enabled: true,
        labels: 'compact',
        groups: ['cache'],
        order: ['tokens', 'cache', 'context'],
        colors: { model: 'accent', metrics: 'warning' },
      },
    })).toMatchObject({
      statusBar: {
        order: ['tokens', 'cache', 'context'],
        colors: { model: 'accent', metrics: 'warning' },
      },
    })
  })

  it('accepts every catalog theme for durable settings persistence', () => {
    const validate = TuiSettingsSchema as unknown as (input: object) => { theme: string }
    for (const theme of THEME_NAMES) expect(validate({ theme }).theme).toBe(theme)
    expect(() => validate({ theme: 'missing-theme' })).toThrow()
  })

  it('validates activity detail modes and rejects unknown values', () => {
    const validate = TuiSettingsSchema as unknown as (input: object) => { activityDetail: string }
    expect(validate({ activityDetail: 'minimal' })).toMatchObject({ activityDetail: 'minimal' })
    expect(() => validate({ activityDetail: 'noisy' })).toThrow()
  })

  it('validates startup update and release-note preferences', () => {
    const validate = TuiSettingsSchema as unknown as (input: object) => {
      checkUpdates: boolean
      startupChangelog: string
    }
    expect(validate({ checkUpdates: false, startupChangelog: 'expanded' })).toMatchObject({
      checkUpdates: false,
      startupChangelog: 'expanded',
    })
  })

  it('validates compaction threshold and forecast-horizon preferences', () => {
    const validate = TuiSettingsSchema as unknown as (input: object) => {
      compactionThreshold: string
      compactionForecastSteps: string
    }
    expect(validate({ compactionThreshold: '200k', compactionForecastSteps: '20' })).toMatchObject({
      compactionThreshold: '200k',
      compactionForecastSteps: '20',
    })
    expect(validate({ compactionThreshold: 'off' }).compactionThreshold).toBe('off')
    expect(() => validate({ compactionThreshold: '100K' })).toThrow()
    expect(() => validate({ compactionForecastSteps: '7' })).toThrow()
  })

  it('keeps a legacy status preset available for runtime migration', () => {
    const validate = TuiSettingsSchema as unknown as (input: object) => { statusPreset?: string }
    expect(validate({ statusPreset: 'minimal' })).toMatchObject({ statusPreset: 'minimal' })
  })
})
