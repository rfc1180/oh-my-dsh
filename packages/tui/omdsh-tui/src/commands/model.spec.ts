import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as commandModel from './model.ts'
import type { TuiService } from '../definition.ts'
import type { SessionRuntime } from '../session/session-controller.ts'

describe('orderModelsByFavorite', () => {
  it('moves favorites first, keeps the rest, and drops unknown ids', () => {
    const models = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(commandModel.orderModelsByFavorite(models, ['c', 'missing', 'a', 'c']).map(model => model.id))
      .toEqual(['c', 'a', 'b'])
  })

  it('returns catalog order when nothing is favorited', () => {
    const models = [{ id: 'a' }, { id: 'b' }]
    expect(commandModel.orderModelsByFavorite(models, []).map(model => model.id)).toEqual(['a', 'b'])
  })
})

describe('model command', () => {
  it('skips a sole provider and uses a compact model card for a short list', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    const prompt = vi.fn()
      .mockResolvedValueOnce('deepseek-v4-flash')
    const tui = { prompt } as unknown as TuiService
    const runtime = {
      selection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
      changeSelection: vi.fn(async () => undefined),
    } as unknown as SessionRuntime
    const llm = {
      listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
      resolveModelInfo: async () => ({}),
    }
    ctx.provide('tui', tui)
    ctx.provide('omdshSession', runtime)
    ctx.provide('llm', llm as never)
    await ctx.plugin(commandModel)
    const session = ctx.sessions.create(SessionId('model-command-test'))
    const agent = {
      id: session.id,
      session,
      status: 'idle',
      inbox: { nextTurn: [], nextStep: [] },
    } as unknown as Agent

    await ctx.commands.execute(agent, '/model', [], new AbortController().signal)

    expect(prompt).toHaveBeenCalledTimes(1)
    for (const [request] of prompt.mock.calls) {
      expect(request).toMatchObject({
        optionLayout: 'compact',
        filterable: false,
        allowCustom: false,
        initialValue: 'deepseek-v4-flash',
      })
      expect(request).not.toHaveProperty('presentation')
    }
    await ctx.fiber.dispose()
  })

  it('uses a searchable full-screen page for a long model list', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    const prompt = vi.fn().mockResolvedValueOnce('model-1')
    ctx.provide('tui', { prompt } as unknown as TuiService)
    ctx.provide('omdshSession', {
      selection: () => ({ provider: 'deepseek-official', model: 'model-1' }),
      changeSelection: vi.fn(async () => undefined),
    } as unknown as SessionRuntime)
    ctx.provide('llm', {
      listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
      listModels: async () => Array.from({ length: 9 }, (_, index) => ({
        id: `model-${index + 1}`,
        name: `Model ${index + 1}`,
      })),
      resolveModelInfo: async () => ({}),
    } as never)
    await ctx.plugin(commandModel)
    const session = ctx.sessions.create(SessionId('model-command-long-test'))
    const agent = {
      id: session.id,
      session,
      status: 'idle',
      inbox: { nextTurn: [], nextStep: [] },
    } as unknown as Agent

    await ctx.commands.execute(agent, '/model', [], new AbortController().signal)

    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
      presentation: 'fullscreen-list',
      filterable: true,
      optionLayout: 'compact',
    }))
    await ctx.fiber.dispose()
  })

  it('opens on the configured favorites while keeping the whole catalog searchable', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    const prompt = vi.fn().mockResolvedValueOnce('model-9')
    ctx.provide('tui', {
      prompt,
      modelFavorites: () => ['model-9', 'model-2'],
    } as unknown as TuiService)
    ctx.provide('omdshSession', {
      selection: () => ({ provider: 'openrouter', model: 'model-1' }),
      changeSelection: vi.fn(async () => undefined),
    } as unknown as SessionRuntime)
    ctx.provide('llm', {
      listProviders: () => [{ id: 'openrouter', name: 'OpenRouter' }],
      listModels: async () => Array.from({ length: 9 }, (_, index) => ({
        id: `model-${index + 1}`,
        name: `Model ${index + 1}`,
      })),
      resolveModelInfo: async () => ({}),
    } as never)
    await ctx.plugin(commandModel)
    const session = ctx.sessions.create(SessionId('model-command-favorites-test'))
    const agent = {
      id: session.id,
      session,
      status: 'idle',
      inbox: { nextTurn: [], nextStep: [] },
    } as unknown as Agent

    await ctx.commands.execute(agent, '/model', [], new AbortController().signal)

    const request = prompt.mock.calls[0]?.[0] as { options: { label: string }[] }
    expect(request.options.map(option => option.label))
      .toEqual(['model-9', 'model-2', 'model-1', 'model-3', 'model-4', 'model-5', 'model-6', 'model-7', 'model-8'])
    await ctx.fiber.dispose()
  })
})
