/** Harness ToolDefinition presentation bridge for live events and replay. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type { TuiToolPresentation } from '../chrome/tool-renderers.ts'

export const name = 'omdsh-tool-presentation'
export const inject = ['tools']

export interface ToolPresentationBridge {
  event(agent: Agent, event: SessionEvent): TuiToolPresentation | undefined
  session(agent: Agent, events: readonly SessionEvent[]): ReadonlyMap<number, TuiToolPresentation>
  /** Stable references that fully describe tool-owned replay presentation, when provable. */
  catalogIdentity?(agent: Agent, names: readonly string[]): readonly unknown[] | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Resolves tool-owned provider-neutral presentation for the active Agent scope. */
    tuiToolPresentation: ToolPresentationBridge
  }
}

function parsedArguments(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

class HarnessToolPresentation implements ToolPresentationBridge {
  readonly #ctx: Context

  constructor(ctx: Context) {
    this.#ctx = ctx
  }

  event(agent: Agent, event: SessionEvent): TuiToolPresentation | undefined {
    if (event.type === 'tool/call') {
      const definition = this.#ctx.tools.get(event.data.name, agent)
      if (definition?.presentCall === undefined) return undefined
      try {
        const call = definition.presentCall(parsedArguments(event.data.arguments))
        return call === undefined ? undefined : { call }
      } catch {
        return undefined
      }
    }
    if (event.type !== 'tool/result') return undefined
    const callId = event.data.message.source.callId
    const callEvent = agent.session.events.findLast(candidate =>
      candidate.type === 'tool/call' && candidate.data.callId === callId)
    if (callEvent?.type !== 'tool/call') return undefined
    const definition = this.#ctx.tools.get(callEvent.data.name, agent)
    const args = parsedArguments(callEvent.data.arguments)
    let call
    let result
    try {
      call = definition?.presentCall?.(args)
    } catch {
      call = undefined
    }
    try {
      const block = event.data.message.content[0]
      result = definition?.presentResult?.(args, {
        content: block.content,
        isError: block.isError === true,
        ...(event.data.meta === undefined ? {} : { meta: event.data.meta }),
      })
    } catch {
      result = undefined
    }
    return call === undefined && result === undefined ? undefined : {
      ...(call === undefined ? {} : { call }),
      ...(result === undefined ? {} : { result }),
    }
  }

  catalogIdentity(agent: Agent, names: readonly string[]): readonly unknown[] | undefined {
    try {
      const identity: unknown[] = [this]
      for (const name of names) {
        const definition = this.#ctx.tools.get(name, agent)
        identity.push(name, definition?.presentCall, definition?.presentResult)
      }
      return identity
    } catch {
      return undefined
    }
  }

  session(agent: Agent, events: readonly SessionEvent[]): ReadonlyMap<number, TuiToolPresentation> {
    const callsById = new Map<string, Extract<SessionEvent, { type: 'tool/call' }>>()
    const unresolvedCallIds = new Set(events.flatMap(event =>
      event.type === 'tool/result' ? [event.data.message.source.callId] : []))
    const sessionEvents = agent.session.events
    for (let index = sessionEvents.length - 1; index >= 0 && unresolvedCallIds.size > 0; index -= 1) {
      const event = sessionEvents[index]
      if (event?.type === 'tool/call' && unresolvedCallIds.delete(event.data.callId)) {
        callsById.set(event.data.callId, event)
      }
    }

    type ToolDefinition = ReturnType<Context['tools']['get']>
    const definitions = new Map<string, ToolDefinition>()
    const definitionFor = (name: string): ToolDefinition => {
      if (definitions.has(name)) return definitions.get(name)
      const definition = this.#ctx.tools.get(name, agent)
      definitions.set(name, definition)
      return definition
    }

    const presentations = new Map<number, TuiToolPresentation>()
    for (const event of events) {
      if (event.type === 'tool/call') {
        const definition = definitionFor(event.data.name)
        if (definition?.presentCall === undefined) continue
        try {
          const call = definition.presentCall(parsedArguments(event.data.arguments))
          if (call !== undefined) presentations.set(event.seq, { call })
        } catch {
          // A tool-owned presenter must not break replay.
        }
        continue
      }
      if (event.type !== 'tool/result') continue

      const callEvent = callsById.get(event.data.message.source.callId)
      if (callEvent === undefined) continue
      const definition = definitionFor(callEvent.data.name)
      const args = parsedArguments(callEvent.data.arguments)
      let call
      let result
      try {
        call = definition?.presentCall?.(args)
      } catch {
        call = undefined
      }
      try {
        const block = event.data.message.content[0]
        result = definition?.presentResult?.(args, {
          content: block.content,
          isError: block.isError === true,
          ...(event.data.meta === undefined ? {} : { meta: event.data.meta }),
        })
      } catch {
        result = undefined
      }
      if (call !== undefined || result !== undefined) {
        presentations.set(event.seq, {
          ...(call === undefined ? {} : { call }),
          ...(result === undefined ? {} : { result }),
        })
      }
    }
    return presentations
  }
}

/** Construct the bridge for tests and non-Cordis embedding. */
export function createToolPresentationBridge(ctx: Context): ToolPresentationBridge {
  return new HarnessToolPresentation(ctx)
}

export function apply(ctx: Context): void {
  ctx.provide('tuiToolPresentation', createToolPresentationBridge(ctx))
}
