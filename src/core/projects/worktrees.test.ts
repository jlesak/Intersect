import { describe, expect, test } from 'vitest'
import { parseWorktreeList } from './worktrees'

describe('parseWorktreeList', () => {
  test('parses NUL porcelain including spaces, detached, bare, lock and missing folder', () => {
    const porcelain = [
      'worktree /repo with spaces', 'HEAD 1111', 'branch refs/heads/main', '',
      'worktree /wt/locked folder', 'HEAD 2222', 'detached', 'locked maintenance', '',
      'worktree /wt/missing', 'HEAD 3333', 'branch refs/heads/old', 'prunable gitdir file points to non-existent location', ''
    ].join('\0')
    expect(parseWorktreeList(porcelain)).toMatchObject([
      { path: '/repo with spaces', head: '1111', branch: 'main', lockedReason: null, prunableReason: null },
      { path: '/wt/locked folder', head: '2222', branch: null, lockedReason: 'maintenance' },
      { path: '/wt/missing', head: '3333', branch: 'old', prunableReason: 'gitdir file points to non-existent location' }
    ])
  })

  test('parses a bare root and empty lock reason', () => {
    expect(parseWorktreeList('worktree /bare\0bare\0\0worktree /linked\0HEAD abc\0locked\0\0'))
      .toMatchObject([{ path: '/bare', bare: true }, { path: '/linked', lockedReason: '' }])
  })
})
