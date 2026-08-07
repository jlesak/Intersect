import { describe, expect, test, vi } from 'vitest'

// The viewer creates a Monaco diff editor on mount, and monaco cannot initialise under jsdom. Only
// the anchor arithmetic is exercised here; that it reaches a real model is the end-to-end suite's.
vi.mock('monaco-editor', () => ({ editor: {} }))

import { anchorPastEndOfFile } from './DiffViewer'

/**
 * Azure DevOps records a comment against the iteration it was written on, while this diff is
 * computed locally against the current merge base, so a recorded line can name a line the file no
 * longer has. Monaco does not drop such a zone - it clamps the anchor and renders the thread under
 * the last line - so nothing about the placement itself reveals that the position is a guess.
 */
describe('anchorPastEndOfFile', () => {
  const file = 'const limit = 25\nconst burst = 5\n'

  test('a line inside the file is where the thread says it is', () => {
    expect(anchorPastEndOfFile(file, 1)).toBe(false)
    expect(anchorPastEndOfFile(file, 2)).toBe(false)
  })

  test('the last line of the file still counts as inside it', () => {
    // A trailing newline leaves an empty third line, which Monaco counts and can be anchored to.
    expect(anchorPastEndOfFile(file, 3)).toBe(false)
  })

  test('a line the file no longer reaches is past its end', () => {
    expect(anchorPastEndOfFile(file, 4)).toBe(true)
    expect(anchorPastEndOfFile(file, 12)).toBe(true)
  })

  test('a file without a trailing newline is counted by its real lines', () => {
    expect(anchorPastEndOfFile('one\ntwo', 2)).toBe(false)
    expect(anchorPastEndOfFile('one\ntwo', 3)).toBe(true)
  })

  test('a file whose side of the diff is empty holds a single line', () => {
    expect(anchorPastEndOfFile('', 1)).toBe(false)
    expect(anchorPastEndOfFile('', 2)).toBe(true)
  })
})
