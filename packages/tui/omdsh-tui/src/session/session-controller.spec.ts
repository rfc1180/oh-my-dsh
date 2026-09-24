import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ReasoningEffortId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { mcpCatalogText } from '../commands/integrations.ts'
import type { TuiService } from '../definition.ts'
import type { CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import {
  conversationTurns,
  createSubmissionMessage,
  cumulativeQueuedFollowup,
  encodeComposerImages,
  modelStatus,
  recentSessionContent,
  recentSessionStatus,
  remoteTranscriptTail,
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

describe('remoteTranscriptTail', () => {
  const event = (seq: number, type: string, data: unknown): SessionEvent => ({
    type, seq, time: seq, data,
  }) as SessionEvent

  it('compacts 1500 completed chunks only when the authoritative message preserves their content', () => {
    const streamed = Array.from({ length: 1_500 }, (_, offset) => event(offset + 2, 'assistant/chunk', {
      turn: 1, step: 1, chunk: { type: 'text-delta', text: 'x' },
    }))
    const events = [
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'question' }] }),
      ...streamed,
      event(1_502, 'assistant/message', {
        turn: 1, step: 1, message: { content: [{ type: 'text', text: 'x'.repeat(1_500) }] },
      }),
      event(1_503, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]

    const tail = remoteTranscriptTail(events)
    expect(tail.map(candidate => candidate.type)).toEqual([
      'turn/start', 'user/message', 'assistant/message', 'turn/end',
    ])
    expect(events).toHaveLength(1_504)
  })

  it('keeps an active incomplete turn as an explicit bounded partial suffix', () => {
    const events = [
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'active' }] }),
      ...Array.from({ length: 1_500 }, (_, offset) => event(offset + 2, 'assistant/chunk', {
        turn: 1, step: 1, chunk: { type: 'text-delta', text: 'x' },
      })),
    ]
    const tail = remoteTranscriptTail(events)
    expect(tail).toHaveLength(1_024)
    expect(tail[0]?.type).toBe('assistant/chunk')
    expect(tail[0]?.seq).toBe(478)
    expect(tail.at(-1)?.seq).toBe(1_501)
  })

  it('applies the byte guard without splitting or retaining an oversized event', () => {
    const events = [
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'x'.repeat(700) } }),
      event(2, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'y'.repeat(700) } }),
    ]
    const tail = remoteTranscriptTail(events, 1_024, 1_000)
    expect(tail).toHaveLength(1)
    expect(tail[0]?.seq).toBe(2)
    expect(remoteTranscriptTail([event(3, 'assistant/chunk', {
      turn: 1, step: 1, chunk: { type: 'text-delta', text: 'z'.repeat(2_000) },
    })], 1_024, 1_000)).toEqual([])
    expect(() => remoteTranscriptTail(events, 1_024, 0)).toThrow('positive integer')
  })

  it('does not discard chunks when the settled message differs', () => {
    const events = [
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'question' }] }),
      event(2, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'draft' } }),
      event(3, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'final' }] } }),
      event(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    expect(remoteTranscriptTail(events, 10).map(candidate => candidate.type)).toEqual([
      'turn/start', 'user/message', 'assistant/chunk', 'assistant/message', 'turn/end',
    ])
    expect(remoteTranscriptTail(events, 2).map(candidate => candidate.type)).toEqual([
      'assistant/message', 'turn/end',
    ])
    expect(() => remoteTranscriptTail(events, 0)).toThrow('positive integer')
  })
})

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

describe('cumulativeQueuedFollowup', () => {
  const message = (text: string): UserMessage => createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  })

  it('collapses the growing snapshots produced by an unbracketed multiline paste', () => {
    expect(cumulativeQueuedFollowup(
      message('3. Universal and factual'),
      message('3. Universal and factual  Levels 1-2 are architecture.'),
    )).toBe(true)
  })

  it('keeps independent follow-ups and messages with attachments separate', () => {
    expect(cumulativeQueuedFollowup(message('first request'), message('another request'))).toBe(false)
    expect(cumulativeQueuedFollowup(message('longer request'), message('longer'))).toBe(false)
    expect(cumulativeQueuedFollowup(message('same request'), createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'same request plus image' }, { type: 'image', attachment: {
        attachmentId: AttachmentId('attachment:queued'),
        mediaType: 'image/png',
        bytes: PNG_1X1.byteLength,
        width: 1,
        height: 1,
      } }],
    }))).toBe(false)
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
      uncachedInputTokens: 10,
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
      uncachedInputTokens: 10,
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

describe('recentSessionStatus', () => {
  it('treats a newer open turn as interrupted even when the bounded tail contains an older completed turn', () => {
    const events = [
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', data: { turn: 2 } },
    ] as unknown as SessionEvent[]

    expect(recentSessionStatus(events)).toBe('interrupted')
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
    ])).toEqual([{ name: 'code-review', description: 'Review code', kind: 'skill' }])
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

  it('loads the complete indexed catalog without inspecting session logs', async () => {
    const ctx = new Context()
    const catalog = Array.from({ length: 12 }, (_, index) => ({
      id: `session-${index}`,
      title: `Session ${index}`,
      createdAt: 12 - index,
      updatedAt: 12 - index,
      eventCount: index,
    }))
    const indexed = vi.fn(async () => catalog)
    const inspect = vi.fn()
    ctx.provide('sessionPersistence', {
      omdshSessionCatalog: indexed,
      list: vi.fn(async () => []),
      inspect,
    } as never)
    const runtime = new SessionRuntime(ctx, stubTui())

    await runtime.refreshAllSessions()

    expect(runtime.recentSessions).toEqual(catalog)
    expect(indexed).toHaveBeenCalledOnce()
    expect(inspect).not.toHaveBeenCalled()
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

describe('SessionRuntime.createDetachedFork', () => {
  function detachedForkRuntime(status: 'idle' | 'running' = 'idle') {
    const parentEvents = [
      { type: 'session/start', seq: 0, time: 1, data: {} },
      { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
      { type: 'user/message', seq: 2, time: 3, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'question' }] } },
      { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[]
    if (status === 'running') {
      parentEvents.push(
        { type: 'turn/start', seq: 4, time: 5, data: { turn: 2 } } as SessionEvent,
        { type: 'user/message', seq: 5, time: 6, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'active task' }] } } as SessionEvent,
        { type: 'assistant/message', seq: 6, time: 7, data: { content: [{ type: 'text', text: 'partial answer' }] } } as SessionEvent,
      )
    }
    const parentSession = {
      id: SessionId('parent-session'),
      header: { id: SessionId('parent-session'), cwd: '/workspace', createdAt: 1 },
      events: parentEvents,
      append: vi.fn(),
    }
    const presentationDisposers: Array<ReturnType<typeof vi.fn>> = []
    const agentContext = (agent: unknown) => ({
      agent,
      get: (name: string) => name === 'agentPresets'
        ? { defaultId: 'standard', mount: async () => ({ id: 'reviewer' }) }
        : name === 'tools' ? {
            presentAs: vi.fn(() => {
              const dispose = vi.fn()
              presentationDisposers.push(dispose)
              return dispose
            }),
          } : undefined,
      plugin: async () => {},
      on: () => () => {},
    })
    const parent = {
      id: SessionId('parent-session'),
      status,
      session: parentSession,
      ctx: undefined as unknown,
    }
    parent.ctx = agentContext(parent)
    const parentHandle = { agent: parent, dispose: vi.fn(async () => {}) }
    let createOptions: CreateAgentOptions | undefined
    let beforeCommit = () => {}
    const childDispose = vi.fn(async () => {})
    const agents = {
      resume: vi.fn(async (options: ResumeAgentOptions) => {
        await options.setup?.(parent.ctx as Context)
        return parentHandle
      }),
      create: vi.fn(async (options: CreateAgentOptions) => {
        createOptions = options
        const session = {
          id: options.sessionId,
          header: { id: options.sessionId, createdAt: 5, ...options.meta },
          events: [...(options.seed ?? [])],
          append: vi.fn(),
        }
        const child = { id: options.sessionId, status: 'idle', session, ctx: undefined as unknown }
        child.ctx = agentContext(child)
        const commit = await options.setup?.(child.ctx as Context)
        beforeCommit()
        commit?.commit()
        return { agent: child, dispose: childDispose }
      }),
      get: vi.fn(),
    }
    const replaceSession = vi.fn()
    const activateInput = vi.fn()
    const tui = {
      ...stubTui(),
      event: vi.fn(),
      setStatus: vi.fn(),
      setModel: vi.fn(),
      setLoopStatus: vi.fn(),
      setTools: vi.fn(),
      setCommands: vi.fn(),
      replaceSession,
      setSession: vi.fn(),
      setTrajectorySource: vi.fn(),
      activateInput,
    } as unknown as TuiService
    const sessionPersistence = {
      list: async () => [],
      inspect: vi.fn(),
      omdshProjectSessionHistory: vi.fn(async (id: string) => ({
        version: 1 as const,
        sessionId: id,
        title: id,
        createdAt: 1,
        updatedAt: 6,
        classification: { bucket: 'human' as const },
        interactions: [1, 3, 5].map(seq => ({
          id: `event:${seq}`,
          input: {
            kind: 'input' as const,
            content: { format: 'markdown' as const, text: `prompt ${seq}` },
            ref: { seq, time: seq, type: 'user/message' },
          },
          outcome: { kind: 'completed' as const },
          technicalTrace: [],
        })),
      })),
    }
    const services: Record<string, unknown> = {
      agentDefaultModel: { currentSelection: () => ({ provider: 'openai-codex', model: 'gpt-5.6-sol' }) },
      agents,
      sessions: { list: () => [] },
      tools: { schemas: () => [] },
      sessionPersistence,
    }
    const ctx = {
      agents,
      get: (name: string) => services[name],
      on: () => () => {},
    } as unknown as Context
    const runtime = new SessionRuntime(ctx, tui)
    return {
      runtime,
      parent,
      parentEvents,
      agents,
      childDispose,
      presentationDisposers,
      replaceSession,
      activateInput,
      tui,
      sessionPersistence,
      createOptions: () => createOptions,
      beforeCommit: (callback: () => void) => { beforeCommit = callback },
    }
  }

  it('durably publishes the complete immutable conversation without activating or prompting the child', async () => {
    const fixture = detachedForkRuntime()
    await fixture.runtime.start('parent-session')
    const transcriptCalls = fixture.replaceSession.mock.calls.length
    const inputCalls = fixture.activateInput.mock.calls.length

    const result = await fixture.runtime.createDetachedFork()
    const options = fixture.createOptions()

    expect(result).toEqual({
      childSessionId: expect.stringMatching(/^session-/),
      parentSessionId: SessionId('parent-session'),
      cwd: '/workspace',
      seedLength: fixture.parentEvents.length,
    })
    expect(options?.seed).toEqual(fixture.parentEvents)
    expect(options?.seed).not.toBe(fixture.parentEvents)
    expect(Object.isFrozen(options?.seed)).toBe(true)
    expect(options?.meta).toEqual({
      cwd: '/workspace',
      parentSession: SessionId('parent-session'),
      seedLength: fixture.parentEvents.length,
      agentPreset: 'reviewer',
    })
    expect(options?.agentOptions).toEqual({ provider: 'openai-codex', model: 'gpt-5.6-sol' })
    expect(fixture.childDispose).toHaveBeenCalledOnce()
    expect(fixture.presentationDisposers.at(-1)).toHaveBeenCalledOnce()
    expect(fixture.runtime.agent).toBe(fixture.parent)
    expect(fixture.replaceSession).toHaveBeenCalledTimes(transcriptCalls)
    expect(fixture.activateInput).toHaveBeenCalledTimes(inputCalls)
    expect(fixture.tui.restoreInput).not.toHaveBeenCalled()
    await fixture.runtime.dispose()
  })

  it('refuses publication when the parent journal changes during child setup', async () => {
    const fixture = detachedForkRuntime()
    await fixture.runtime.start('parent-session')
    fixture.beforeCommit(() => {
      fixture.parentEvents.push({ type: 'session/title', seq: 4, time: 5, data: { title: 'changed' } } as SessionEvent)
    })

    await expect(fixture.runtime.createDetachedFork()).rejects.toThrow(
      'The active conversation changed before the fork was published.',
    )
    expect(fixture.childDispose).not.toHaveBeenCalled()
    expect(fixture.presentationDisposers.at(-1)).toHaveBeenCalledOnce()
    expect(fixture.runtime.agent).toBe(fixture.parent)
    await fixture.runtime.dispose()
  })

  it('forks a running conversation from the last completed response by default', async () => {
    const fixture = detachedForkRuntime('running')
    await fixture.runtime.start('parent-session')

    const result = await fixture.runtime.createDetachedFork()

    expect(fixture.createOptions()?.seed).toEqual(fixture.parentEvents.slice(0, 4))
    expect(result.seedLength).toBe(4)
    expect(fixture.runtime.agent).toBe(fixture.parent)
    await fixture.runtime.dispose()
  })

  it('can retain only the current human task from a running turn', async () => {
    const fixture = detachedForkRuntime('running')
    await fixture.runtime.start('parent-session')
    fixture.beforeCommit(() => {
      fixture.parentEvents.push({ type: 'assistant/chunk', seq: 7, time: 8, data: { content: 'later output' } } as SessionEvent)
    })

    const result = await fixture.runtime.createDetachedFork(undefined, 'current-task')
    const seed = fixture.createOptions()?.seed

    expect(seed).toHaveLength(5)
    expect(seed?.slice(0, 4)).toEqual(fixture.parentEvents.slice(0, 4))
    expect(seed?.at(-1)).toMatchObject({
      type: 'user/message',
      seq: 4,
      surfaceOp: 'append',
      data: { content: [{ type: 'text', text: 'active task' }] },
    })
    expect(seed?.at(-1)).not.toHaveProperty('sourceEventSeqs')
    expect(seed?.some(event => event.type === 'assistant/message' || event.type === 'assistant/chunk')).toBe(false)
    expect(result.seedLength).toBe(5)
    await fixture.runtime.dispose()
  })

  it('uses opaque exclusive history cursors and rejects malformed or cross-session reuse', async () => {
    const fixture = detachedForkRuntime()
    await fixture.runtime.start('parent-session')
    const source = fixture.runtime.sessionManagerSource(fixture.parent)

    const first = await source.historyPage?.({ id: 'parent-session', limit: 2 })
    expect(first?.interactions.map(row => row.id)).toEqual(['event:3', 'event:5'])
    expect(first?.previousCursor).toMatch(/^[0-9a-f-]{36}$/u)
    expect(first?.previousCursor).not.toContain('parent-session')

    const second = await source.historyPage?.({
      id: 'parent-session',
      cursor: first?.previousCursor,
      limit: 2,
    })
    expect(second?.interactions.map(row => row.id)).toEqual(['event:1'])
    const projectionCalls = fixture.sessionPersistence.omdshProjectSessionHistory.mock.calls.length
    await expect(source.historyPage?.({
      id: 'parent-session',
      cursor: 'history-v1:parent-session:3',
    })).rejects.toThrow('Malformed or expired')
    await expect(source.historyPage?.({
      id: 'another-session',
      cursor: first?.previousCursor,
    })).rejects.toThrow('belongs to another session')
    expect(fixture.sessionPersistence.omdshProjectSessionHistory).toHaveBeenCalledTimes(projectionCalls)
    await fixture.runtime.dispose()
  })

  it('pages 205 interactions in exact 100-row windows without gaps or duplicates', async () => {
    const fixture = detachedForkRuntime()
    fixture.sessionPersistence.omdshProjectSessionHistory.mockImplementation(async (id: string) => ({
      version: 1 as const,
      sessionId: id,
      title: id,
      createdAt: 1,
      updatedAt: 205,
      classification: { bucket: 'human' as const },
      interactions: Array.from({ length: 205 }, (_, seq) => ({
        id: `event:${seq}`,
        input: {
          kind: 'input' as const,
          content: { format: 'markdown' as const, text: `prompt ${seq}` },
          ref: { seq, time: seq, type: 'user/message' },
        },
        outcome: { kind: 'completed' as const },
        technicalTrace: [],
      })),
    }))
    await fixture.runtime.start('parent-session')
    const source = fixture.runtime.sessionManagerSource(fixture.parent)
    const seen: string[] = []
    let cursor: string | undefined
    const sizes: number[] = []
    do {
      const page = await source.historyPage?.({ id: 'parent-session', cursor, limit: 100 })
      expect(page).toBeDefined()
      sizes.push(page!.interactions.length)
      seen.unshift(...page!.interactions.map(row => row.id))
      cursor = page!.previousCursor
    } while (cursor !== undefined)

    expect(sizes).toEqual([100, 100, 5])
    expect(seen).toEqual(Array.from({ length: 205 }, (_, seq) => `event:${seq}`))
    expect(new Set(seen)).toHaveLength(205)
    await fixture.runtime.dispose()
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
    const setActiveTranscriptSource = vi.fn()
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
      setActiveTranscriptSource,
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
    expect(replaceViewportTail).toHaveBeenCalledWith(session.events, 1)
    expect(replaceSession).toHaveBeenCalledOnce()
    expect(replaceSession.mock.calls[0]?.[0]).toBe(session.events)
    expect(activateInput).toHaveBeenCalledOnce()
    expect(order).toEqual(['resume', 'preview', 'validated', 'full', 'input'])
    expect(setCommands).toHaveBeenLastCalledWith([{ name: 'help', description: 'help' }])
    expect(setModel).toHaveBeenLastCalledWith('gpt-5.6-sol', 'xhigh')
    expect(setActiveTranscriptSource).toHaveBeenCalledWith(expect.objectContaining({
      activeSessionId: 'durable-target',
      request: expect.any(Function),
    }))

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
      { name: 'review', description: 'Review code', kind: 'skill' },
    ])
    expect(setSession.mock.calls.at(-1)?.[0].recent).toEqual([{ id: SessionId('recent'), title: 'target transcript', createdAt: 2, updatedAt: 2, eventCount: 2 }])
    await runtime.dispose()
    expect(setActiveTranscriptSource).toHaveBeenLastCalledWith()
  })
})
