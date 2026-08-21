/** Progressive-disclosure levels for reasoning and tool activity in the transcript. */

export const ACTIVITY_DETAIL_MODES = ['standard', 'compact', 'minimal', 'quiet'] as const

export type ActivityDetailMode = typeof ACTIVITY_DETAIL_MODES[number]

export const ACTIVITY_DETAIL_DESCRIPTIONS: Record<ActivityDetailMode, string> = {
  standard: 'Current full reasoning, tool cards, and todo tree',
  compact: 'One-line reasoning, tools, and todo progress',
  minimal: 'Only live tools, todo progress, and errors',
  quiet: 'Assistant replies, notices, and errors only',
}

/** True when a settings or command value names a supported activity level. */
export function isActivityDetailMode(value: string): value is ActivityDetailMode {
  return ACTIVITY_DETAIL_MODES.includes(value as ActivityDetailMode)
}
