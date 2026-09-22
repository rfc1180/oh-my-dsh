/**
 * End-to-end check for orphaned-turn recovery.
 *
 * Boots the real composition, creates a live session with a persistence owner,
 * leaves it with an open `turn/start` and no `turn/end` (the state a stopped
 * driver leaves behind), then releases the owner and resumes: the load-time
 * repair must close the tail turn and the resumed agent must accept new input.
 * The TUI runner keeps handles open after the check, so the process exits
 * directly instead of waiting for a full fiber teardown.
 *
 * Run: pnpm --dir apps/omdsh check:wedge
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import { runOmdsh } from '../src/boot.ts'

const home = mkdtempSync(join(tmpdir(), 'omdsh-wedge-'))
process.env.OMDSH_HOME = home
writeFileSync(join(home, 'settings.yaml'), 'agent-presets:\n  default: code\n')
process.env.DEEPSEEK_API_KEY ??= 'sk-invalid-verification'

const log = (...a: unknown[]): void => { console.error('[verify]', ...a) }
const fail = (m: string): void => { console.error('FAIL:', m); process.exitCode = 1 }

const { ctx } = await runOmdsh([], undefined)
log('booted, home =', home)
const agents = ctx.get('agents')
const provider = 'deepseek-official'
const model = 'deepseek-v4-flash'

const id = 'session-' + randomUUID()
const handle = await agents.create({
  sessionId: id,
  meta: { cwd: process.cwd(), agentPreset: 'code' },
  agentOptions: { provider, model },
})
log('created', id, 'status =', handle.agent.status)

const session = handle.agent.session
session.append('turn/start', { turn: 1 })
session.append('step/start', { turn: 1, step: 1 })
session.append('step/end', { turn: 1, step: 1 })
log('simulated interrupted turn; closers =', interruptedTurnClosers(session.events).length)

await handle.dispose()
log('live persistence owner released')

const resumed = await agents.resume({ resumeSessionId: id, agentOptions: { provider, model } })
const events = resumed.agent.session.events
const lastEnd = events.findLast(event => event.type === 'turn/end')
log('resumed; closers =', interruptedTurnClosers(events).length, 'last turn/end =', JSON.stringify(lastEnd?.data))
if (interruptedTurnClosers(events).length !== 0) fail('tail turn still open after resume')
if (lastEnd?.data?.reason?.kind !== 'interrupted') fail('expected an interrupted turn/end from the repair')
if (resumed.agent.status !== 'idle') fail('resumed agent is not idle')

resumed.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'ping after recovery' }], source: { kind: 'user' } }))
await new Promise(resolve => setTimeout(resolve, 3000))
const starts = resumed.agent.session.events.filter(event => event.type === 'turn/start').length
log('after followup: turn/start count =', starts, 'status =', resumed.agent.status)
if (starts < 2) fail('a new turn did not start; input is still parked')

if (process.exitCode !== 1) console.log('WEDGE_RECOVERY_PASS')
process.exit(process.exitCode ?? 0)
