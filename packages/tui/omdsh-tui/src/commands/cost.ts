/** Session token-cost summary command registered through dsh-commands. */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { formatCostSources, formatCostSummary, summarizeCost, summarizeCostBySource } from '../session/cost-summary.ts'
import { registerCommands } from './registration.ts'

export const name = 'omdsh-command-cost'
export const inject = ['commands']

function showCost(invocation: CommandInvocation): CommandResult {
  const events = invocation.agent.session.events
  const mode = invocation.rawInput.trim().toLocaleLowerCase()
  if (mode === '' || mode === 'steps') return { kind: 'success', text: formatCostSummary(summarizeCost(events)) }
  if (mode === 'sources') return { kind: 'success', text: formatCostSources(summarizeCostBySource(events)) }
  return { kind: 'error', text: 'Usage: /cost [steps|sources]' }
}

export function apply(ctx: Context): void {
  registerCommands(ctx, [
    {
      name: 'cost',
      description: 'Show the per-step, total, or by-source token cost of this session',
      input: { hint: '[steps|sources]' },
      handler: showCost,
    },
  ], 'omdsh cost command')
}
