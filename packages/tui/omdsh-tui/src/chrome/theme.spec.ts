import { describe, expect, it } from 'vitest'
import { BOX, createTheme, DEEPSEEK_LOGO, detectTrueColor, getThemeDefinition, gradientLogo, parseThemeName, SYMBOL, THEME_CATALOG, THEME_COLOR_NAMES, THEME_NAMES } from './theme.ts'

function sgrLuminance(ansi: string): number {
  const match = /(?:38|48);2;(\d+);(\d+);(\d+)/u.exec(ansi)
  if (match === null) return Number.NaN
  const channels = [match[1], match[2], match[3]].map(value => Number(value) / 255)
  const linear = channels.map(channel => (
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ))
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0)
}

function rgbLuminance(red: number, green: number, blue: number): number {
  const channels = [red, green, blue].map(value => value / 255).map(channel => (
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ))
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0)
}

function hexLuminance(hex: string): number {
  return rgbLuminance(
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  )
}

function contrastRatio(foreground: number, background: number): number {
  const lighter = Math.max(foreground, background)
  const darker = Math.min(foreground, background)
  return (lighter + 0.05) / (darker + 0.05)
}

describe('createTheme', () => {
  it('reuses immutable helpers for the same palette capabilities', () => {
    const first = createTheme(true, true, 'dark')
    const second = createTheme(true, true, 'dark')
    expect(second).toBe(first)
    expect(Object.isFrozen(first)).toBe(true)
  })

  it('is identity when colors are off', () => {
    const theme = createTheme(false, true)
    expect(theme.fg('accent', 'x')).toBe('x')
    expect(theme.bold('x')).toBe('x')
    expect(theme.underline('x')).toBe('x')
    expect(theme.strikethrough('x')).toBe('x')
    expect(theme.inverse('x')).toBe('x')
    expect(theme.getFgAnsi('accent')).toBe('')
  })

  it('emits 24-bit SGR for hex colors', () => {
    const theme = createTheme(true, true)
    expect(theme.getFgAnsi('accent')).toBe('\x1b[38;2;254;188;56m')
    expect(theme.getFgAnsi('mdLink')).toBe('\x1b[38;2;0;136;250m')
    expect(theme.underline('x')).toBe('\x1b[4mx\x1b[24m')
    expect(theme.strikethrough('x')).toBe('\x1b[9mx\x1b[29m')
    expect(theme.inverse('x')).toBe('\x1b[7mx\x1b[27m')
    expect(theme.bold('x')).toBe('\x1b[1mx\x1b[22m')
    expect(theme.italic('x')).toBe('\x1b[3mx\x1b[23m')
    expect(theme.fg('success', 'ok')).toContain('ok')
    expect(theme.fg('success', 'ok')).toContain('\x1b[39m')
    expect(theme.fg('success', 'ok')).not.toContain('\x1b[0m')
    expect(theme.bg('userMessageBg', 'x')).toContain('\x1b[49m')
  })

  it('falls back to 16-color SGR without truecolor', () => {
    const theme = createTheme(true, false)
    expect(theme.getFgAnsi('error')).toBe('\x1b[31m')
  })

  it('preserves body and metadata hierarchy in every 16-color fallback', () => {
    for (const name of THEME_NAMES) {
      const theme = createTheme(true, false, name)
      expect(theme.getFgAnsi('text'), `${name} text`).toBe('\x1b[39m')
      expect(theme.getFgAnsi('muted'), `${name} muted`).not.toBe(theme.getFgAnsi('dim'))
    }
  })

  it('paints the light palette with a different accent', () => {
    const dark = createTheme(true, true, 'dark')
    const light = createTheme(true, true, 'light')
    expect(dark.name).toBe('dark')
    expect(light.name).toBe('light')
    expect(light.getFgAnsi('accent')).toBe('\x1b[38;2;90;128;128m')
    expect(light.getFgAnsi('accent')).not.toBe(dark.getFgAnsi('accent'))
  })

  it('ships additional coding palettes', () => {
    expect(THEME_NAMES).toEqual([
      'dark', 'light', 'midnight', 'solarized',
      'catppuccin', 'dracula', 'nord', 'gruvbox', 'rose-pine',
      'mono',
      'arctic', 'paper', 'ivory', 'porcelain', 'fog', 'sand', 'rose-mist', 'lavender',
      'stone', 'mushroom', 'overcast', 'sage',
      'graphite', 'navy', 'espresso', 'aubergine', 'oled',
      'hc-light', 'hc-dark',
    ])
    expect(createTheme(true, true, 'catppuccin').name).toBe('catppuccin')
    expect(createTheme(true, true, 'rose-pine').getFgAnsi('thinkingText')).not.toBe(
      createTheme(true, true, 'rose-pine').getFgAnsi('text'),
    )
  })

  it('keeps muted borders and fence keywords off the UI accent', () => {
    const dark = createTheme(true, true, 'dark')
    const midnight = createTheme(true, true, 'midnight')
    const solarized = createTheme(true, true, 'solarized')
    expect(dark.getFgAnsi('borderMuted')).toBe('\x1b[38;2;61;66;74m')
    expect(dark.getFgAnsi('mdKeyword')).toBe('\x1b[38;2;86;156;214m')
    expect(dark.getFgAnsi('mdKeyword')).not.toBe(dark.getFgAnsi('accent'))
    expect(midnight.getFgAnsi('muted')).toBe('\x1b[38;2;119;125;136m')
    expect(midnight.getFgAnsi('error')).toBe('\x1b[38;2;247;118;142m')
    expect(midnight.getFgAnsi('borderMuted')).not.toBe(midnight.getFgAnsi('border'))
    expect(solarized.getFgAnsi('mdKeyword')).toBe('\x1b[38;2;133;153;0m')
    expect(solarized.getFgAnsi('customMessageLabel')).toBe('\x1b[38;2;108;113;196m')
  })

  it('keeps thinking text quieter than muted chrome', () => {
    const dark = createTheme(true, true, 'dark')
    expect(dark.getFgAnsi('thinkingText')).toBe('\x1b[38;2;107;114;128m')
    expect(dark.getFgAnsi('thinkingText')).not.toBe(dark.getFgAnsi('text'))
    expect(dark.getFgAnsi('thinkingText')).not.toBe(dark.getFgAnsi('muted'))
    expect(dark.getFgAnsi('thinkingText')).not.toBe(dark.getFgAnsi('dim'))
  })

  it('lets the terminal own body ink while keeping thinking explicitly muted', () => {
    const midnight = createTheme(true, true, 'midnight')
    expect(midnight.getFgAnsi('text')).toBe('\x1b[39m')
    expect(midnight.getFgAnsi('thinkingText')).toBe('\x1b[38;2;106;115;148m')
    expect(midnight.getFgAnsi('thinkingText')).not.toBe(midnight.getFgAnsi('text'))
    expect(midnight.getFgAnsi('thinkingText')).not.toBe(midnight.getFgAnsi('dim'))
  })

  it('preserves terminal-owned body ink for legacy palettes and gives new families independent ink', () => {
    for (const name of THEME_NAMES.slice(0, 10)) {
      expect(createTheme(true, true, name).getFgAnsi('text'), name).toBe('\x1b[39m')
    }
    for (const name of THEME_NAMES.slice(10)) {
      expect(createTheme(true, true, name).getFgAnsi('text'), name).toMatch(/^\x1b\[38;2;/u)
    }
  })

  it('has complete metadata and truecolor/ANSI16 entries for every semantic token', () => {
    expect(Object.keys(THEME_CATALOG)).toEqual([...THEME_NAMES])
    for (const name of THEME_NAMES) {
      const definition = getThemeDefinition(name)
      const truecolor = createTheme(true, true, name)
      const ansi16 = createTheme(true, false, name)
      expect(definition.name).toBe(name)
      expect(definition.label.length, `${name} label`).toBeGreaterThan(0)
      expect(definition.description.length, `${name} description`).toBeGreaterThan(0)
      for (const color of THEME_COLOR_NAMES) {
        const truecolorCode = color.endsWith('Bg') ? truecolor.getBgAnsi(color) : truecolor.getFgAnsi(color)
        const ansi16Code = color.endsWith('Bg') ? ansi16.getBgAnsi(color) : ansi16.getFgAnsi(color)
        expect(truecolorCode, `${name}.${color} truecolor`).not.toBe('')
        expect(ansi16Code, `${name}.${color} ansi16`).toMatch(/^\x1b\[/u)
      }
    }
  })

  it('keeps semantic ink readable on each theme’s corresponding canvas and selection', () => {
    for (const name of THEME_NAMES) {
      const theme = createTheme(true, true, name)
      const canvas = hexLuminance(getThemeDefinition(name).background)
      const accent = contrastRatio(sgrLuminance(theme.getFgAnsi('accent')), canvas)
      const muted = contrastRatio(sgrLuminance(theme.getFgAnsi('muted')), canvas)
      const selection = contrastRatio(
        sgrLuminance(theme.getFgAnsi('selectionText')),
        sgrLuminance(theme.getBgAnsi('selectionBg')),
      )
      expect(accent, `${name} accent`).toBeGreaterThanOrEqual(3)
      expect(muted, `${name} muted`).toBeGreaterThanOrEqual(3)
      expect(selection, `${name} selection`).toBeGreaterThanOrEqual(4.5)
      if (THEME_NAMES.indexOf(name) >= 10) {
        expect(contrastRatio(sgrLuminance(theme.getFgAnsi('text')), canvas), `${name} text`).toBeGreaterThanOrEqual(7)
      }
    }
  })

  it('keeps new tool, markdown, and diff semantics readable on their own surfaces', () => {
    for (const name of THEME_NAMES.slice(10)) {
      const theme = createTheme(true, true, name)
      for (const surface of ['toolPendingBg', 'toolSuccessBg', 'toolErrorBg'] as const) {
        expect(contrastRatio(
          sgrLuminance(theme.getFgAnsi('toolOutput')),
          sgrLuminance(theme.getBgAnsi(surface)),
        ), `${name} toolOutput/${surface}`).toBeGreaterThanOrEqual(4.5)
      }
      expect(new Set([
        theme.getBgAnsi('toolPendingBg'),
        theme.getBgAnsi('toolSuccessBg'),
        theme.getBgAnsi('toolErrorBg'),
      ]).size, `${name} tool state surfaces`).toBe(3)
      const canvas = hexLuminance(getThemeDefinition(name).background)
      expect(contrastRatio(sgrLuminance(theme.getFgAnsi('mdCodeBlock')), canvas), `${name} code`).toBeGreaterThanOrEqual(7)
      expect(contrastRatio(sgrLuminance(theme.getFgAnsi('toolDiffAdded')), canvas), `${name} diff added`).toBeGreaterThanOrEqual(3)
      expect(contrastRatio(sgrLuminance(theme.getFgAnsi('toolDiffRemoved')), canvas), `${name} diff removed`).toBeGreaterThanOrEqual(3)
    }
  })

  it('keeps light and dark families distinct in truecolor and ANSI16 fallbacks', () => {
    for (const name of THEME_NAMES.slice(10)) {
      const definition = getThemeDefinition(name)
      const canvas = hexLuminance(definition.background)
      const fallback = createTheme(true, false, name)
      if (definition.appearance === 'light') {
        expect(canvas, `${name} canvas`).toBeGreaterThan(0.7)
        expect(fallback.getBgAnsi('toolPendingBg'), `${name} ANSI surface`).toBe('\x1b[47m')
      } else {
        expect(canvas, `${name} canvas`).toBeLessThan(0.03)
        expect(fallback.getBgAnsi('toolPendingBg'), `${name} ANSI surface`).toBe('\x1b[40m')
      }
    }
  })

  it('keeps inline markdown code closer to muted text than to accent', () => {
    const dark = createTheme(true, true, 'dark')
    const midnight = createTheme(true, true, 'midnight')
    expect(dark.getFgAnsi('mdCode')).toBe('\x1b[38;2;138;144;153m')
    expect(midnight.getFgAnsi('mdCode')).toBe('\x1b[38;2;127;135;153m')
    expect(midnight.getFgAnsi('mdCode')).not.toBe('\x1b[38;2;255;158;100m')
    expect(createTheme(true, false).getFgAnsi('mdCode')).toBe('\x1b[90m')
  })
})

describe('parseThemeName', () => {
  it('accepts shipped names and falls back to dark', () => {
    expect(parseThemeName('light')).toBe('light')
    expect(parseThemeName('dark')).toBe('dark')
    expect(parseThemeName('midnight')).toBe('midnight')
    expect(parseThemeName('catppuccin')).toBe('catppuccin')
    expect(parseThemeName('rose-pine')).toBe('rose-pine')
    expect(parseThemeName('arctic')).toBe('arctic')
    expect(parseThemeName('hc-dark')).toBe('hc-dark')
    expect(parseThemeName('nope')).toBe('dark')
    expect(parseThemeName(undefined)).toBe('dark')
  })
})

describe('detectTrueColor', () => {
  it('honors COLORTERM and known 16-color TERMs', () => {
    expect(detectTrueColor({ COLORTERM: 'truecolor' })).toBe(true)
    expect(detectTrueColor({ TERM: 'linux' })).toBe(false)
  })
})

describe('chrome', () => {
  it('exports OMP rounded-box and status glyphs', () => {
    expect(BOX.topLeft).toBe('╭')
    expect(SYMBOL.success).toBe('✔')
    expect(SYMBOL.error).toBe('✘')
    expect(SYMBOL.pending).toBe('○')
    expect(SYMBOL.warning).toBe('▲')
  })

  it('paints the DeepSeek logo without styling when colors are off', () => {
    const lines = gradientLogo(createTheme(false))
    expect(lines).toEqual(DEEPSEEK_LOGO)
    expect(lines.every((line) => line.length === 20)).toBe(true)
    expect(lines[1]).toContain('⣿')
    expect(lines[0]).not.toContain('\x1b[')
  })
})
