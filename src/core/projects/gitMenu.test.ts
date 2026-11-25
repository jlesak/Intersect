import { describe, expect, test } from 'vitest'
import { parseGitStatus } from './gitMenu'

describe('parseGitStatus', () => {
  test('counts a rename once and separates staged and unstaged files', () => {
    const raw = '# branch.oid abcdef123456\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -3\0' +
      '2 R. N... 100644 100644 100644 a b R100 new name\0old name\0' +
      '1 .M N... 100644 100644 100644 a b changed\0? new\0'
    const status = parseGitStatus(raw)
    expect(status.branch).toBe('main')
    expect(status.ahead).toBe(2)
    expect(status.behind).toBe(3)
    expect(status.files).toEqual([
      { path: 'new name', staged: true, unstaged: false, code: 'R' },
      { path: 'changed', staged: false, unstaged: true, code: 'M' },
      { path: 'new', staged: false, unstaged: true, code: '?' }
    ])
  })
})
