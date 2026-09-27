/**
 * Restore the model a durable session was last using.
 *
 * A session records its model in `request/header` events, one per model call. The
 * launcher never read them back, so `--resume` fell through to whatever the layered
 * environment happened to provide and an old conversation came back on a different
 * model than the one it was having. The rule that agent composition may change only
 * before model-visible history exists already exists in this codebase; this module
 * applies it to resume instead of leaving it as an unused intention.
 * @module @agi-fans/oh-my-dsh
 */

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

type RestoredModel = { readonly provider: string; readonly model: string }

/** Model route recorded by the most recent model call, or undefined when unknown. */
export function readSessionModel(journalPath: string): RestoredModel | undefined {
  let text: string
  try {
    const raw = readFileSync(journalPath)
    // Journals are zstd frames. Zstd's magic lets a plain (legacy) journal through
    // unchanged, so both layouts are read without guessing from the file name.
    const isZstd = raw.length >= 4 && raw[0] === 0x28 && raw[1] === 0xb5 && raw[2] === 0x2f && raw[3] === 0xfd
    text = isZstd ? zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8')
  } catch {
    return undefined
  }
  let found: RestoredModel | undefined
  for (const line of text.split('\n')) {
    if (line === '' || !line.includes('request/header')) continue
    let event: { type?: unknown; data?: unknown }
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type !== 'request/header') continue
    const config = (event.data as { header?: { config?: unknown } } | undefined)?.header?.config
    if (typeof config !== 'object' || config === null) continue
    const { provider, model } = config as { provider?: unknown; model?: unknown }
    if (typeof provider !== 'string' || typeof model !== 'string') continue
    if (provider === '' || model === '') continue
    // Later events win: the newest call is the model the conversation was actually using.
    found = { provider, model }
  }
  return found
}

/** Apply a restored route to the launch environment unless the CLI overrode it. */
export function applyRestoredModel(restored: RestoredModel | undefined): boolean {
  if (restored === undefined) return false
  // An explicit flag always outranks the journal, exactly like every other layered source.
  if (process.env.OMDSH_MODEL === undefined) process.env.OMDSH_MODEL = restored.model
  if (process.env.OMDSH_PROVIDER === undefined) process.env.OMDSH_PROVIDER = restored.provider
  return true
}
