/**
 * Orphaned-turn detection contract: only an idle agent whose tail turn was
 * never closed, and whose log has gone quiet, may be reported.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { hasOrphanedTurn, ORPHANED_TURN_GRACE_MS } from './turn-recovery.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function sessionWith(append: (session: Session) => void): Promise<Session> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId(`turn-recovery-${contexts.length}`))
  append(session)
  return session
}

const agent = (session: Session, status: 'idle' | 'running'): Agent =>
  ({ id: session.id, session, status }) as unknown as Agent

/** An interrupted turn: `turn/start` whose driver stopped after the last step. */
const interruptedTurn = (session: Session): void => {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('step/end', { turn: 1, step: 1 })
}

describe('hasOrphanedTurn', () => {
  it('reports an idle agent whose tail turn was never closed', async () => {
    const session = await sessionWith(interruptedTurn)
    expect(hasOrphanedTurn(agent(session, 'idle'), Date.now() + ORPHANED_TURN_GRACE_MS)).toBe(true)
  })

  it('never reports a running agent that owns its turn', async () => {
    const session = await sessionWith(interruptedTurn)
    expect(hasOrphanedTurn(agent(session, 'running'), Date.now() + ORPHANED_TURN_GRACE_MS)).toBe(false)
  })

  it('ignores a closed turn', async () => {
    const session = await sessionWith(current => {
      interruptedTurn(current)
      current.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    })
    expect(hasOrphanedTurn(agent(session, 'idle'), Date.now() + ORPHANED_TURN_GRACE_MS)).toBe(false)
  })

  it('ignores a turn that ended within the settling grace window', async () => {
    const session = await sessionWith(interruptedTurn)
    expect(hasOrphanedTurn(agent(session, 'idle'))).toBe(false)
  })
})
