import { describe, expect, test } from 'vitest'
import type { FileDiff } from '@common/domain'
import { SNIPPET_CONTEXT_LINES, cutSnippet } from './draftSnippet'

const lines = (count: number): string =>
  Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n')

const diff = (over: Partial<FileDiff> = {}): FileDiff => ({
  path: '/src/core/sync.ts',
  original: lines(20),
  modified: lines(30),
  language: 'typescript',
  binary: false,
  tooLarge: false,
  ...over
})

describe('cutSnippet', () => {
  test('surrounds the anchored line with context on both sides', () => {
    const snippet = cutSnippet(diff(), 'right', 10)

    expect(snippet).toEqual({
      startLine: 10 - SNIPPET_CONTEXT_LINES,
      anchorLine: 10,
      lines: ['line 7', 'line 8', 'line 9', 'line 10', 'line 11', 'line 12', 'line 13'],
      side: 'right'
    })
  })

  test('reads the left side for a draft anchored to the original', () => {
    const snippet = cutSnippet(diff({ original: 'const limit = 10\n' }), 'left', 1)

    expect(snippet).toEqual({ startLine: 1, anchorLine: 1, lines: ['const limit = 10'], side: 'left' })
  })

  test('a line near the top of the file keeps the context the file has', () => {
    const snippet = cutSnippet(diff(), 'right', 2)

    expect(snippet?.startLine).toBe(1)
    expect(snippet?.lines).toEqual(['line 1', 'line 2', 'line 3', 'line 4', 'line 5'])
  })

  test('a line near the end of the file stops at the last line', () => {
    const snippet = cutSnippet(diff({ modified: lines(5) }), 'right', 5)

    expect(snippet?.lines).toEqual(['line 2', 'line 3', 'line 4', 'line 5'])
  })

  test('an anchor past the end of the file cuts nothing - other code would be a lie', () => {
    expect(cutSnippet(diff({ modified: lines(5) }), 'right', 6)).toBeNull()
  })

  test('an emptied side cuts nothing', () => {
    expect(cutSnippet(diff({ original: '' }), 'left', 1)).toBeNull()
  })

  test('a binary or oversized file cuts nothing - its content was never read', () => {
    expect(cutSnippet(diff({ binary: true, original: '', modified: '' }), 'right', 1)).toBeNull()
    expect(cutSnippet(diff({ tooLarge: true, original: '', modified: '' }), 'right', 1)).toBeNull()
  })

  test('a line number below the first line cuts nothing', () => {
    expect(cutSnippet(diff(), 'right', 0)).toBeNull()
  })

  test('a trailing newline is not a line of its own', () => {
    const snippet = cutSnippet(diff({ modified: 'one\ntwo\n' }), 'right', 2)

    expect(snippet?.lines).toEqual(['one', 'two'])
    expect(cutSnippet(diff({ modified: 'one\ntwo\n' }), 'right', 3)).toBeNull()
  })
})
