/**
 * Independent omdsh semantic theme catalog. Palettes share renderer roles,
 * rounded box chrome, status glyphs, and capability-aware ANSI output.
 * @module @agi-fans/dsh-tui
 */

/** Rounded-box drawing characters (OMP unicode preset). */
export const BOX = {
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  horizontal: '─',
  vertical: '│',
  teeUp: '┴',
  teeDown: '┬',
  teeLeft: '┤',
  teeRight: '├',
  cross: '┼',
} as const

/** Status / list glyphs: monochrome Unicode, never emoji-presentation. */
export const SYMBOL = {
  success: '✔',
  error: '✘',
  warning: '▲',
  info: 'ⓘ',
  pending: '○',
  running: '⟳',
  done: '•',
  bullet: '•',
  cursor: '❯',
} as const

/** Braille activity spinner (OMP unicode activity frames). */
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/** Complete set of semantic colors consumed by the TUI. */
export const THEME_COLOR_NAMES = [
  'accent', 'border', 'borderAccent', 'borderMuted',
  'success', 'error', 'warning', 'muted', 'dim', 'text',
  'selectionText', 'selectionBg',
  'userMessageText', 'userMessageBg',
  'toolPendingBg', 'toolSuccessBg', 'toolErrorBg', 'toolTitle', 'toolOutput',
  'toolDiffAdded', 'toolDiffRemoved', 'toolDiffContext',
  'mdHeading', 'mdLink', 'mdLinkUrl', 'mdCode', 'mdCodeBlock', 'mdCodeBlockBorder',
  'mdKeyword', 'mdQuote', 'mdListBullet', 'thinkingText', 'customMessageLabel',
] as const

/** Semantic color addressed by a real renderer. */
export type ThemeColor = (typeof THEME_COLOR_NAMES)[number]

/** Resolved palette entry: hex, empty (default fg/bg), or a 256-color index. */
type Swatch = string | number

/** OMP `dark.json` palette. */
const DARK_PALETTE: Record<ThemeColor, Swatch> = {
  accent: '#febc38',
  border: '#178fb9',
  borderAccent: '#0088fa',
  borderMuted: '#3d424a',
  success: '#89d281',
  error: '#fc3a4b',
  warning: '#e4c00f',
  muted: '#777d88',
  dim: '#5f6673',
  text: '',
  selectionText: '#ffffff',
  selectionBg: '#005f87',
  userMessageText: '',
  userMessageBg: '#221d1a',
  toolPendingBg: '#1d2129',
  toolSuccessBg: '#161a1f',
  toolErrorBg: '#291d1d',
  toolTitle: '',
  toolOutput: '#777d88',
  toolDiffAdded: '#89d281',
  toolDiffRemoved: '#fc3a4b',
  toolDiffContext: '#5f6673',
  mdHeading: '#febc38',
  mdLink: '#0088fa',
  mdLinkUrl: '#5f6673',
  mdCode: '#8a9099',
  mdCodeBlock: '#9cdcfe',
  mdCodeBlockBorder: '#3d424a',
  mdKeyword: '#569cd6',
  mdQuote: '#777d88',
  mdListBullet: '#febc38',
  thinkingText: '#6b7280',
  customMessageLabel: '#b281d6',
}

/** OMP `light.json` palette. */
const LIGHT_PALETTE: Record<ThemeColor, Swatch> = {
  accent: '#5a8080',
  border: '#547da7',
  borderAccent: '#5a8080',
  borderMuted: '#b0b0b0',
  success: '#588458',
  error: '#aa5555',
  warning: '#9a7326',
  muted: '#6c6c6c',
  dim: '#767676',
  text: '',
  selectionText: '#101418',
  selectionBg: '#c7d9df',
  userMessageText: '',
  userMessageBg: '#e8e8e8',
  toolPendingBg: '#e8e8f0',
  toolSuccessBg: '#e8f0e8',
  toolErrorBg: '#f0e8e8',
  toolTitle: '',
  toolOutput: '#6c6c6c',
  toolDiffAdded: '#588458',
  toolDiffRemoved: '#aa5555',
  toolDiffContext: '#767676',
  mdHeading: '#9a7326',
  mdLink: '#547da7',
  mdLinkUrl: '#767676',
  mdCode: '#5a8080',
  mdCodeBlock: '#5a8080',
  mdCodeBlockBorder: '#6c6c6c',
  mdKeyword: '#0451a5',
  mdQuote: '#6c6c6c',
  mdListBullet: '#588458',
  thinkingText: '#6c6c6c',
  customMessageLabel: '#7e57c2',
}

const MIDNIGHT_PALETTE: Record<ThemeColor, Swatch> = {
  ...DARK_PALETTE,
  accent: '#7aa2f7',
  border: '#3d59a1',
  borderAccent: '#7dcfff',
  borderMuted: '#3d424a',
  success: '#9ece6a',
  error: '#f7768e',
  warning: '#e0af68',
  muted: '#777d88',
  dim: '#5f6673',
  text: '',
  selectionText: '#ffffff',
  selectionBg: '#005f87',
  userMessageBg: '#1a1b26',
  toolPendingBg: '#16161e',
  toolSuccessBg: '#1b2430',
  toolErrorBg: '#2a1b26',
  toolOutput: '#777d88',
  toolDiffAdded: '#9ece6a',
  toolDiffRemoved: '#f7768e',
  toolDiffContext: '#5f6673',
  mdHeading: '#bb9af7',
  mdLink: '#7dcfff',
  mdLinkUrl: '#5f6673',
  mdCode: '#7f8799',
  mdCodeBlock: '#9aa5ce',
  mdCodeBlockBorder: '#3d424a',
  mdKeyword: '#bb9af7',
  mdQuote: '#777d88',
  mdListBullet: '#7aa2f7',
  thinkingText: '#6a7394',
  customMessageLabel: '#bb9af7',
}

const SOLARIZED_PALETTE: Record<ThemeColor, Swatch> = {
  ...DARK_PALETTE,
  accent: '#b58900',
  border: '#268bd2',
  borderAccent: '#2aa198',
  borderMuted: '#586e75',
  success: '#859900',
  error: '#dc322f',
  warning: '#cb4b16',
  muted: '#839496',
  dim: '#586e75',
  text: '',
  selectionText: '#ffffff',
  selectionBg: '#005f87',
  userMessageBg: '#073642',
  toolPendingBg: '#002b36',
  toolSuccessBg: '#073642',
  toolErrorBg: '#3b2020',
  toolOutput: '#839496',
  toolDiffAdded: '#859900',
  toolDiffRemoved: '#dc322f',
  toolDiffContext: '#586e75',
  mdHeading: '#b58900',
  mdLink: '#268bd2',
  mdLinkUrl: '#586e75',
  mdCode: '#93a1a1',
  mdCodeBlock: '#2aa198',
  mdCodeBlockBorder: '#073642',
  mdKeyword: '#859900',
  mdQuote: '#839496',
  mdListBullet: '#b58900',
  thinkingText: '#586e75',
  customMessageLabel: '#6c71c4',
}

const CATPPUCCIN_PALETTE: Record<ThemeColor, Swatch> = {
  ...DARK_PALETTE,
  accent: '#fab387',
  border: '#89b4fa',
  borderAccent: '#b4befe',
  borderMuted: '#313244',
  success: '#a6e3a1',
  error: '#f38ba8',
  warning: '#f9e2af',
  muted: '#7f849c',
  dim: '#6c7086',
  text: '',
  selectionText: '#ffffff',
  selectionBg: '#005f87',
  userMessageBg: '#181825',
  toolPendingBg: '#313244',
  toolSuccessBg: '#181825',
  toolErrorBg: '#11111b',
  toolTitle: '#b4befe',
  toolOutput: '#7f849c',
  toolDiffAdded: '#a6e3a1',
  toolDiffRemoved: '#f38ba8',
  toolDiffContext: '#7f849c',
  mdHeading: '#fab387',
  mdLink: '#89b4fa',
  mdLinkUrl: '#6c7086',
  mdCode: '#a6adc8',
  mdCodeBlock: '#cdd6f4',
  mdCodeBlockBorder: '#313244',
  mdKeyword: '#cba6f7',
  mdQuote: '#7f849c',
  mdListBullet: '#fab387',
  thinkingText: '#6c7086',
  customMessageLabel: '#cba6f7',
}

const DRACULA_PALETTE: Record<ThemeColor, Swatch> = {
  ...DARK_PALETTE,
  accent: '#bd93f9',
  border: '#bd93f9',
  borderAccent: '#ff79c6',
  borderMuted: '#44475a',
  success: '#50fa7b',
  error: '#ff5555',
  warning: '#f1fa8c',
  muted: '#6272a4',
  dim: '#44475a',
  text: '',
  selectionText: '#ffffff',
  selectionBg: '#005f87',
  userMessageBg: '#1f2029',
  toolPendingBg: '#21222c',
  toolSuccessBg: '#1a1f1e',
  toolErrorBg: '#2a2028',
  toolTitle: '#8be9fd',
  toolOutput: '#6272a4',
  toolDiffAdded: '#50fa7b',
  toolDiffRemoved: '#ff5555',
  toolDiffContext: '#6272a4',
  mdHeading: '#bd93f9',
  mdLink: '#8be9fd',
  mdLinkUrl: '#6272a4',
  mdCode: '#9aa3c7',
  mdCodeBlock: '#f8f8f2',
  mdCodeBlockBorder: '#44475a',
  mdKeyword: '#ff79c6',
  mdQuote: '#6272a4',
  mdListBullet: '#ff79c6',
  thinkingText: '#6272a4',
  customMessageLabel: '#bd93f9',
}

const NORD_PALETTE: Record<ThemeColor, Swatch> = {
  ...DARK_PALETTE,
  accent: '#88c0d0',
  border: '#5e81ac',
  borderAccent: '#88c0d0',
  borderMuted: '#434c5e',
  success: '#a3be8c',
  error: '#bf616a',
  warning: '#ebcb8b',
  muted: '#7b88a1',
  dim: '#4c566a',
  text: '',
  selectionText: '#ffffff',
  selectionBg: '#005f87',
  userMessageBg: '#3b4252',
  toolPendingBg: '#3b4252',
  toolSuccessBg: '#2e3440',
  toolErrorBg: '#3b2f31',
  toolTitle: '#88c0d0',
  toolOutput: '#7b88a1',
  toolDiffAdded: '#a3be8c',
  toolDiffRemoved: '#bf616a',
  toolDiffContext: '#7b88a1',
  mdHeading: '#88c0d0',
  mdLink: '#88c0d0',
  mdLinkUrl: '#4c566a',
  mdCode: '#81a1c1',
  mdCodeBlock: '#d8dee9',
  mdCodeBlockBorder: '#434c5e',
  mdKeyword: '#81a1c1',
  mdQuote: '#7b88a1',
  mdListBullet: '#81a1c1',
  thinkingText: '#6b768d',
  customMessageLabel: '#b48ead',
}

const GRUVBOX_PALETTE: Record<ThemeColor, Swatch> = {
  ...DARK_PALETTE,
  accent: '#fe8019',
  border: '#458588',
  borderAccent: '#8ec07c',
  borderMuted: '#504945',
  success: '#b8bb26',
  error: '#fb4934',
  warning: '#fabd2f',
  muted: '#928374',
  dim: '#7c6f64',
  text: '',
  selectionText: '#ffffff',
  selectionBg: '#005f87',
  userMessageBg: '#1d2021',
  toolPendingBg: '#32302f',
  toolSuccessBg: '#1d2021',
  toolErrorBg: '#3c2021',
  toolTitle: '#ebdbb2',
  toolOutput: '#928374',
  toolDiffAdded: '#b8bb26',
  toolDiffRemoved: '#fb4934',
  toolDiffContext: '#928374',
  mdHeading: '#fabd2f',
  mdLink: '#8ec07c',
  mdLinkUrl: '#7c6f64',
  mdCode: '#bdae93',
  mdCodeBlock: '#ebdbb2',
  mdCodeBlockBorder: '#504945',
  mdKeyword: '#d3869b',
  mdQuote: '#928374',
  mdListBullet: '#fe8019',
  thinkingText: '#7c6f64',
  customMessageLabel: '#d3869b',
}

const ROSE_PINE_PALETTE: Record<ThemeColor, Swatch> = {
  ...DARK_PALETTE,
  accent: '#c4a7e7',
  border: '#31748f',
  borderAccent: '#9ccfd8',
  borderMuted: '#403d52',
  success: '#9ccfd8',
  error: '#eb6f92',
  warning: '#f6c177',
  muted: '#6e6a86',
  dim: '#524f67',
  text: '',
  selectionText: '#ffffff',
  selectionBg: '#005f87',
  userMessageBg: '#21202e',
  toolPendingBg: '#1f1d2e',
  toolSuccessBg: '#21202e',
  toolErrorBg: '#2d1f26',
  toolTitle: '#9ccfd8',
  toolOutput: '#6e6a86',
  toolDiffAdded: '#9ccfd8',
  toolDiffRemoved: '#eb6f92',
  toolDiffContext: '#6e6a86',
  mdHeading: '#c4a7e7',
  mdLink: '#9ccfd8',
  mdLinkUrl: '#908caa',
  mdCode: '#a8a4c4',
  mdCodeBlock: '#e0def4',
  mdCodeBlockBorder: '#403d52',
  mdKeyword: '#31748f',
  mdQuote: '#6e6a86',
  mdListBullet: '#c4a7e7',
  thinkingText: '#6e6a86',
  customMessageLabel: '#c4a7e7',
}

const MONO_PALETTE: Record<ThemeColor, Swatch> = {
  accent: '#e8e8e8',
  border: '#888888',
  borderAccent: '#b8b8b8',
  borderMuted: '#444444',
  success: '#c0c0c0',
  error: '#f0f0f0',
  warning: '#a8a8a8',
  muted: '#888888',
  dim: '#666666',
  text: '',
  selectionText: '#ffffff',
  selectionBg: '#005f87',
  userMessageText: '',
  userMessageBg: '#202020',
  toolPendingBg: '#242424',
  toolSuccessBg: '#1c1c1c',
  toolErrorBg: '#2a2a2a',
  toolTitle: '',
  toolOutput: '#888888',
  toolDiffAdded: '#c0c0c0',
  toolDiffRemoved: '#f0f0f0',
  toolDiffContext: '#666666',
  mdHeading: '#e8e8e8',
  mdLink: '#b8b8b8',
  mdLinkUrl: '#666666',
  mdCode: '#a0a0a0',
  mdCodeBlock: '#c0c0c0',
  mdCodeBlockBorder: '#444444',
  mdKeyword: '#b8b8b8',
  mdQuote: '#888888',
  mdListBullet: '#b8b8b8',
  thinkingText: '#767676',
  customMessageLabel: '#a8a8a8',
}

type SemanticSeed = {
  bg: string
  surface: string
  elevated: string
  foreground: string
  muted: string
  dim: string
  accent: string
  border: string
  success: string
  error: string
  warning: string
  secondary: string
  selectionBg: string
  selectionText: string
}

function mixHex(base: string, tint: string, weight: number): string {
  const channel = (hex: string, offset: number): number => Number.parseInt(hex.slice(offset, offset + 2), 16)
  const mixed = [1, 3, 5].map(offset => Math.round(
    channel(base, offset) * (1 - weight) + channel(tint, offset) * weight,
  ))
  return '#' + mixed.map(value => value.toString(16).padStart(2, '0')).join('')
}

function semanticPalette(seed: SemanticSeed): Record<ThemeColor, Swatch> {
  return {
    accent: seed.accent,
    border: seed.border,
    borderAccent: seed.accent,
    borderMuted: seed.dim,
    success: seed.success,
    error: seed.error,
    warning: seed.warning,
    muted: seed.muted,
    dim: seed.dim,
    text: seed.foreground,
    selectionText: seed.selectionText,
    selectionBg: seed.selectionBg,
    userMessageText: seed.foreground,
    userMessageBg: seed.surface,
    toolPendingBg: seed.elevated,
    toolSuccessBg: mixHex(seed.surface, seed.success, 0.1),
    toolErrorBg: mixHex(seed.surface, seed.error, 0.1),
    toolTitle: seed.foreground,
    toolOutput: seed.muted,
    toolDiffAdded: seed.success,
    toolDiffRemoved: seed.error,
    toolDiffContext: seed.muted,
    mdHeading: seed.accent,
    mdLink: seed.border,
    mdLinkUrl: seed.dim,
    mdCode: seed.secondary,
    mdCodeBlock: seed.foreground,
    mdCodeBlockBorder: seed.dim,
    mdKeyword: seed.secondary,
    mdQuote: seed.muted,
    mdListBullet: seed.accent,
    thinkingText: seed.dim,
    customMessageLabel: seed.secondary,
  }
}

const NEW_THEME_SEEDS = {
  arctic: { bg: '#f4f9fb', surface: '#e8f2f5', elevated: '#deedf2', foreground: '#172b35', muted: '#405d69', dim: '#627984', accent: '#006d8f', border: '#347d95', success: '#28754e', error: '#a73542', warning: '#8a5a00', secondary: '#6550a0', selectionBg: '#006d8f', selectionText: '#ffffff' },
  paper: { bg: '#faf9f5', surface: '#f0eee7', elevated: '#e8e5dc', foreground: '#292824', muted: '#5d5a51', dim: '#777268', accent: '#8a4f19', border: '#576f7e', success: '#3e713f', error: '#a33b36', warning: '#806000', secondary: '#6f4f8f', selectionBg: '#76502d', selectionText: '#ffffff' },
  ivory: { bg: '#fffdf2', surface: '#f5f0dd', elevated: '#ede5cc', foreground: '#302d20', muted: '#655f49', dim: '#7b745d', accent: '#806000', border: '#61705a', success: '#47703c', error: '#a23d35', warning: '#7a5800', secondary: '#72528b', selectionBg: '#735b19', selectionText: '#ffffff' },
  porcelain: { bg: '#f8fafc', surface: '#edf1f5', elevated: '#e3e9ef', foreground: '#202a33', muted: '#4e606f', dim: '#6a7a87', accent: '#255f91', border: '#4c7899', success: '#337050', error: '#a33c4a', warning: '#815d09', secondary: '#6555a0', selectionBg: '#255f91', selectionText: '#ffffff' },
  fog: { bg: '#eef1f2', surface: '#e2e7e9', elevated: '#d8dfe2', foreground: '#243035', muted: '#4f5f65', dim: '#68787e', accent: '#356979', border: '#547786', success: '#3b7154', error: '#9f4148', warning: '#7d5e14', secondary: '#68578e', selectionBg: '#356979', selectionText: '#ffffff' },
  sand: { bg: '#f7f0df', surface: '#eee3cd', elevated: '#e5d7bb', foreground: '#332a20', muted: '#685947', dim: '#7e6f5b', accent: '#8a551d', border: '#6e7560', success: '#4d703f', error: '#a23f36', warning: '#7f5a00', secondary: '#765080', selectionBg: '#805326', selectionText: '#ffffff' },
  'rose-mist': { bg: '#fbf4f6', surface: '#f2e6ea', elevated: '#eadbe0', foreground: '#35272d', muted: '#6b535d', dim: '#806a73', accent: '#95536b', border: '#8a6475', success: '#477255', error: '#a1384f', warning: '#80600b', secondary: '#72549a', selectionBg: '#8b4962', selectionText: '#ffffff' },
  lavender: { bg: '#f8f5fc', surface: '#eee8f5', elevated: '#e5ddef', foreground: '#2e2938', muted: '#61586f', dim: '#776d85', accent: '#6d4ca0', border: '#756590', success: '#477251', error: '#a23d50', warning: '#80600a', secondary: '#426b91', selectionBg: '#684795', selectionText: '#ffffff' },
  stone: { bg: '#f2f1ef', surface: '#e7e5e1', elevated: '#dddad5', foreground: '#2d2c29', muted: '#5f5d57', dim: '#77736c', accent: '#5f625c', border: '#70736d', success: '#477047', error: '#9d413d', warning: '#795c12', secondary: '#63577d', selectionBg: '#565954', selectionText: '#ffffff' },
  mushroom: { bg: '#f3efe9', surface: '#e8e1d8', elevated: '#ded5ca', foreground: '#302b27', muted: '#635951', dim: '#796e65', accent: '#75543f', border: '#747064', success: '#4b7046', error: '#9f433c', warning: '#7c5a0c', secondary: '#6c537e', selectionBg: '#6d4d39', selectionText: '#ffffff' },
  overcast: { bg: '#e9edf0', surface: '#dde3e7', elevated: '#d3dbe0', foreground: '#222d35', muted: '#495b67', dim: '#677984', accent: '#426b82', border: '#5a7787', success: '#39704f', error: '#9d3f49', warning: '#795d13', secondary: '#5e588c', selectionBg: '#3d657b', selectionText: '#ffffff' },
  sage: { bg: '#f1f5ed', surface: '#e4ecdf', elevated: '#dae5d4', foreground: '#263127', muted: '#526453', dim: '#687b69', accent: '#49704e', border: '#627d65', success: '#367044', error: '#9e4140', warning: '#795d0d', secondary: '#63568a', selectionBg: '#456b4a', selectionText: '#ffffff' },
  graphite: { bg: '#17191c', surface: '#22252a', elevated: '#2a2e34', foreground: '#edf0f3', muted: '#b0b6bf', dim: '#858d98', accent: '#69a7d6', border: '#6f91aa', success: '#78bd8b', error: '#ee7883', warning: '#d8ad62', secondary: '#b59add', selectionBg: '#315f80', selectionText: '#ffffff' },
  navy: { bg: '#0c1624', surface: '#142338', elevated: '#1b2c43', foreground: '#e9f1fa', muted: '#a8b8ca', dim: '#7c90a7', accent: '#67b7e8', border: '#5788b0', success: '#72c69a', error: '#f17b88', warning: '#e1b866', secondary: '#b4a0e8', selectionBg: '#245f86', selectionText: '#ffffff' },
  espresso: { bg: '#1d1512', surface: '#2a1e19', elevated: '#34251f', foreground: '#f3e8df', muted: '#c1aa9a', dim: '#927b6d', accent: '#e29a5b', border: '#a9785b', success: '#91be78', error: '#ef7d72', warning: '#dfb55f', secondary: '#c69bc7', selectionBg: '#80502e', selectionText: '#ffffff' },
  aubergine: { bg: '#1b121e', surface: '#28192c', elevated: '#332039', foreground: '#f2e8f4', muted: '#bea9c2', dim: '#917a98', accent: '#d18bd7', border: '#9b6ca1', success: '#87c58b', error: '#f07b91', warning: '#dfb467', secondary: '#83b5df', selectionBg: '#713d77', selectionText: '#ffffff' },
  oled: { bg: '#000000', surface: '#0a0a0a', elevated: '#121212', foreground: '#f5f5f5', muted: '#b8b8b8', dim: '#858585', accent: '#62d8ff', border: '#57a9c5', success: '#72e59a', error: '#ff7185', warning: '#ffd166', secondary: '#c9a0ff', selectionBg: '#075f78', selectionText: '#ffffff' },
  'hc-light': { bg: '#ffffff', surface: '#f2f2f2', elevated: '#e6e6e6', foreground: '#000000', muted: '#333333', dim: '#595959', accent: '#0047ab', border: '#003f88', success: '#006b2e', error: '#a40000', warning: '#6b4d00', secondary: '#5a2380', selectionBg: '#003f88', selectionText: '#ffffff' },
  'hc-dark': { bg: '#000000', surface: '#101010', elevated: '#1c1c1c', foreground: '#ffffff', muted: '#d0d0d0', dim: '#a0a0a0', accent: '#66d9ff', border: '#70bfff', success: '#7cff9b', error: '#ff6b78', warning: '#ffe066', secondary: '#d5a6ff', selectionBg: '#00658a', selectionText: '#ffffff' },
} as const satisfies Record<string, SemanticSeed>

const PALETTES: Record<ThemeName, Record<ThemeColor, Swatch>> = {
  dark: DARK_PALETTE,
  light: LIGHT_PALETTE,
  midnight: MIDNIGHT_PALETTE,
  solarized: SOLARIZED_PALETTE,
  catppuccin: CATPPUCCIN_PALETTE,
  dracula: DRACULA_PALETTE,
  nord: NORD_PALETTE,
  gruvbox: GRUVBOX_PALETTE,
  'rose-pine': ROSE_PINE_PALETTE,
  mono: MONO_PALETTE,
  arctic: semanticPalette(NEW_THEME_SEEDS.arctic),
  paper: semanticPalette(NEW_THEME_SEEDS.paper),
  ivory: semanticPalette(NEW_THEME_SEEDS.ivory),
  porcelain: semanticPalette(NEW_THEME_SEEDS.porcelain),
  fog: semanticPalette(NEW_THEME_SEEDS.fog),
  sand: semanticPalette(NEW_THEME_SEEDS.sand),
  'rose-mist': semanticPalette(NEW_THEME_SEEDS['rose-mist']),
  lavender: semanticPalette(NEW_THEME_SEEDS.lavender),
  stone: semanticPalette(NEW_THEME_SEEDS.stone),
  mushroom: semanticPalette(NEW_THEME_SEEDS.mushroom),
  overcast: semanticPalette(NEW_THEME_SEEDS.overcast),
  sage: semanticPalette(NEW_THEME_SEEDS.sage),
  graphite: semanticPalette(NEW_THEME_SEEDS.graphite),
  navy: semanticPalette(NEW_THEME_SEEDS.navy),
  espresso: semanticPalette(NEW_THEME_SEEDS.espresso),
  aubergine: semanticPalette(NEW_THEME_SEEDS.aubergine),
  oled: semanticPalette(NEW_THEME_SEEDS.oled),
  'hc-light': semanticPalette(NEW_THEME_SEEDS['hc-light']),
  'hc-dark': semanticPalette(NEW_THEME_SEEDS['hc-dark']),
}

/** 16-color fallbacks when the terminal is not truecolor. */
const DARK_ANSI16: Record<ThemeColor, string> = {
  accent: '33',
  border: '36',
  borderAccent: '36',
  borderMuted: '90',
  success: '32',
  error: '31',
  warning: '33',
  muted: '37',
  dim: '90',
  text: '39',
  selectionText: '97',
  selectionBg: '44',
  userMessageText: '39',
  userMessageBg: '40',
  toolPendingBg: '40',
  toolSuccessBg: '40',
  toolErrorBg: '41',
  toolTitle: '39',
  toolOutput: '37',
  toolDiffAdded: '32',
  toolDiffRemoved: '31',
  toolDiffContext: '90',
  mdHeading: '33',
  mdLink: '36',
  mdLinkUrl: '90',
  mdCode: '90',
  mdCodeBlock: '36',
  mdCodeBlockBorder: '90',
  mdKeyword: '36',
  mdQuote: '37',
  mdListBullet: '33',
  thinkingText: '90',
  customMessageLabel: '35',
}

const LIGHT_ANSI16: Record<ThemeColor, string> = {
  accent: '36',
  border: '34',
  borderAccent: '36',
  borderMuted: '90',
  success: '32',
  error: '31',
  warning: '33',
  muted: '30',
  dim: '90',
  text: '39',
  selectionText: '30',
  selectionBg: '47',
  userMessageText: '39',
  userMessageBg: '47',
  toolPendingBg: '47',
  toolSuccessBg: '42',
  toolErrorBg: '41',
  toolTitle: '39',
  toolOutput: '30',
  toolDiffAdded: '32',
  toolDiffRemoved: '31',
  toolDiffContext: '90',
  mdHeading: '33',
  mdLink: '34',
  mdLinkUrl: '90',
  mdCode: '90',
  mdCodeBlock: '36',
  mdCodeBlockBorder: '90',
  mdKeyword: '34',
  mdQuote: '30',
  mdListBullet: '32',
  thinkingText: '90',
  customMessageLabel: '35',
}

const MIDNIGHT_ANSI16: Record<ThemeColor, string> = {
  ...DARK_ANSI16,
  accent: '34',
  border: '34',
  borderAccent: '36',
  mdHeading: '35',
  mdLink: '36',
  mdKeyword: '35',
  mdListBullet: '34',
  customMessageLabel: '35',
}

const SOLARIZED_ANSI16: Record<ThemeColor, string> = {
  ...DARK_ANSI16,
  accent: '33',
  border: '34',
  borderAccent: '36',
  mdHeading: '33',
  mdLink: '34',
  mdKeyword: '32',
  mdCodeBlock: '36',
  mdListBullet: '33',
  customMessageLabel: '35',
}

const CATPPUCCIN_ANSI16: Record<ThemeColor, string> = {
  ...DARK_ANSI16,
  accent: '33',
  border: '34',
  borderAccent: '35',
  mdHeading: '33',
  mdLink: '34',
  mdKeyword: '35',
  mdListBullet: '33',
  customMessageLabel: '35',
}

const DRACULA_ANSI16: Record<ThemeColor, string> = {
  ...DARK_ANSI16,
  accent: '35',
  border: '35',
  borderAccent: '35',
  mdHeading: '35',
  mdLink: '36',
  mdKeyword: '35',
  mdListBullet: '35',
  customMessageLabel: '35',
}

const NORD_ANSI16: Record<ThemeColor, string> = {
  ...DARK_ANSI16,
  accent: '36',
  border: '34',
  borderAccent: '36',
  mdHeading: '36',
  mdLink: '36',
  mdKeyword: '34',
  mdListBullet: '34',
  customMessageLabel: '35',
}

const GRUVBOX_ANSI16: Record<ThemeColor, string> = {
  ...DARK_ANSI16,
  accent: '33',
  border: '36',
  borderAccent: '32',
  mdHeading: '33',
  mdLink: '32',
  mdKeyword: '35',
  mdListBullet: '33',
  customMessageLabel: '35',
}

const ROSE_PINE_ANSI16: Record<ThemeColor, string> = {
  ...DARK_ANSI16,
  accent: '35',
  border: '36',
  borderAccent: '36',
  mdHeading: '35',
  mdLink: '36',
  mdKeyword: '36',
  mdListBullet: '35',
  customMessageLabel: '35',
}

const MONO_ANSI16: Record<ThemeColor, string> = {
  ...DARK_ANSI16,
  accent: '97',
  border: '37',
  borderAccent: '97',
  success: '37',
  error: '97',
  warning: '37',
  muted: '37',
  mdHeading: '97',
  mdLink: '37',
  mdCodeBlock: '37',
  mdKeyword: '37',
  mdListBullet: '37',
  customMessageLabel: '37',
}

const ANSI16: Record<ThemeName, Record<ThemeColor, string>> = {
  dark: DARK_ANSI16,
  light: LIGHT_ANSI16,
  midnight: MIDNIGHT_ANSI16,
  solarized: SOLARIZED_ANSI16,
  catppuccin: CATPPUCCIN_ANSI16,
  dracula: DRACULA_ANSI16,
  nord: NORD_ANSI16,
  gruvbox: GRUVBOX_ANSI16,
  'rose-pine': ROSE_PINE_ANSI16,
  mono: MONO_ANSI16,
  arctic: { ...LIGHT_ANSI16, accent: '36', border: '34', borderAccent: '36', customMessageLabel: '35' },
  paper: { ...LIGHT_ANSI16, accent: '33', border: '34', borderAccent: '33', customMessageLabel: '35' },
  ivory: { ...LIGHT_ANSI16, accent: '33', border: '32', borderAccent: '33', customMessageLabel: '35' },
  porcelain: { ...LIGHT_ANSI16, accent: '34', border: '34', borderAccent: '34', customMessageLabel: '35' },
  fog: { ...LIGHT_ANSI16, accent: '36', border: '34', borderAccent: '36', customMessageLabel: '35' },
  sand: { ...LIGHT_ANSI16, accent: '33', border: '32', borderAccent: '33', customMessageLabel: '35' },
  'rose-mist': { ...LIGHT_ANSI16, accent: '35', border: '35', borderAccent: '35', customMessageLabel: '35' },
  lavender: { ...LIGHT_ANSI16, accent: '35', border: '34', borderAccent: '35', customMessageLabel: '34' },
  stone: { ...LIGHT_ANSI16, accent: '30', border: '90', borderAccent: '30', customMessageLabel: '35' },
  mushroom: { ...LIGHT_ANSI16, accent: '33', border: '90', borderAccent: '33', customMessageLabel: '35' },
  overcast: { ...LIGHT_ANSI16, accent: '34', border: '36', borderAccent: '34', customMessageLabel: '35' },
  sage: { ...LIGHT_ANSI16, accent: '32', border: '32', borderAccent: '32', customMessageLabel: '35' },
  graphite: { ...DARK_ANSI16, accent: '96', border: '36', borderAccent: '96', customMessageLabel: '95' },
  navy: { ...DARK_ANSI16, accent: '96', border: '34', borderAccent: '96', customMessageLabel: '95' },
  espresso: { ...DARK_ANSI16, accent: '93', border: '33', borderAccent: '93', customMessageLabel: '95' },
  aubergine: { ...DARK_ANSI16, accent: '95', border: '35', borderAccent: '95', customMessageLabel: '96' },
  oled: { ...DARK_ANSI16, accent: '96', border: '36', borderAccent: '96', customMessageLabel: '95' },
  'hc-light': { ...LIGHT_ANSI16, accent: '34', border: '34', borderAccent: '34', muted: '30', dim: '90', selectionText: '97', selectionBg: '44' },
  'hc-dark': { ...DARK_ANSI16, accent: '96', border: '94', borderAccent: '96', muted: '97', dim: '37', selectionText: '97', selectionBg: '44' },
}

const FG_RESET = '\x1b[39m'
const BG_RESET = '\x1b[49m'
const BOLD_RESET = '\x1b[22m'
const ITALIC_RESET = '\x1b[23m'
const UNDERLINE_RESET = '\x1b[24m'
const STRIKE_RESET = '\x1b[29m'
const INVERSE_RESET = '\x1b[27m'

/** Built-in palettes, including a few well-known oh-my-pi coding themes. */
export const THEME_NAMES = [
  'dark', 'light', 'midnight', 'solarized',
  'catppuccin', 'dracula', 'nord', 'gruvbox', 'rose-pine',
  'mono',
  'arctic', 'paper', 'ivory', 'porcelain', 'fog', 'sand', 'rose-mist', 'lavender',
  'stone', 'mushroom', 'overcast', 'sage',
  'graphite', 'navy', 'espresso', 'aubergine', 'oled',
  'hc-light', 'hc-dark',
] as const

/** One shipped palette name. */
export type ThemeName = (typeof THEME_NAMES)[number]

export type ThemeAppearance = 'light' | 'dark'
export type ThemeGroup = 'Classic' | 'Light' | 'Dark' | 'High contrast'

/** User-facing metadata and contrast canvas for every persisted theme id. */
export interface ThemeDefinition {
  readonly name: ThemeName
  readonly label: string
  readonly description: string
  readonly group: ThemeGroup
  readonly appearance: ThemeAppearance
  readonly background: string
}

function themeDefinition(
  name: ThemeName,
  label: string,
  description: string,
  group: ThemeGroup,
  appearance: ThemeAppearance,
  background: string,
): ThemeDefinition {
  return Object.freeze({ name, label, description, group, appearance, background })
}

/** Complete semantic theme catalog. Persisted ids remain stable for compatibility. */
export const THEME_CATALOG: Readonly<Record<ThemeName, ThemeDefinition>> = Object.freeze({
  dark: themeDefinition('dark', 'Dark', 'Warm default with amber accents.', 'Classic', 'dark', '#15141a'),
  light: themeDefinition('light', 'Light', 'Cool neutral palette for bright terminals.', 'Classic', 'light', '#ffffff'),
  midnight: themeDefinition('midnight', 'Midnight', 'Deep blue coding palette.', 'Classic', 'dark', '#1a1b26'),
  solarized: themeDefinition('solarized', 'Solarized Dark', 'Low-glare cyan and ochre.', 'Classic', 'dark', '#002b36'),
  catppuccin: themeDefinition('catppuccin', 'Catppuccin Mocha', 'Soft pastel dark palette.', 'Classic', 'dark', '#1e1e2e'),
  dracula: themeDefinition('dracula', 'Dracula', 'Vivid purple dark palette.', 'Classic', 'dark', '#282a36'),
  nord: themeDefinition('nord', 'Nord', 'Polar blue dark palette.', 'Classic', 'dark', '#2e3440'),
  gruvbox: themeDefinition('gruvbox', 'Gruvbox Dark', 'Earthy retro dark palette.', 'Classic', 'dark', '#282828'),
  'rose-pine': themeDefinition('rose-pine', 'Rosé Pine', 'Muted rose and iris dark palette.', 'Classic', 'dark', '#191724'),
  mono: themeDefinition('mono', 'Monochrome', 'Grayscale dark palette.', 'Classic', 'dark', '#141414'),
  arctic: themeDefinition('arctic', 'Arctic', 'Crisp ice-blue light palette.', 'Light', 'light', NEW_THEME_SEEDS.arctic.bg),
  paper: themeDefinition('paper', 'Paper', 'Natural white with ink and sepia.', 'Light', 'light', NEW_THEME_SEEDS.paper.bg),
  ivory: themeDefinition('ivory', 'Ivory', 'Warm cream with restrained gold.', 'Light', 'light', NEW_THEME_SEEDS.ivory.bg),
  porcelain: themeDefinition('porcelain', 'Porcelain', 'Clean blue-white neutral palette.', 'Light', 'light', NEW_THEME_SEEDS.porcelain.bg),
  fog: themeDefinition('fog', 'Fog', 'Soft gray-blue low-glare palette.', 'Light', 'light', NEW_THEME_SEEDS.fog.bg),
  sand: themeDefinition('sand', 'Sand', 'Warm beige and earthen accents.', 'Light', 'light', NEW_THEME_SEEDS.sand.bg),
  'rose-mist': themeDefinition('rose-mist', 'Rose Mist', 'Quiet blush with berry accents.', 'Light', 'light', NEW_THEME_SEEDS['rose-mist'].bg),
  lavender: themeDefinition('lavender', 'Lavender', 'Pale violet with plum accents.', 'Light', 'light', NEW_THEME_SEEDS.lavender.bg),
  stone: themeDefinition('stone', 'Stone', 'Balanced warm grayscale.', 'Light', 'light', NEW_THEME_SEEDS.stone.bg),
  mushroom: themeDefinition('mushroom', 'Mushroom', 'Taupe light palette with earthy ink.', 'Light', 'light', NEW_THEME_SEEDS.mushroom.bg),
  overcast: themeDefinition('overcast', 'Overcast', 'Cool cloudy gray with blue accents.', 'Light', 'light', NEW_THEME_SEEDS.overcast.bg),
  sage: themeDefinition('sage', 'Sage', 'Soft green neutral light palette.', 'Light', 'light', NEW_THEME_SEEDS.sage.bg),
  graphite: themeDefinition('graphite', 'Graphite', 'Neutral charcoal with steel blue.', 'Dark', 'dark', NEW_THEME_SEEDS.graphite.bg),
  navy: themeDefinition('navy', 'Navy', 'Deep ocean blue with clear cyan.', 'Dark', 'dark', NEW_THEME_SEEDS.navy.bg),
  espresso: themeDefinition('espresso', 'Espresso', 'Coffee-black with warm copper.', 'Dark', 'dark', NEW_THEME_SEEDS.espresso.bg),
  aubergine: themeDefinition('aubergine', 'Aubergine', 'Deep purple with orchid accents.', 'Dark', 'dark', NEW_THEME_SEEDS.aubergine.bg),
  oled: themeDefinition('oled', 'OLED', 'True black with luminous accents.', 'Dark', 'dark', NEW_THEME_SEEDS.oled.bg),
  'hc-light': themeDefinition('hc-light', 'High Contrast Light', 'Maximum separation on white.', 'High contrast', 'light', NEW_THEME_SEEDS['hc-light'].bg),
  'hc-dark': themeDefinition('hc-dark', 'High Contrast Dark', 'Maximum separation on black.', 'High contrast', 'dark', NEW_THEME_SEEDS['hc-dark'].bg),
})

/** Metadata for a shipped theme. */
export function getThemeDefinition(name: ThemeName): ThemeDefinition {
  return THEME_CATALOG[name]
}

/** True when `value` is a shipped palette name. */
export function isThemeName(value: string): value is ThemeName {
  return (THEME_NAMES as readonly string[]).includes(value)
}

/** Normalize a config/CLI token to a palette name (`dark` when unknown). */
export function parseThemeName(value: string | undefined): ThemeName {
  return value !== undefined && isThemeName(value) ? value : 'dark'
}

/** Paint helpers the view uses; identity functions when colors are off. */
export interface Theme {
  /** Active palette name. */
  readonly name: ThemeName
  /** Whether SGR is emitted. */
  readonly colors: boolean
  /** Whether hex colors become 24-bit SGR (else 16-color). */
  readonly trueColor: boolean
  fg(color: ThemeColor, text: string): string
  bg(color: ThemeColor, text: string): string
  getFgAnsi(color: ThemeColor): string
  getBgAnsi(color: ThemeColor): string
  bold(text: string): string
  italic(text: string): string
  underline(text: string): string
  strikethrough(text: string): string
  dim(text: string): string
  /** Inverse video that leaves surrounding foreground intact (`27` not `0`). */
  inverse(text: string): string
}

function hexToRgb(hex: string): [number, number, number] {
  const body = hex.startsWith('#') ? hex.slice(1) : hex
  return [
    Number.parseInt(body.slice(0, 2), 16),
    Number.parseInt(body.slice(2, 4), 16),
    Number.parseInt(body.slice(4, 6), 16),
  ]
}

function fgCode(swatch: Swatch, trueColor: boolean, fallback: string): string {
  if (swatch === '') return '\x1b[39m'
  if (typeof swatch === 'number') return `\x1b[38;5;${swatch}m`
  if (!trueColor) return `\x1b[${fallback}m`
  const [r, g, b] = hexToRgb(swatch)
  return `\x1b[38;2;${r};${g};${b}m`
}

function bgCode(swatch: Swatch, trueColor: boolean, fallback: string): string {
  if (swatch === '') return '\x1b[49m'
  if (typeof swatch === 'number') return `\x1b[48;5;${swatch}m`
  if (!trueColor) return `\x1b[${fallback}m`
  const [r, g, b] = hexToRgb(swatch)
  return `\x1b[48;2;${r};${g};${b}m`
}

/**
 * Detect 24-bit color the way OMP does: COLORTERM, Windows Terminal, else
 * assume truecolor unless TERM is a known 16-color host.
 */
export function detectTrueColor(env: NodeJS.ProcessEnv = process.env): boolean {
  const colorterm = env.COLORTERM ?? ''
  if (colorterm === 'truecolor' || colorterm === '24bit') return true
  if (env.WT_SESSION) return true
  const term = env.TERM ?? ''
  if (term === 'dumb' || term === '' || term === 'linux') return false
  return true
}

const THEME_CACHE = new Map<string, Theme>()

/**
 * Build a theme. The finite palette/capability matrix is memoized because a
 * live TUI asks for the same immutable paint helpers on every frame.
 * @param colors - emit SGR when true.
 * @param trueColor - 24-bit hex; ignored when colors is false.
 * @param name - shipped palette (`dark` default).
 */
export function createTheme(
  colors: boolean,
  trueColor = detectTrueColor(),
  name: ThemeName = 'dark',
): Theme {
  const tc = colors && trueColor
  const cacheKey = `${name}:${colors ? 1 : 0}:${tc ? 1 : 0}`
  const cached = THEME_CACHE.get(cacheKey)
  if (cached !== undefined) return cached
  const palette = PALETTES[name]
  const ansi = ANSI16[name]
  const getFgAnsi = (color: ThemeColor): string =>
    colors ? fgCode(palette[color], tc, ansi[color]) : ''
  const getBgAnsi = (color: ThemeColor): string =>
    colors ? bgCode(palette[color], tc, ansi[color]) : ''
  const paint = (open: string, text: string, close: string): string =>
    colors && open !== '' ? open + text + close : text
  const theme: Theme = {
    name,
    colors,
    trueColor: tc,
    getFgAnsi,
    getBgAnsi,
    fg: (color, text) => paint(getFgAnsi(color), text, FG_RESET),
    bg: (color, text) => paint(getBgAnsi(color), text, BG_RESET),
    bold: (text) => (colors ? `\x1b[1m${text}${BOLD_RESET}` : text),
    italic: (text) => (colors ? `\x1b[3m${text}${ITALIC_RESET}` : text),
    underline: (text) => (colors ? `\x1b[4m${text}${UNDERLINE_RESET}` : text),
    strikethrough: (text) => (colors ? `\x1b[9m${text}${STRIKE_RESET}` : text),
    dim: (text) => paint(getFgAnsi('dim'), text, FG_RESET),
    inverse: (text) => (colors ? `\x1b[7m${text}${INVERSE_RESET}` : text),
  }
  Object.freeze(theme)
  THEME_CACHE.set(cacheKey, theme)
  return theme
}

/** DeepSeek mark adapted from the official SVG for a 20×6 terminal cell. */
export const DEEPSEEK_LOGO = [
  '         ⢀⣀  ⢀⡀     ',
  '⢀⣤⣶⣿⣿⣿⣿⣿⣿⣿⣧⣄⡀⢻⣿⣷⣶⣶⣶⡿',
  '⣿⡟⠛⠛⠛⠿⢿⣿⣿⣿⣿⡿⢿⣷⣾⣿⣿⠉⠉ ',
  '⢻⣿⣄⡀  ⢀⠈⠛⢿⣿⣿⣶⣿⣿⡿⠃   ',
  ' ⠙⠻⢿⣶⣦⣼⣿⣷⣦⣭⣿⠿⣿⣷⠦    ',
  '     ⠉⠉⠉⠉⠉⠁         ',
] as const

/** @deprecated Use {@link DEEPSEEK_LOGO}; retained for API compatibility. */
export const PI_LOGO = [
  '▀██████████▀',
  ' ╘██    ██  ',
  '  ██    ██  ',
  '  ██    ██  ',
  ' ▄██▄  ▄██▄ ',
] as const

const GRADIENT_STOPS: ReadonlyArray<readonly [number, number, number]> = [
  [255, 92, 200],
  [200, 110, 255],
  [120, 130, 255],
  [60, 200, 255],
  [120, 255, 220],
]

const GRADIENT_RAMP_256 = [199, 171, 135, 99, 75, 51, 87]

function gradientEscape(t: number, trueColor: boolean): string {
  if (trueColor) {
    const seg = t * (GRADIENT_STOPS.length - 1)
    const i = Math.min(GRADIENT_STOPS.length - 2, Math.floor(seg))
    const f = seg - i
    const a = GRADIENT_STOPS[i] ?? GRADIENT_STOPS[0]!
    const b = GRADIENT_STOPS[i + 1] ?? a
    const r = Math.round(a[0] + (b[0] - a[0]) * f)
    const g = Math.round(a[1] + (b[1] - a[1]) * f)
    const bl = Math.round(a[2] + (b[2] - a[2]) * f)
    return `\x1b[38;2;${r};${g};${bl}m`
  }
  const idx = Math.min(GRADIENT_RAMP_256.length - 1, Math.max(0, Math.floor(t * (GRADIENT_RAMP_256.length - 1) + 0.5)))
  return `\x1b[38;5;${GRADIENT_RAMP_256[idx]}m`
}

/**
 * Diagonal gradient across the DeepSeek logo.
 * Unstyled when colors are off.
 */
export function gradientLogo(theme: Theme, lines: readonly string[] = DEEPSEEK_LOGO): string[] {
  if (!theme.colors) return [...lines]
  const reset = FG_RESET
  const rows = lines.length
  const cols = Math.max(0, ...lines.map((line) => line.length))
  const span = Math.max(1, cols + rows - 1)
  return lines.map((line, y) => {
    let out = ''
    for (let x = 0; x < line.length; x += 1) {
      const ch = line[x] ?? ' '
      if (ch === ' ') {
        out += ch
        continue
      }
      const t = (x + (rows - 1 - y)) / span
      out += gradientEscape(t, theme.trueColor) + ch + reset
    }
    return out
  })
}
