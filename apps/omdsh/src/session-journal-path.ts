/**
 * Locate the durable journal of a session id.
 *
 * Sessions live under DSH_HOME keyed by project directory, so an id alone does not give a
 * path. The launcher needs the file, not the parsed session, because it reads the model
 * route before any context is mounted.
 * @module @agi-fans/oh-my-dsh
 */

import { readdirSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function sessionsRoot(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/** Absolute journal path for a session id, or the conventional path when it is absent. */
export async function resolveSessionJournal(sessionId: string): Promise<string> {
  const root = sessionsRoot()
  let projects: Dirent[]
  try {
    projects = readdirSync(root, { withFileTypes: true })
  } catch {
    return join(root, sessionId, 'session.jsonl.zstd')
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = join(root, project.name, sessionId, 'session.jsonl.zstd')
    try {
      readdirSync(join(root, project.name, sessionId))
      return candidate
    } catch {
      continue
    }
  }
  return join(root, sessionId, 'session.jsonl.zstd')
}
