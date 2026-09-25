import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMPOSITION_FILE, discoverPresets } from '@deepseek-ai/dsh-agent-presets'
import { SHIPPED_PRESET_ROOT } from './profile.ts'

/** Provider-specific subagent tools the Lean preset removes from the fixed schemas. */
const PROVIDER_SUBAGENTS = [
  'subagent_claude_code',
  'subagent_codex',
  'subagent_cursor',
  'subagent_devin',
  'subagent_fork',
  'subagent_gpt_pro',
  'subagent_kimi',
  'subagent_model',
]

describe('shipped agent presets', () => {
  it('discovers every shipped preset as a mountable roster row', async () => {
    const presets = await discoverPresets([{ path: SHIPPED_PRESET_ROOT, trust: 'system' }])
    expect(presets.map(preset => preset.id)).toEqual(['standard', 'code', 'minimal', 'cordis', 'lean'])
    expect(presets.filter(preset => preset.broken !== undefined)).toEqual([])
    expect(presets.find(preset => preset.id === 'lean')).toMatchObject({
      name: 'Lean',
      description: expect.stringContaining('provider-specific subagent tools'),
      order: 5,
      trust: 'system',
    })
  })

  it('keeps Lean additive: it denies only the provider-specific subagent tools', () => {
    const composition = readFileSync(join(SHIPPED_PRESET_ROOT, 'lean', COMPOSITION_FILE), 'utf8')
    const denied = [...composition.matchAll(/^ {8}- (\S+)$/gmu)].map(match => match[1])
    expect(denied).toEqual(PROVIDER_SUBAGENTS)
    // A deny list keeps every other tool; an allow list would drop the base tools too.
    expect(composition).toMatch(/^ {6}deny:$/mu)
    expect(composition).not.toMatch(/^ {6}allow:/mu)
    for (const tool of ['subagent', 'list_agents', 'send_message', 'interrupt_agent']) {
      expect(denied).not.toContain(tool)
    }
  })

  it('keeps the standard persona carrying the cost-discipline rules', () => {
    const composition = readFileSync(join(SHIPPED_PRESET_ROOT, 'standard', COMPOSITION_FILE), 'utf8')
    for (const rule of ['termdock-ast', 'subagent', 'head or tail', 'do not switch provider or model', 'Compact when']) {
      expect(composition).toContain(rule)
    }
  })

  it('pins the shipped skill catalog description budget used to trim the start payload', () => {
    const cordis = readFileSync(join(SHIPPED_PRESET_ROOT, '..', 'cordis.yml'), 'utf8')
    expect(cordis).toMatch(/catalogDescriptionMaxLength:\s*150/u)
  })
})
