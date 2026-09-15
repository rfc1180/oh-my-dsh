import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { steeringNoteText } from '../runtime/steering-note.ts'
import { steer } from './steer.ts'

function invocation(rawInput: string, status: Agent['status']): {
  value: CommandInvocation
  steerAgent: ReturnType<typeof vi.fn>
} {
  const steerAgent = vi.fn()
  return {
    value: {
      rawInput,
      agent: { status, steer: steerAgent } as unknown as Agent,
    } as CommandInvocation,
    steerAgent,
  }
}

describe('/steer', () => {
  it('queues a continuation note instead of a new direct-human task prompt', () => {
    const { value, steerAgent } = invocation('  also check mobile  ', 'running')

    expect(steer(value)).toEqual({
      kind: 'success',
      text: 'Continuation note queued for the next model step. Tools already running are not interrupted.',
    })
    expect(steerAgent).toHaveBeenCalledOnce()
    const message = steerAgent.mock.calls[0]?.[0]
    expect(message.source.kind).toBe('plugin')
    expect(steeringNoteText(message)).toBe('also check mobile')
  })

  it('rejects empty notes and idle sessions', () => {
    const empty = invocation('   ', 'running')
    expect(steer(empty.value)).toEqual({ kind: 'error', text: 'Usage: /steer <note>' })
    expect(empty.steerAgent).not.toHaveBeenCalled()

    const idle = invocation('remember this', 'idle')
    expect(steer(idle.value)).toEqual({
      kind: 'error',
      text: 'A continuation note needs active work. Send a normal message to start the next task.',
    })
    expect(idle.steerAgent).not.toHaveBeenCalled()
  })
})
