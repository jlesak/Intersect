import { describe, expect, test } from 'vitest'
import type { Tab, Workspace } from '@common/domain'
import { gitSessionWarning } from './gitSessionWarning'

describe('gitSessionWarning', () => {
  test('counts live main checkout PTYs and excludes exited and linked worktree tabs', () => {
    const workspaces = [
      { id: 'root', folderPath: '/repo' },
      { id: 'nested', folderPath: '/repo/src' },
      { id: 'linked', folderPath: '/repo/.claude/worktrees/feature' },
      { id: 'other', folderPath: '/elsewhere' }
    ] as Workspace[]
    const tabs = new Map([
      ['root', [{ id: 'c', preset: 'claude' }, { id: 'exited', preset: 'shell' }]],
      ['nested', [{ id: 's', preset: 'shell' }]],
      ['linked', [{ id: 'c', preset: 'claude' }]],
      ['other', [{ id: 's', preset: 'shell' }]]
    ])
    expect(gitSessionWarning(
      '/repo', workspaces,
      (id) => tabs.get(id) as Tab[] ?? [],
      (id) => id !== 'root:exited',
      (path) => path,
      (path) => path.includes('/worktrees/') ? '/repo' : null
    )).toEqual({ claudeSessions: 1, terminalSessions: 1 })
  })
})
