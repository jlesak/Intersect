import { describe, expect, test } from 'vitest'
import { deleteButtonLabel } from './ProjectWorktrees'

describe('worktree confirmation', () => {
  test.each([
    [0, false, 'Delete'],
    [2, false, 'Close tabs and delete'],
    [0, true, 'Discard changes and delete'],
    [2, true, 'Close tabs, discard changes and delete']
  ])('names %i tabs and danger=%s', (tabs, danger, label) => {
    expect(deleteButtonLabel(tabs, danger)).toBe(label)
  })
})
