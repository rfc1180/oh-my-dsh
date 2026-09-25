/** Session token-cost summary command registered through dsh-commands. */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { formatCostSummary, summarizeCost } from '../session/cost-summary.ts'
import { registerCommands } from './registration.ts'

export const name = 'omdsh-command-cost'
export const inject = ['commands']

function showCost(invocation: CommandInvocation): CommandResult {
  return { kind: 'success', text: formatCostSummary(summarizeCost(invocation.agent.session.events)) }
}

export function apply(ctx: Context): void {
  registerCommands(ctx, [
    {
      name: 'cost',
      description: 'Show the per-step and total token cost of this session',
      handler: showCost,
    },
  ], 'omdsh cost command')
}
