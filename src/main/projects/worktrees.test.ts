import { describe, expect, test } from 'vitest'
import { parseWorktreeList } from './worktrees'

describe('parseWorktreeList', () => {
  test('parses the main checkout plus linked worktrees', () => {
    const porcelain = [
      'worktree /repos/spot',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /wt/spot-feature',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/feature/rail',
      ''
    ].join('\n')

    expect(parseWorktreeList(porcelain)).toEqual([
      { path: '/repos/spot', head: '1111111111111111111111111111111111111111', branch: 'main' },
      {
        path: '/wt/spot-feature',
        head: '2222222222222222222222222222222222222222',
        branch: 'feature/rail'
      }
    ])
  })

  test('a detached worktree reports a null branch', () => {
    const porcelain = ['worktree /wt/detached', 'HEAD 3333', 'detached', ''].join('\n')
    expect(parseWorktreeList(porcelain)).toEqual([
      { path: '/wt/detached', head: '3333', branch: null }
    ])
  })

  test('unknown attribute lines and empty input are tolerated', () => {
    expect(parseWorktreeList('')).toEqual([])
    const porcelain = ['worktree /a', 'HEAD 4444', 'locked reason', 'prunable gone', ''].join('\n')
    expect(parseWorktreeList(porcelain)).toHaveLength(1)
  })
})
