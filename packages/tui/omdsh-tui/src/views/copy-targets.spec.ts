import { describe, expect, it } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm'
import {
  buildCopyTargets,
  buildTableTargets,
  collectMarkdownTables,
  extractCodeBlocks,
  extractCopyTarget,
  extractMarkdownTables,
  extractTableCells,
  parseCopyKind,
  parseCopyTableRequest,
} from './copy-targets.ts'
import type { Block } from './event-views.ts'

const assistant = (text: string): Block =>
  ({ kind: 'assistant', turn: 1, step: 1, text, reasoning: '', streaming: false })

const tool = (name: string, args: string, output = ''): Block =>
  ({ kind: 'tool', callId: CallId('c1'), name, args, status: 'ok', output })

describe('parseCopyKind', () => {
  it('accepts the OMP tokens and rejects unknown ones', () => {
    expect(parseCopyKind('')).toBe('text')
    expect(parseCopyKind(' text ')).toBe('text')
    expect(parseCopyKind('table')).toBe('table')
    expect(parseCopyKind('code')).toBe('code')
    expect(parseCopyKind('cmd')).toBe('cmd')
    expect(parseCopyKind('command')).toBe('cmd')
    expect(parseCopyKind('nope')).toBeUndefined()
  })
})

describe('extractCodeBlocks', () => {
  it('collects closed fences and ignores an unclosed one', () => {
    const blocks = extractCodeBlocks('intro\n```js\nconst x = 1\n```\n```\nstill open')
    expect(blocks).toEqual([{ lang: 'js', code: 'const x = 1' }])
  })
})

describe('extractMarkdownTables', () => {
  it('preserves raw GFM tables without terminal box drawing', () => {
    expect(extractMarkdownTables([
      'before',
      '| Name | Value |',
      '| :--- | ---: |',
      '| alpha | one |',
      '',
      'after',
    ].join('\n'))).toEqual([
      '| Name | Value |\n| :--- | ---: |\n| alpha | one |',
    ])
  })

  it('ignores pipe-shaped prose without a delimiter row', () => {
    expect(extractMarkdownTables('one | two\nnot a table')).toEqual([])
  })
})

describe('parseCopyTableRequest', () => {
  it('reads table, row, and cell positions newest first', () => {
    expect(parseCopyTableRequest('table')).toEqual({ table: 1 })
    expect(parseCopyTableRequest(' TABLE 3 ')).toEqual({ table: 3 })
    expect(parseCopyTableRequest('table 1 4')).toEqual({ table: 1, row: 4 })
    expect(parseCopyTableRequest('table 2 4 5')).toEqual({ table: 2, row: 4, column: 5 })
    expect(parseCopyTableRequest('table 0')).toBeUndefined()
    expect(parseCopyTableRequest('table 1 0')).toBeUndefined()
    expect(parseCopyTableRequest('table 1 2 0')).toBeUndefined()
    expect(parseCopyTableRequest('table 1 nope')).toBeUndefined()
    expect(parseCopyTableRequest('code')).toBeUndefined()
    expect(parseCopyTableRequest('')).toBeUndefined()
  })
})

describe('extractTableCells', () => {
  const table = '| Name | Value |\n| --- | --- |\n| alpha | one |\n| beta | two |'

  it('reads one row or one cell with the header as row 1', () => {
    expect(extractTableCells(table, 1)).toEqual(['Name', 'Value'])
    expect(extractTableCells(table, 3)).toEqual(['beta', 'two'])
    expect(extractTableCells(table, 3, 2)).toEqual(['two'])
    expect(extractTableCells(table, 9)).toBeUndefined()
    expect(extractTableCells(table, 3, 9)).toBeUndefined()
  })
})

describe('collectMarkdownTables / buildTableTargets', () => {
  const first = '| A | B |\n| --- | --- |\n| one | two |'
  const second = '| C | D |\n| --- | --- |\n| three | four |'

  it('collects tables newest first across assistant blocks', () => {
    expect(collectMarkdownTables([
      assistant('intro\n' + first),
      { kind: 'user', text: 'more?' },
      assistant('result\n' + second),
    ])).toEqual([second, first])
  })

  it('builds numbered picker rows for the tables only', () => {
    const items = buildTableTargets([assistant(first), assistant(second)])
    expect(items.map((item) => item.id)).toEqual(['table:1', 'table:2'])
    expect(items[0]).toMatchObject({ text: second, copyMessage: 'Markdown table' })
    expect(items[1]).toMatchObject({ text: first })
  })
})

describe('extractCopyTarget', () => {
  it('takes the last assistant text', () => {
    const target = extractCopyTarget([
      assistant('first'),
      { kind: 'user', text: 'hi' },
      assistant('second'),
    ], 'text')
    expect(target).toEqual({ text: 'second', label: 'assistant text' })
  })

  it('takes the last raw Markdown table from assistant output', () => {
    const table = '| Name | Value |\n| --- | --- |\n| alpha | one |'
    const target = extractCopyTarget([
      assistant('| Old | Row |\n| --- | --- |\n| before | value |'),
      assistant('Result:\n\n' + table + '\n\nafter'),
    ], 'table')
    expect(target).toEqual({ text: table, label: 'Markdown table' })
  })

  it('selects an older table by newest-first index', () => {
    const older = '| Old | Row |\n| --- | --- |\n| before | value |'
    const newer = '| New | Row |\n| --- | --- |\n| after | value |'
    const blocks = [assistant(older), assistant(newer)]
    expect(extractCopyTarget(blocks, 'table', 1)).toEqual({ text: newer, label: 'Markdown table' })
    expect(extractCopyTarget(blocks, 'table', 2)).toEqual({ text: older, label: 'Markdown table' })
    expect(extractCopyTarget(blocks, 'table', 3)).toBeUndefined()
  })

  it('takes the last closed fence from assistant or tool output', () => {
    const fromAssistant = extractCopyTarget([
      assistant('```py\nold\n```\n```ts\nnew\n```'),
    ], 'code')
    expect(fromAssistant).toEqual({ text: 'new', label: 'ts block' })
    const fromTool = extractCopyTarget([
      assistant('```js\nold\n```'),
      tool('bash', '{}', 'see\n```\nplain\n```'),
    ], 'code')
    expect(fromTool).toEqual({ text: 'plain', label: 'code block' })
  })

  it('takes the last bash tool command', () => {
    const target = extractCopyTarget([
      tool('bash', '{"command":"ls"}'),
      tool('fs', '{"path":"/tmp"}'),
      tool('bash', '{"command":"pwd"}'),
    ], 'cmd')
    expect(target).toEqual({ text: 'pwd', label: 'bash command' })
  })

  it('returns undefined when the transcript has no match', () => {
    expect(extractCopyTarget([], 'text')).toBeUndefined()
    expect(extractCopyTarget([assistant('no table')], 'table')).toBeUndefined()
    expect(extractCopyTarget([assistant('no fence')], 'code')).toBeUndefined()
    expect(extractCopyTarget([tool('fs', '{}')], 'cmd')).toBeUndefined()
  })
})

describe('buildCopyTargets', () => {
  it('lists newest assistant text, its fences, and bash commands', () => {
    const items = buildCopyTargets([
      assistant('first reply'),
      tool('bash', '{"command":"ls -la"}'),
      assistant('see\n| Name | Value |\n| --- | --- |\n| alpha | one |\n```ts\nconst x = 1\n```'),
    ])
    expect(items.map((item) => item.id)).toEqual(['msg:1', 'table:1', 'code:1', 'cmd:1', 'msg:2'])
    expect(items[0]).toMatchObject({ label: 'see', hint: '7 lines', copyMessage: 'last message' })
    expect(items[1]).toMatchObject({ label: '| Name | Value |', hint: 'Markdown table · 3 lines', copyMessage: 'Markdown table' })
    expect(items[2]).toMatchObject({ label: 'const x = 1', hint: 'ts · 1 line', text: 'const x = 1', copyMessage: 'ts block' })
    expect(items[3]).toMatchObject({ label: 'ls -la', hint: 'bash · 1 line', text: 'ls -la', copyMessage: 'bash command' })
    expect(items[4]?.label).toBe('first reply')
  })

  it('returns an empty list when nothing is copyable', () => {
    expect(buildCopyTargets([{ kind: 'user', text: 'hi' }])).toEqual([])
  })
})
