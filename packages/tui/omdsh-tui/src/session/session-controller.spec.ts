import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ReasoningEffortId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { mcpCatalogText } from '../commands/integrations.ts'
import type { TuiService } from '../definition.ts'
import {
  conversationTurns,
  createSubmissionMessage,
  encodeComposerImages,
  modelStatus,
  recentSessionContent,
  resolveDurableModelSelection,
  restoreSubmissionMessage,
  SessionRuntime,
  sessionControls,
  sessionStats,
  userSkillCommands,
} from './session-controller.ts'

function stubTui(): TuiService {
  return {
    activateInput: () => {},
    replaceViewportTail: () => {},
    onInspectSubagent: () => () => {},
    onInspectClose: () => () => {},
    onInspectSubmit: () => () => {},
    setSessionSearch: () => {},
    setFileSearch: () => {},
    setImageValidator: () => {},
    setInspectedSubagent: () => {},
    setSubagents: () => {},
    restoreInput: vi.fn(),
    notice: vi.fn(),
    commandOutput: vi.fn(),
  } as unknown as TuiService
}

const PNG_1X1 = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zk5sAAAAASUVORK5CYII=',
  'base64',
))

describe('modelStatus', () => {
  it('shows the effective adapter default and prefers an explicit effort', () => {
    const base = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
    const info = {
      reasoning: {
        efforts: [],
        defaultEffort: ReasoningEffortId('high'),
      },
    }
    expect(modelStatus(base, info)).toEqual({ model: 'deepseek-v4-pro', reasoningEffort: 'high' })
    expect(modelStatus({ ...base, reasoningEffort: ReasoningEffortId('max') }, info))
      .toEqual({ model: 'deepseek-v4-pro', reasoningEffort: 'max' })
  })
})

describe('resolveDurableModelSelection', () => {
  it('keeps the latest route of the resumed conversation instead of the global default', () => {
    const fallback = { provider: 'openai-codex', model: 'gpt-5.6-luna' }
    const events = [
      {
        type: 'request/header', seq: 1, time: 1,
        data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } } },
      },
      {
        type: 'request/header', seq: 2, time: 2,
        data: { header: { config: {
          provider: 'openai-codex', model: 'gpt-5.6-sol', reasoningEffort: ReasoningEffortId('xhigh'),
        } } },
      },
    ] as unknown as SessionEvent[]
    expect(resolveDurableModelSelection(events, fallback)).toEqual({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
    })
    expect(resolveDurableModelSelection([], fallback)).toBe(fallback)
  })
})

describe('sessionControls', () => {
  it('projects Harness plan and permission state without inventing defaults', () => {
    expect(sessionControls()).toEqual({})
    expect(sessionControls({
      plan: { active: true, pending: false },
      permissions: { currentValue: 'workspace-write', options: [] },
    })).toEqual({
      plan: { active: true, pending: false },
      permission: 'workspace-write',
    })
  })
})

describe('createSubmissionMessage', () => {
  it('validates every draft image before saving and emits one mixed user message', async () => {
    const calls: string[] = []
    const ref = {
      attachmentId: AttachmentId('attachment:test'),
      mediaType: 'image/png' as const,
      bytes: PNG_1X1.byteLength,
      width: 1,
      height: 1,
      name: 'clipboard.png',
    }
    const attachments = {
      validateImage: async () => { calls.push('validate') },
      saveImage: async () => { calls.push('save'); return ref },
    }

    const message = await createSubmissionMessage({
      text: '[Image #1, 1x1] describe this',
      images: [{ data: PNG_1X1, mediaType: 'image/png', name: 'clipboard.png', width: 1, height: 1 }],
    }, attachments)

    expect(calls).toEqual(['validate', 'save'])
    expect(message.content).toEqual([
      { type: 'text', text: '[Image #1, 1x1] describe this' },
      { type: 'image', attachment: ref },
    ])
  })

  it('rehydrates a durable queued message into an editable mixed draft', async () => {
    const ref = {
      attachmentId: AttachmentId('attachment:queued'),
      mediaType: 'image/png' as const,
      bytes: PNG_1X1.byteLength,
      width: 1,
      height: 1,
      name: 'queued.png',
    }
    const message = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'edit me' }, { type: 'image', attachment: ref }],
    })

    await expect(restoreSubmissionMessage(message, {
      readImage: async () => ({ ref, data: PNG_1X1 }),
    })).resolves.toEqual({
      text: 'edit me',
      images: [{ data: PNG_1X1, mediaType: 'image/png', name: 'queued.png', width: 1, height: 1 }],
    })
  })
})

describe('conversationTurns', () => {
  it('exposes direct human turns with the balanced prefix before each turn', () => {
    const events = [
      { type: 'session/start', data: {} },
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'First question' }] } },
      { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [] } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'user/message', data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: 'Injected context' }] } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [
        { type: 'text', text: 'Second\nquestion' },
        { type: 'image', attachment: {} },
      ] } },
      { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[]

    expect(conversationTurns(events)).toEqual([
      { turn: 1, messageIndex: 2, branchIndex: 1, preview: 'First question', imageCount: 0 },
      { turn: 2, messageIndex: 7, branchIndex: 5, preview: 'Second question', imageCount: 1 },
    ])
  })

  it('ignores human messages without a safe turn boundary', () => {
    const events = [
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'orphan' }] } },
    ] as unknown as SessionEvent[]

    expect(conversationTurns(events)).toEqual([])
  })
})

describe('sessionStats', () => {
  it('folds boundaries and disjoint token usage', () => {
    const events = [
      { type: 'step/start', time: 10, data: { turn: 1, step: 1 } },
      { type: 'assistant/chunk', time: 12, data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'hi' } } },
      { type: 'assistant/message', time: 20, data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3 } } },
      { type: 'step/end', time: 25, data: { turn: 1, step: 1 } },
      { type: 'turn/end', time: 30, data: { turn: 1 } },
    ] as unknown as SessionEvent[]
    expect(sessionStats(events, 100)).toEqual({
      turns: 1,
      steps: 1,
      llmMs: 10,
      toolMs: 0,
      ttftMs: 2,
      ttftSteps: 1,
      decodeMs: 8,
      decodeTokens: 4,
      inputTokens: 13,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
      contextTokens: 17,
      contextWindow: 100,
      elapsedMs: 20,
    })
  })

  it('prefers durable projection values over the fallback fold', () => {
    expect(sessionStats([], undefined, {
      sessionStats: { turns: 2, steps: 5, llmMs: 10, toolMs: 20, ttftMs: 3, ttftSteps: 2, decodeMs: 4, decodeTokens: 8 },
      tokenUsage: { uncachedInputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 5, outputTokens: 7 },
    })).toMatchObject({
      turns: 2,
      steps: 5,
      inputTokens: 105,
      outputTokens: 7,
      cacheReadTokens: 90,
      cacheWriteTokens: 5,
    })
  })

  it('reads only event boundaries when every durable stats projection is available', () => {
    const events = [
      { time: 10 },
      { time: 15 },
      { time: 30 },
    ] as SessionEvent[]
    let reads = 0
    const observed = new Proxy(events, {
      get(target, property, receiver) {
        if (property !== 'length') reads += 1
        return Reflect.get(target, property, receiver)
      },
    })

    expect(sessionStats(observed, undefined, {
      sessionStats: { turns: 2, steps: 5, llmMs: 10, toolMs: 20, ttftMs: 3, ttftSteps: 2, decodeMs: 4, decodeTokens: 8 },
      tokenUsage: { uncachedInputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 5, outputTokens: 7 },
      contextPressure: { projectedTokens: 123, contextWindow: 1_000 },
    })).toMatchObject({
      turns: 2,
      steps: 5,
      contextTokens: 123,
      contextWindow: 1_000,
      elapsedMs: 20,
    })
    expect(reads).toBe(2)
  })
})

describe('recentSessionContent', () => {
  it('does not expose a durable session before it contains a human message', () => {
    const events = [
      { type: 'session/start', data: {} },
      { type: 'user/message', data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: 'Hidden context' }] } },
    ] as unknown as SessionEvent[]

    expect(recentSessionContent(events)).toBeUndefined()
  })

  it('keeps the generated title and previews the latest human message', () => {
    const events = [
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'First question' }] } },
      { type: 'session/title', data: { title: 'Renderer work' } },
      { type: 'user/message', data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: 'Hidden context' }] } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '  Latest\nquestion  ' }] } },
    ] as unknown as SessionEvent[]

    expect(recentSessionContent(events)).toEqual({
      title: 'Renderer work',
      preview: 'Latest question',
    })
  })

  it('does not duplicate a single human message as its own preview', () => {
    const events = [
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Only message' }] } },
    ] as unknown as SessionEvent[]

    expect(recentSessionContent(events)).toEqual({ title: 'Only message' })
  })
})

describe('capability catalogs', () => {
  it('exposes only human-invocable skills as slash commands', () => {
    const base = {
      description: 'Review code', source: 'project-dsh', provider: 'filesystem',
      invocation: { modelInvocable: true, userInvocable: true },
    } as const
    expect(userSkillCommands([
      { ...base, name: 'code-review' },
      { ...base, name: 'hidden', invocation: { modelInvocable: true, userInvocable: false } },
    ])).toEqual([{ name: 'skill:code-review', description: 'Review code' }])
  })

  it('groups MCP tools by server', () => {
    expect(mcpCatalogText([
      { name: 'bash', description: 'shell' },
      { name: 'mcp__github__issues', description: 'List issues' },
      { name: 'mcp__github__pulls', description: 'List pulls' },
      { name: 'mcp__memory__search', description: '' },
    ])).toBe([
      'MCP Servers · 2 connected · 3 tools',
      '',
      '**github · 2 tools**',
      '| Tool | Description |',
      '|---|---|',
      '| `issues` | List issues |',
      '| `pulls` | List pulls |',
      '',
      '**memory · 1 tool**',
      '| Tool | Description |',
      '|---|---|',
      '| `search` | No description provided. |',
    ].join('\n'))
  })
})

describe('encodeComposerImages', () => {
  it('encodes composer drafts as canonical base64 attachments', () => {
    const data = new Uint8Array([1, 2, 3, 4])
    expect(encodeComposerImages([{ data, mediaType: 'image/png', name: 'shot.png' }])).toEqual([
      { data: Buffer.from(data).toString('base64'), mediaType: 'image/png', name: 'shot.png' },
    ])
  })
})

describe('SessionRuntime.refreshRecent', () => {
  it('prefers indexed summaries without inspecting full session logs', async () => {
    const ctx = new Context()
    const indexed = vi.fn(async () => [{ id: 'session-one', title: 'Indexed', createdAt: 1, updatedAt: 2, eventCount: 3 }])
    const inspect = vi.fn()
    ctx.provide('sessionPersistence', {
      omdshRecentSessions: indexed,
      list: vi.fn(async () => []),
      inspect,
    } as never)
    const runtime = new SessionRuntime(ctx, stubTui())

    await runtime.refreshRecent()

    expect(runtime.recentSessions).toEqual([{ id: 'session-one', title: 'Indexed', createdAt: 1, updatedAt: 2, eventCount: 3 }])
    expect(indexed).toHaveBeenCalledWith(8)
    expect(inspect).not.toHaveBeenCalled()
    await runtime.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps every resumable top-level session in the fallback list', async () => {
    const ctx = new Context()
    const headers = Array.from({ length: 12 }, (_, index) => ({
      id: `session-${index}`,
      createdAt: index + 1,
    }))
    ctx.provide('sessionPersistence', {
      list: vi.fn(async () => headers),
      inspect: vi.fn(async (id: string) => ({
        events: [{
          type: 'user/message',
          seq: 1,
          time: Number(id.slice('session-'.length)) + 1,
          data: { source: { kind: 'user' }, content: [{ type: 'text', text: id }] },
        }],
      })),
    } as never)
    const runtime = new SessionRuntime(ctx, stubTui())

    await runtime.refreshAllSessions()

    expect(runtime.recentSessions).toHaveLength(12)
    expect(runtime.recentSessions.map(session => session.id)).toEqual(headers.reverse().map(header => header.id))
    await runtime.dispose()
    await ctx.fiber.dispose()
  })
})

describe('SessionRuntime.execute', () => {
  it('does not treat a handwritten image placeholder as a slash command', async () => {
    const ctx = new Context()
    const runtime = new SessionRuntime(ctx, stubTui())
    await expect(runtime.execute('[Image #1] /goal literal', new AbortController().signal, []))
      .resolves.toBe(false)
    await runtime.dispose()
    await ctx.fiber.dispose()
  })
})

describe('SessionRuntime startup', () => {
  it('publishes only a validated resume target, then hydrates recent, model, and skills in the TUI', async () => {
    let resolveRecent!: (value: unknown[]) => void
    let resolveModel!: (value: unknown) => void
    let resolveSkills!: (value: unknown[]) => void
    const recent = new Promise<unknown[]>(resolve => { resolveRecent = resolve })
    const model = new Promise<unknown>(resolve => { resolveModel = resolve })
    const skills = new Promise<unknown[]>(resolve => { resolveSkills = resolve })
    let configured = false
    const order: string[] = []
    const session = {
      id: SessionId('durable-target'),
      header: { id: SessionId('durable-target'), cwd: '/workspace', createdAt: 1 },
      events: [
        { type: 'request/header', seq: 1, time: 1, data: { header: { config: {
          provider: 'openai-codex', model: 'gpt-5.6-sol', reasoningEffort: ReasoningEffortId('xhigh'),
        } } } },
        { type: 'user/message', seq: 2, time: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'target transcript' }] } },
      ],
      append: vi.fn(),
    }
    const childTools = { presentAs: vi.fn(() => () => {}) }
    const childContext = {
      agent: undefined as unknown,
      get: (name: string) => name === 'agentPresets'
        ? { defaultId: 'standard', mount: async () => { configured = true; return { id: 'standard' } } }
        : name === 'tools' ? childTools : undefined,
      plugin: async () => {},
      on: () => () => {},
    }
    const agent = {
      id: SessionId('durable-target'),
      status: 'idle',
      session,
      ctx: childContext,
    }
    childContext.agent = agent
    const handle = { agent, dispose: vi.fn(async () => {}) }
    const agents = {
      create: vi.fn(),
      resume: vi.fn(async ({ resumeSessionId, setup }) => {
        order.push('resume')
        expect(resumeSessionId).toBe(SessionId('durable-target'))
        await setup(childContext)
        order.push('validated')
        return handle
      }),
      get: vi.fn(),
    }
    const replaceViewportTail = vi.fn(() => { order.push('preview') })
    const replaceSession = vi.fn(() => { order.push('full'); expect(configured).toBe(true) })
    const activateInput = vi.fn(() => { order.push('input'); expect(replaceSession).toHaveBeenCalledOnce() })
    const setCommands = vi.fn()
    const setModel = vi.fn()
    const setSession = vi.fn()
    const tui = {
      ...stubTui(),
      event: vi.fn(),
      activateInput,
      replaceViewportTail,
      setStatus: vi.fn(),
      setModel,
      setLoopStatus: vi.fn(),
      setTools: vi.fn(),
      setCommands,
      replaceSession,
      setSession,
      setTrajectorySource: vi.fn(),
    } as unknown as TuiService
    const services: Record<string, unknown> = {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'v4' }) },
      agents,
      sessions: { list: () => [] },
      agentPresets: {},
      tools: { schemas: () => [{ name: 'bash', description: 'shell' }] },
      commands: { list: () => [{ name: 'help', description: 'help' }] },
      skills: { list: () => skills },
      llm: { resolveModelInfo: () => model },
      sessionPersistence: {
        omdshViewportTail: vi.fn(async () => ({
          id: 'durable-target', revision: 'r1', checkpointSeq: 0, eventCount: 1, events: session.events,
        })),
        omdshRefreshViewportTail: vi.fn(async () => {}),
        list: () => recent,
        inspect: async () => ({ events: session.events }),
      },
    }
    const ctx = {
      agents,
      get: (name: string) => services[name],
      on: () => () => {},
    } as unknown as Context
    const runtime = new SessionRuntime(ctx, tui)

    await runtime.start('durable-target')

    expect(agents.create).not.toHaveBeenCalled()
    expect(replaceViewportTail).toHaveBeenCalledOnce()
    expect(replaceSession).toHaveBeenCalledOnce()
    expect(activateInput).toHaveBeenCalledOnce()
    expect(order).toEqual(['resume', 'preview', 'validated', 'full', 'input'])
    expect(setCommands).toHaveBeenLastCalledWith([{ name: 'help', description: 'help' }])
    expect(setModel).toHaveBeenLastCalledWith('gpt-5.6-sol', 'xhigh')

    resolveRecent([{ id: SessionId('recent'), createdAt: 2, origin: 'user' }])
    resolveModel({ context: { contextWindow: 128_000 }, reasoning: { defaultEffort: ReasoningEffortId('high') } })
    resolveSkills([{
      name: 'review', description: 'Review code', source: 'project-dsh', provider: 'filesystem',
      invocation: { modelInvocable: true, userInvocable: true },
    }])
    await runtime.whenHydrated()

    expect(setModel).toHaveBeenLastCalledWith('gpt-5.6-sol', 'xhigh')
    expect(setCommands).toHaveBeenLastCalledWith([
      { name: 'help', description: 'help' },
      { name: 'skill:review', description: 'Review code' },
    ])
    expect(setSession.mock.calls.at(-1)?.[0].recent).toEqual([{ id: SessionId('recent'), title: 'target transcript', createdAt: 2, updatedAt: 2, eventCount: 2 }])
    await runtime.dispose()
  })
})
