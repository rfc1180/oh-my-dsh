/** Steering command registered through dsh-commands. */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import {
  createSteeringContinuationMessage,
  createSteeringNoteMessage,
  needsSteeringContinuation,
} from '../runtime/steering-note.ts'
import { registerCommands } from './registration.ts'

export const name = 'omdsh-command-steer'
export const inject = ['commands']

function hasOpenTurn(invocation: CommandInvocation): boolean {
  const boundary = invocation.agent.session.events.findLast(event => (
    event.type === 'turn/start' || event.type === 'turn/end'
  ))
  return boundary?.type === 'turn/start'
}

export function steer(invocation: CommandInvocation): CommandResult {
  const input = invocation.rawInput.trim()
  if (input === '') return { kind: 'error', text: 'Usage: /steer <note>' }
  if (invocation.agent.status !== 'running' || !hasOpenTurn(invocation)) {
    return {
      kind: 'error',
      text: 'A continuation note needs an open active turn. Send a normal message to start the next task.',
    }
  }
  invocation.agent.steer(createSteeringNoteMessage(input))
  return {
    kind: 'success',
    text: 'Continuation note queued for the next model step. Tools already running are not interrupted.',
  }
}

export function apply(ctx: Context): void {
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (needsSteeringContinuation(agent.session.events, turn)) {
      agent.steer(createSteeringContinuationMessage())
    }
  })
  registerCommands(ctx, [
    { name: 'steer', description: 'Add a note to the active task without replacing it', input: { hint: '<note>' }, handler: steer },
  ], 'omdsh steering commands')
}
