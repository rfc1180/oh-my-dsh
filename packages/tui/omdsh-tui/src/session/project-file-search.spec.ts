import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadProjectPathResult,
  loadProjectPaths,
  ProjectFileSearch,
  rankProjectPaths,
} from './project-file-search.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('project file search', () => {
  it('ranks exact basenames before prefix, substring, and subsequence matches', () => {
    const entries = [
      { path: 'src/index.ts', directory: false },
      { path: 'docs/indexing.md', directory: false },
      { path: 'packages/history-search.ts', directory: false },
      { path: 'index.ts', directory: false },
    ]

    expect(rankProjectPaths(entries, 'index').map(entry => entry.path)).toEqual([
      'index.ts',
      'src/index.ts',
      'docs/indexing.md',
    ])
    expect(rankProjectPaths(entries, 'histsr')[0]?.path).toBe('packages/history-search.ts')
  })

  it('caches each project index and supports explicit invalidation', async () => {
    let loads = 0
    const search = new ProjectFileSearch(async () => {
      loads += 1
      return [{ path: 'src/index.ts', directory: false }]
    }, 10_000)

    await search.search('/project', 'index')
    await search.search('/project', 'src')
    expect(loads).toBe(1)

    search.invalidate('/project')
    await search.search('/project', 'index')
    expect(loads).toBe(2)
  })

  it('keeps the array API while reporting top-100 truncation through additive metadata', async () => {
    const entries = Array.from({ length: 150 }, (_, index) => ({
      path: `src/match-${String(index).padStart(3, '0')}.ts`,
      directory: false,
    }))
    const search = new ProjectFileSearch(async () => entries, 10_000)

    const compatible = await search.search('/project', 'match')
    const detailed = await search.search.detailed?.('/project', 'match')

    expect(compatible).toHaveLength(100)
    expect(detailed).toMatchObject({
      total: 150,
      truncated: true,
      source: 'custom',
      complete: true,
    })
    expect(detailed?.items).toHaveLength(100)
  })

  it('reports bounded walk fallback instead of hiding Git discovery errors', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'omdsh-file-fallback-'))
    temporaryDirectories.push(root)
    writeFileSync(path.join(root, 'plain.txt'), '')

    const result = await loadProjectPathResult(root)

    expect(result.source).toBe('walk')
    expect(result.items.map(entry => entry.path)).toContain('plain.txt')
    expect(result.complete).toBe(true)
  })

  it('uses Git visibility rules, including hidden files, without exposing .git', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'omdsh-file-search-'))
    temporaryDirectories.push(root)
    mkdirSync(path.join(root, 'src'))
    mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true })
    mkdirSync(path.join(root, 'ignored'))
    writeFileSync(path.join(root, '.gitignore'), 'ignored/\n')
    writeFileSync(path.join(root, 'src', 'index.ts'), '')
    writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), '')
    writeFileSync(path.join(root, 'ignored', 'secret.ts'), '')
    execFileSync('git', ['init', '-q'], { cwd: root })

    const entries = await loadProjectPaths(root)
    const paths = entries.map(entry => entry.path)

    expect(paths).toContain('src/index.ts')
    expect(paths).toContain('.github/workflows/ci.yml')
    expect(paths).not.toContain('ignored/secret.ts')
    expect(paths.every(entry => !/(^|\/)\.git(\/|$)/u.test(entry))).toBe(true)
  })
})
