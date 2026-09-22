import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TuiService } from '../definition.ts'
import { SessionRuntime } from './session-controller.ts'

type Listener = (...args: unknown[]) => void

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function runtimeFixture(options: {
  skills?: () => Promise<unknown[]>
  customPresentation?: boolean
} = {}) {
  const listeners = new Map<string, Set<Listener>>()
  const on = vi.fn((name: string, listener: Listener) => {
    let group = listeners.get(name)
    if (group === undefined) {
      group = new Set()
      listeners.set(name, group)
    }
    group.add(listener)
    return () => { group?.delete(listener) }
  })
  const emit = (name: string, ...args: unknown[]) => {
    for (const listener of listeners.get(name) ?? []) listener(...args)
  }

  let inspectedAgent: Agent | undefined
  let inspectSubagent: ((id: string) => void) | undefined
  let schemas = [{
    name: 'bash',
    description: 'shell',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  }]
  let definition = { presentCall: (() => undefined) as unknown, presentResult: (() => undefined) as unknown }
  let inspectedDefinition = { presentCall: (() => undefined) as unknown, presentResult: (() => undefined) as unknown }
  const tools = {
    schemas: vi.fn(() => schemas),
    get: vi.fn(() => definition),
  }
  const bridge = options.customPresentation
    ? { event: vi.fn(), session: vi.fn(() => new Map()) }
    : {
        event: vi.fn(),
        session: vi.fn(() => new Map()),
        catalogIdentity: vi.fn((agent: Agent, names: readonly string[]) => {
          const effective = agent === inspectedAgent ? inspectedDefinition : definition
          return [
            bridge,
            ...names.flatMap(name => [name, effective, effective.presentCall, effective.presentResult]),
          ]
        }),
      }

  const session = {
    id: SessionId('catalog-session'),
    header: { id: SessionId('catalog-session'), cwd: '/workspace', createdAt: 1 },
    events: [],
    append: vi.fn(),
  }
  const childTools = { presentAs: vi.fn(() => () => {}) }
  const childContext = {
    agent: undefined as unknown as Agent,
    get: (name: string) => name === 'agentPresets'
      ? { defaultId: 'standard', mount: async () => ({ id: 'standard' }) }
      : name === 'tools' ? childTools : undefined,
    plugin: async () => {},
    on: () => () => {},
  }
  const agent = { id: session.id, status: 'idle', session, ctx: childContext } as unknown as Agent
  childContext.agent = agent
  const inspectedSession = {
    id: SessionId('catalog-child'),
    header: { id: SessionId('catalog-child'), parentSession: session.id, origin: 'subagent', cwd: '/workspace', createdAt: 2 },
    events: [],
    append: vi.fn(),
  }
  inspectedAgent = {
    id: inspectedSession.id,
    status: 'idle',
    session: inspectedSession,
    ctx: childContext,
  } as unknown as Agent
  const handle = { agent, dispose: vi.fn(async () => {}) }
  const agents = {
    create: vi.fn(async ({ setup }) => {
      await setup?.(childContext as unknown as Context)
      return handle
    }),
    get: vi.fn((id: SessionId) => id === inspectedSession.id ? inspectedAgent : undefined),
  }
  const commands = { list: vi.fn(() => [{ name: 'help', description: 'help' }]) }
  const services: Record<string, unknown> = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'v4' }) },
    agentPresets: { resolve: async () => ({ id: 'standard' }) },
    agents,
    sessions: {
      list: () => [inspectedSession],
      get: (id: SessionId) => id === inspectedSession.id ? inspectedSession : undefined,
    },
    commands,
    tools,
    tuiToolPresentation: bridge,
    ...(options.skills === undefined ? {} : { skills: { list: options.skills } }),
  }
  const ctx = {
    agents,
    agentPresets: services.agentPresets,
    get: (name: string) => services[name],
    on,
  } as unknown as Context
  const tui = {
    activateInput: vi.fn(),
    replaceViewportTail: vi.fn(),
    onInspectSubagent: (listener: (id: string) => void) => {
      inspectSubagent = listener
      return () => { inspectSubagent = undefined }
    },
    onInspectClose: () => () => {},
    onInspectSubmit: () => () => {},
    setSessionSearch: vi.fn(),
    setFileSearch: vi.fn(),
    setImageValidator: vi.fn(),
    setInspectedSubagent: vi.fn(),
    setSubagents: vi.fn(),
    setActiveTranscriptSource: vi.fn(),
    setStatus: vi.fn(),
    setModel: vi.fn(),
    setLoopStatus: vi.fn(),
    setTools: vi.fn(),
    setCommands: vi.fn(),
    replaceSession: vi.fn(),
    setSession: vi.fn(),
    setTrajectorySource: vi.fn(),
    event: vi.fn(),
    notice: vi.fn(),
    restoreInput: vi.fn(),
    commandOutput: vi.fn(),
  } as unknown as TuiService
  const runtime = new SessionRuntime(ctx, tui)
  return {
    runtime,
    tui,
    emit,
    commands,
    setSchemas: (next: typeof schemas) => { schemas = next },
    setPresentCall: (next: unknown) => { definition = { ...definition, presentCall: next } },
    setInspectedPresentCall: (next: unknown) => { inspectedDefinition = { ...inspectedDefinition, presentCall: next } },
    inspect: () => { inspectSubagent?.(String(inspectedSession.id)) },
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('SessionRuntime catalog refresh', () => {
  it('rejects stale skill promises and semantically deduplicates the winning command result', async () => {
    const oldSkills = deferred<unknown[]>()
    const newSkills = deferred<unknown[]>()
    const list = vi.fn()
      .mockImplementationOnce(() => oldSkills.promise)
      .mockImplementationOnce(() => newSkills.promise)
      .mockResolvedValue([{
        name: 'new-skill', description: 'new', source: 'project-dsh', provider: 'filesystem',
        invocation: { modelInvocable: true, userInvocable: true },
      }])
    const fixture = runtimeFixture({ skills: list })
    await fixture.runtime.start()

    fixture.emit('skills/change')
    await flushMicrotasks()
    newSkills.resolve([{
      name: 'new-skill', description: 'new', source: 'project-dsh', provider: 'filesystem',
      invocation: { modelInvocable: true, userInvocable: true },
    }])
    await flushMicrotasks()
    const callsAfterWinner = vi.mocked(fixture.tui.setCommands).mock.calls.length

    oldSkills.resolve([{
      name: 'old-skill', description: 'old', source: 'project-dsh', provider: 'filesystem',
      invocation: { modelInvocable: true, userInvocable: true },
    }])
    await fixture.runtime.whenHydrated()
    expect(fixture.tui.setCommands).toHaveBeenLastCalledWith([
      { name: 'help', description: 'help' },
      { name: 'new-skill', description: 'new', kind: 'skill' },
    ])

    fixture.emit('skills/change')
    fixture.emit('commands/change')
    await flushMicrotasks()
    await flushMicrotasks()
    expect(fixture.tui.setCommands).toHaveBeenCalledTimes(callsAfterWinner)
    await fixture.runtime.dispose()
  })

  it('deduplicates tool rows but rebuilds replay for schema or presenter changes', async () => {
    const fixture = runtimeFixture()
    await fixture.runtime.start()
    await fixture.runtime.whenHydrated()
    const initialRows = vi.mocked(fixture.tui.setTools).mock.calls.length
    const initialReplay = vi.mocked(fixture.tui.replaceSession).mock.calls.length

    fixture.setSchemas([{
      description: 'shell',
      name: 'bash',
      parameters: { required: ['command'], properties: { command: { type: 'string' } }, type: 'object' },
    }])
    fixture.emit('tools/change')
    fixture.emit('tools/change')
    await flushMicrotasks()
    expect(fixture.tui.setTools).toHaveBeenCalledTimes(initialRows)
    expect(fixture.tui.replaceSession).toHaveBeenCalledTimes(initialReplay)

    fixture.setSchemas([{
      name: 'bash',
      description: 'shell',
      parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'] },
    }])
    fixture.emit('tools/change')
    await flushMicrotasks()
    expect(fixture.tui.setTools).toHaveBeenCalledTimes(initialRows)
    expect(fixture.tui.replaceSession).toHaveBeenCalledTimes(initialReplay + 1)

    fixture.setPresentCall(() => undefined)
    fixture.emit('tools/change')
    await flushMicrotasks()
    expect(fixture.tui.setTools).toHaveBeenCalledTimes(initialRows)
    expect(fixture.tui.replaceSession).toHaveBeenCalledTimes(initialReplay + 2)
    await fixture.runtime.dispose()
  })

  it('rebuilds an inspected child when only its scoped presenter changes', async () => {
    const fixture = runtimeFixture()
    await fixture.runtime.start()
    await fixture.runtime.whenHydrated()
    fixture.inspect()
    await flushMicrotasks()
    const initialReplay = vi.mocked(fixture.tui.replaceSession).mock.calls.length

    fixture.setInspectedPresentCall(() => undefined)
    fixture.emit('tools/change')
    await flushMicrotasks()
    expect(fixture.tui.replaceSession).toHaveBeenCalledTimes(initialReplay + 1)

    fixture.emit('tools/change')
    await flushMicrotasks()
    expect(fixture.tui.replaceSession).toHaveBeenCalledTimes(initialReplay + 1)
    await fixture.runtime.dispose()
  })

  it('fails safe and rebuilds replay when presenter identity cannot be proven', async () => {
    const fixture = runtimeFixture({ customPresentation: true })
    await fixture.runtime.start()
    await fixture.runtime.whenHydrated()
    const initialReplay = vi.mocked(fixture.tui.replaceSession).mock.calls.length

    fixture.emit('tools/change')
    await flushMicrotasks()
    expect(fixture.tui.replaceSession).toHaveBeenCalledTimes(initialReplay + 1)
    await fixture.runtime.dispose()
  })
})
