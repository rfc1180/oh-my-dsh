/**
 * Durable TUI appearance and status-line preferences on the user-settings seam.
 * @module @agi-fans/dsh-tui
 */

import z from '@deepseek-ai/schemastery'
import { ACTIVITY_DETAIL_MODES, type ActivityDetailMode } from './activity-detail.ts'
import {
  COMPACTION_STEP_CHOICES,
  COMPACTION_THRESHOLD_CHOICES,
  DEFAULT_COMPACTION_STEP_CHOICE,
  DEFAULT_COMPACTION_THRESHOLD_CHOICE,
  type CompactionStepChoice,
  type CompactionThresholdChoice,
} from './compaction-forecast.ts'
import { STARTUP_CHANGELOG_MODES, type StartupChangelogMode } from './release-notes.ts'
import {
  STATUS_COLOR_TOKENS,
  STATUS_GROUP_IDS,
  STATUS_ITEM_IDS,
  STATUS_META_IDS,
  STATUS_SIDES,
  STATUS_LABEL_STYLES,
  STATUS_PRESETS,
  type StatusBarConfig,
  type StatusPreset,
} from '../chrome/status-config.ts'
import { THEME_NAMES, type ThemeName } from '../chrome/theme.ts'

/** Settings namespace owned by the local TUI provider. */
export const TUI_SETTINGS_NAMESPACE = 'omdsh-tui'

/**
 * Model ids listed ahead of the rest of the catalog, keyed by provider route.
 * The picker still offers the whole catalog to the search field; this only
 * decides which models the default (unfiltered) view shows first.
 */
export type ModelFavorites = Record<string, string[]>

/** Drop blank ids and blank providers from a configured favorites map. */
export function normalizeModelFavorites(value: ModelFavorites | undefined): ModelFavorites {
  const normalized: ModelFavorites = {}
  for (const [provider, ids] of Object.entries(value ?? {})) {
    const route = provider.trim()
    if (route === '') continue
    const seen = new Set<string>()
    const kept: string[] = []
    for (const id of ids) {
      const model = id.trim()
      if (model === '' || seen.has(model)) continue
      seen.add(model)
      kept.push(model)
    }
    if (kept.length > 0) normalized[route] = kept
  }
  return normalized
}

/** Durable TUI section stored in the user settings document. */
export interface TuiSettings {
  theme: ThemeName
  colors: boolean
  expandTools: boolean
  activityDetail: ActivityDetailMode
  checkUpdates: boolean
  startupChangelog: StartupChangelogMode
  /** Offer a compaction once the prompt context crosses this token size. */
  compactionThreshold: CompactionThresholdChoice
  /** Steps assumed still ahead when the compaction forecast is computed. */
  compactionForecastSteps: CompactionStepChoice
  statusBar?: StatusBarConfig
  /** Legacy input retained so older settings documents can be migrated. */
  statusPreset?: StatusPreset
  /** Per-provider model ids the picker lists before the rest of the catalog. */
  modelFavorites?: ModelFavorites
}

/** Schema: palette, SGR, activity disclosure, tool expansion, and status-line detail. */
export const TuiSettingsSchema: z<TuiSettings> = z.object({
  theme: z.union([...THEME_NAMES]).default('dark'),
  colors: z.boolean().default(true),
  expandTools: z.boolean().default(false),
  activityDetail: z.union([...ACTIVITY_DETAIL_MODES]).default('standard'),
  checkUpdates: z.boolean().default(true),
  startupChangelog: z.union([...STARTUP_CHANGELOG_MODES]).default('summary'),
  compactionThreshold: z.union([...COMPACTION_THRESHOLD_CHOICES]).default(DEFAULT_COMPACTION_THRESHOLD_CHOICE),
  compactionForecastSteps: z.union([...COMPACTION_STEP_CHOICES]).default(DEFAULT_COMPACTION_STEP_CHOICE),
  statusBar: z.union([z.object({
    enabled: z.boolean().default(true),
    labels: z.union([...STATUS_LABEL_STYLES]).default('compact'),
    groups: z.array(z.union([...STATUS_GROUP_IDS])).default([...STATUS_GROUP_IDS]),
    order: z.array(z.union([...STATUS_GROUP_IDS])),
    meta: z.array(z.union([...STATUS_META_IDS])),
    metaOrder: z.array(z.union([...STATUS_META_IDS])),
    colors: z.object({
      model: z.union([...STATUS_COLOR_TOKENS]),
      effort: z.union([...STATUS_COLOR_TOKENS]),
      path: z.union([...STATUS_COLOR_TOKENS]),
      git: z.union([...STATUS_COLOR_TOKENS]),
      metrics: z.union([...STATUS_COLOR_TOKENS]),
      context: z.union([...STATUS_COLOR_TOKENS]),
      cache: z.union([...STATUS_COLOR_TOKENS]),
      tokens: z.union([...STATUS_COLOR_TOKENS]),
      speed: z.union([...STATUS_COLOR_TOKENS]),
      durations: z.union([...STATUS_COLOR_TOKENS]),
      counts: z.union([...STATUS_COLOR_TOKENS]),
    }),
    sides: z.object(Object.fromEntries(STATUS_ITEM_IDS.map(id => [id, z.union([...STATUS_SIDES])]))),
  })]),
  statusPreset: z.union([...STATUS_PRESETS]),
  modelFavorites: z.dict(z.array(z.string())),
})
