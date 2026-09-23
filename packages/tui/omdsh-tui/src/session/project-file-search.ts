/** Cached project-file discovery and fuzzy ranking for composer `@query`. */

import { execFile } from 'node:child_process'
import { opendir } from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_CACHE_TTL_MS = 2_000
const DEFAULT_MAX_RESULTS = 100
const GIT_MAX_BUFFER_BYTES = 8 * 1024 * 1024
export const MAX_WALK_ENTRIES = 200_000
const FALLBACK_SKIPPED_DIRECTORIES = new Set(['.git', '.hg', '.svn', 'node_modules'])

/** One project-relative path returned by the asynchronous file index. */
export interface ProjectPathEntry {
  path: string
  directory: boolean
}

export interface PathSearchOptions {
  signal?: AbortSignal
  maxResults?: number
}

export type ProjectPathSource = 'git' | 'walk' | 'custom'

/** Additive discovery metadata; `total` is a lower bound when `complete` is false. */
export interface ProjectPathSearchResult {
  items: readonly ProjectPathEntry[]
  total: number
  truncated: boolean
  source: ProjectPathSource
  complete: boolean
}

export type DetailedPathSearcher = (
  root: string,
  query: string,
  options?: PathSearchOptions,
) => Promise<ProjectPathSearchResult>

/** Recursive project-file search used by `@query`; old array callers stay valid. */
export interface PathSearcher {
  (root: string, query: string, options?: PathSearchOptions): Promise<readonly ProjectPathEntry[]>
  /** Optional additive metadata channel for aware callers. */
  detailed?: DetailedPathSearcher
}

export type ProjectPathLoader = (root: string, signal?: AbortSignal) => Promise<readonly ProjectPathEntry[]>
export type GitProjectPathLoader = (root: string, signal?: AbortSignal) => Promise<readonly ProjectPathEntry[]>

function abortError(): Error {
  const error = new Error('Project file search aborted')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw abortError()
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown }).name === 'AbortError'
}

/** Node uses either code for an execFile maxBuffer overflow across supported releases. */
export function isGitBufferOverflow(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 3 && current !== undefined && current !== null; depth += 1) {
    const value = current as { code?: unknown; message?: unknown; cause?: unknown }
    if (value.code === 'ENOBUFS' || value.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return true
    if (typeof value.message === 'string'
      && /ERR_CHILD_PROCESS_STDIO_MAXBUFFER|\bENOBUFS\b|maxBuffer length exceeded/iu.test(value.message)) return true
    current = value.cause
  }
  return false
}

function normalizedRelativePath(value: string): string | undefined {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '')
  if (normalized === '' || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) return undefined
  if (normalized.split('/').includes('.git')) return undefined
  return normalized
}

function indexedGitPaths(stdout: string): ProjectPathEntry[] {
  const entries = new Map<string, boolean>()
  for (const value of stdout.split('\0')) {
    const file = normalizedRelativePath(value)
    if (file === undefined) continue
    entries.set(file, false)
    const parts = file.split('/')
    for (let index = 1; index < parts.length; index += 1) {
      entries.set(parts.slice(0, index).join('/'), true)
    }
  }
  return [...entries].map(([entryPath, directory]) => ({
    path: directory ? entryPath + '/' : entryPath,
    directory,
  }))
}

const gitProjectPaths: GitProjectPathLoader = async (root, signal) => {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const options = {
      cwd: root,
      encoding: 'utf8' as const,
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      ...(signal === undefined ? {} : { signal }),
    }
    execFile(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      options,
      (error, stdout) => {
        if (signal?.aborted === true) {
          reject(abortError())
          return
        }
        if (error !== null) {
          reject(error)
          return
        }
        resolve(indexedGitPaths(stdout))
      },
    )
  })
}

async function walkedProjectPaths(root: string, signal?: AbortSignal): Promise<ProjectPathSearchResult> {
  const entries: ProjectPathEntry[] = []
  const pending = ['']
  let capped = false
  while (pending.length > 0 && entries.length < MAX_WALK_ENTRIES) {
    throwIfAborted(signal)
    const relativeDir = pending.shift() ?? ''
    let directory
    try {
      directory = await opendir(path.join(root, relativeDir))
    } catch {
      continue
    }
    for await (const entry of directory) {
      throwIfAborted(signal)
      if (entry.name === '.git') continue
      if (entry.isDirectory() && FALLBACK_SKIPPED_DIRECTORIES.has(entry.name)) continue
      const relative = (relativeDir === '' ? entry.name : relativeDir + '/' + entry.name).replaceAll('\\', '/')
      if (entry.isDirectory()) {
        entries.push({ path: relative + '/', directory: true })
        pending.push(relative)
      } else {
        entries.push({ path: relative, directory: false })
      }
      if (entries.length >= MAX_WALK_ENTRIES) {
        capped = true
        break
      }
    }
  }
  const complete = !capped && pending.length === 0
  return {
    items: entries,
    total: entries.length,
    truncated: !complete,
    source: 'walk',
    complete,
  }
}

/** Load discovery metadata without hiding Git fallback or the walk ceiling. */
export async function loadProjectPathResult(
  root: string,
  signal?: AbortSignal,
  loadGit: GitProjectPathLoader = gitProjectPaths,
): Promise<ProjectPathSearchResult> {
  try {
    const git = await loadGit(root, signal)
    return { items: git, total: git.length, truncated: false, source: 'git', complete: true }
  } catch (error) {
    if (isAbortError(error) || signal?.aborted === true) throw error
    const walk = await walkedProjectPaths(root, signal)
    if (!isGitBufferOverflow(error)) return walk
    return { ...walk, truncated: true, complete: false }
  }
}

/** Compatibility helper returning only the discovered paths. */
export async function loadProjectPaths(root: string, signal?: AbortSignal): Promise<readonly ProjectPathEntry[]> {
  return (await loadProjectPathResult(root, signal)).items
}

function subsequenceScore(query: string, target: string): number | undefined {
  let queryIndex = 0
  let first = -1
  let previous = -1
  let gaps = 0
  for (let index = 0; index < target.length && queryIndex < query.length; index += 1) {
    if (target[index] !== query[queryIndex]) continue
    if (first < 0) first = index
    if (previous >= 0) gaps += Math.max(0, index - previous - 1)
    previous = index
    queryIndex += 1
  }
  if (queryIndex !== query.length) return undefined
  return Math.max(0, first) * 2 + gaps * 3 + target.length - query.length
}

/** Lower scores are better; undefined means the query does not match. */
export function fuzzyProjectPathScore(query: string, candidate: string): number | undefined {
  const needle = query.trim().toLowerCase().replaceAll('\\', '/')
  const target = candidate.toLowerCase().replaceAll('\\', '/').replace(/\/$/u, '')
  if (needle === '') return target.split('/').length * 10
  const basename = target.slice(target.lastIndexOf('/') + 1)
  const depthPenalty = Math.max(0, target.split('/').length - 1) * 2
  if (basename === needle) return depthPenalty
  if (basename.startsWith(needle)) return 20 + basename.length - needle.length + depthPenalty
  const basenameContains = basename.indexOf(needle)
  if (basenameContains >= 0) return 60 + basenameContains + depthPenalty
  const targetContains = target.indexOf(needle)
  if (targetContains >= 0) return 100 + targetContains + depthPenalty
  const basenameFuzzy = subsequenceScore(needle, basename)
  if (basenameFuzzy !== undefined) return 160 + basenameFuzzy + depthPenalty
  const pathFuzzy = subsequenceScore(needle, target)
  if (pathFuzzy !== undefined) return 260 + pathFuzzy + depthPenalty
  return undefined
}

function rankProjectPathResult(
  load: ProjectPathSearchResult,
  query: string,
  maxResults = DEFAULT_MAX_RESULTS,
): ProjectPathSearchResult {
  const limit = Math.max(0, maxResults)
  const ranked = load.items
    .flatMap((entry) => {
      const entryPath = normalizedRelativePath(entry.path)
      if (entryPath === undefined) return []
      const score = fuzzyProjectPathScore(query, entryPath)
      if (score === undefined) return []
      return [{
        entry: { path: entry.directory ? entryPath + '/' : entryPath, directory: entry.directory },
        score,
        depth: entryPath.split('/').length,
      }]
    })
    .sort((left, right) => left.score - right.score
      || Number(right.entry.directory) - Number(left.entry.directory)
      || left.depth - right.depth
      || left.entry.path.localeCompare(right.entry.path))
  const total = ranked.length
  const capped = total > limit
  return {
    items: ranked.slice(0, limit).map(result => result.entry),
    total,
    truncated: load.truncated || capped,
    source: load.source,
    complete: load.complete,
  }
}

/** Rank a stable project index for one live query. */
export function rankProjectPaths(
  entries: readonly ProjectPathEntry[],
  query: string,
  maxResults = DEFAULT_MAX_RESULTS,
): ProjectPathEntry[] {
  return [...rankProjectPathResult({
    items: entries,
    total: entries.length,
    truncated: false,
    source: 'custom',
    complete: true,
  }, query, maxResults).items]
}

/** Per-TUI project index cache; search remains asynchronous and cancellable. */
export class ProjectFileSearch {
  readonly #cache = new Map<string, { expiresAt: number; load: ProjectPathSearchResult }>()
  readonly #loader: ProjectPathLoader
  readonly #cacheTtlMs: number

  constructor(loader: ProjectPathLoader = loadProjectPaths, cacheTtlMs = DEFAULT_CACHE_TTL_MS) {
    this.#loader = loader
    this.#cacheTtlMs = cacheTtlMs
  }

  readonly searchDetailed: DetailedPathSearcher = async (root, query, options = {}) => {
    throwIfAborted(options.signal)
    const cacheKey = path.resolve(root)
    const now = Date.now()
    const cached = this.#cache.get(cacheKey)
    let load: ProjectPathSearchResult
    if (cached !== undefined && cached.expiresAt >= now) {
      load = cached.load
    } else if (this.#loader === loadProjectPaths) {
      load = await loadProjectPathResult(cacheKey, options.signal)
      throwIfAborted(options.signal)
      this.#cache.set(cacheKey, { load, expiresAt: Date.now() + this.#cacheTtlMs })
    } else {
      const items = await this.#loader(cacheKey, options.signal)
      throwIfAborted(options.signal)
      load = { items, total: items.length, truncated: false, source: 'custom', complete: true }
      this.#cache.set(cacheKey, { load, expiresAt: Date.now() + this.#cacheTtlMs })
    }
    return rankProjectPathResult(load, query, options.maxResults ?? DEFAULT_MAX_RESULTS)
  }

  /** Existing callers still receive an array; metadata-aware callers use `.detailed`. */
  readonly search: PathSearcher = Object.assign(
    async (root: string, query: string, options: PathSearchOptions = {}) =>
      (await this.searchDetailed(root, query, options)).items,
    { detailed: this.searchDetailed },
  )

  invalidate(root?: string): void {
    if (root === undefined) this.#cache.clear()
    else this.#cache.delete(path.resolve(root))
  }
}
