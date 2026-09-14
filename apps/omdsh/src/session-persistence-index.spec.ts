import { describe, expect, it, vi } from 'vitest'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { projectSessionHistoryAtRevision } from './session-persistence-index.ts'

const header = {
  id: SessionId('session-current'),
  version: 1,
  createdAt: 1,
  delegationDepth: 0,
} as SessionHeader

const events = [{
  type: 'user/message',
  seq: 0,
  time: 1,
  data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Hello' }] },
}] as unknown as SessionEvent[]

describe('session history projection cache', () => {
  it('reuses only an exact durable revision', async () => {
    let revision = 'r1'
    const persistence = {
      readStoredRevision: vi.fn(async () => revision),
      inspect: vi.fn(async () => ({ meta: header, events })),
    }

    const first = await projectSessionHistoryAtRevision(persistence, header.id)
    const cached = await projectSessionHistoryAtRevision(persistence, header.id)
    expect(cached).toBe(first)
    expect(persistence.inspect).toHaveBeenCalledOnce()

    revision = 'r2'
    const refreshed = await projectSessionHistoryAtRevision(persistence, header.id)
    expect(refreshed).not.toBe(first)
    expect(persistence.inspect).toHaveBeenCalledTimes(2)
  })

  it('rejects a revision change during projection and does not cache it', async () => {
    let calls = 0
    const persistence = {
      readStoredRevision: vi.fn(async () => calls++ === 0 ? 'r1' : 'r2'),
      inspect: vi.fn(async () => ({ meta: header, events })),
    }

    await expect(projectSessionHistoryAtRevision(persistence, header.id))
      .rejects.toThrow('changed during history projection')
  })
})
