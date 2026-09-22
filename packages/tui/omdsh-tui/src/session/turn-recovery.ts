/**
 * Detection of an orphaned live turn.
 *
 * A driver that stops mid-turn can leave the durable log with an open
 * `turn/start` and no `turn/end`. While that turn stays open, new input is
 * queued for the next turn instead of running, and `/steer` rejects it, so the
 * session reads as idle but can never make progress. Loading such a log already
 * closes the tail turn with {@link interruptedTurnClosers}; this module makes
 * the same condition visible while the session is still live, so the session
 * runtime can reload it and restart the driver.
 * @module @agi-fans/dsh-tui/turn-recovery
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { interruptedTurnClosers } from '@deepseek-ai/dsh-session'

/**
 * How long an open turn must stay quiet before it counts as orphaned.
 *
 * A turn that ended moments ago can still be settling its status transition, so
 * a short grace window keeps detection away from a healthy turn boundary.
 */
export const ORPHANED_TURN_GRACE_MS = 1500

/**
 * Whether an agent that is not running still carries an open turn.
 *
 * A running agent owns its turn and is never reported. A turn that ended within
 * the grace window may still be settling. Everything else — an idle agent, an
 * unbalanced tail turn, and no event for longer than the grace window — is an
 * orphaned turn whose driver is gone.
 *
 * @param agent - the agent to inspect.
 * @param now - current time in epoch milliseconds; injectable for tests.
 * @returns whether the agent is idle with an orphaned open turn.
 */
export function hasOrphanedTurn(agent: Agent, now: number = Date.now()): boolean {
  if (agent.status === 'running') return false
  const events = agent.session.events
  if (interruptedTurnClosers(events).length === 0) return false
  const last = events.at(-1)
  if (last === undefined) return false
  return now - last.time >= ORPHANED_TURN_GRACE_MS
}
