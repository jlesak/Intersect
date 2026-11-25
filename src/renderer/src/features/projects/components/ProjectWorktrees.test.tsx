import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { WorktreeInfo } from '@common/domain'
import * as api from '../ipc'
import { deleteButtonLabel, ProjectWorktrees } from './ProjectWorktrees'

vi.mock('../ipc', () => ({
  listWorktrees: vi.fn(), deleteWorktree: vi.fn(), removeWorktreeEntry: vi.fn()
}))

function row(branch: string, overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    path: `/repo/${branch}`, displayPath: branch, branch, head: 'abcdef123456', bare: false,
    lockedReason: null, prunableReason: null, folderMissing: false, createdAt: null,
    changed: [], unpushed: 0, goneOnOrigin: false, main: false, managed: null, workspaces: [],
    ...overrides
  }
}

afterEach(() => vi.clearAllMocks())

describe('worktree confirmation', () => {
  test.each([
    [0, false, 'Delete'],
    [2, false, 'Close tabs and delete'],
    [0, true, 'Discard changes and delete'],
    [2, true, 'Close tabs, discard changes and delete']
  ])('names %i tabs and danger=%s', (tabs, danger, label) => {
    expect(deleteButtonLabel(tabs, danger)).toBe(label)
  })

  test('locked offline row keeps healthy rows visible and requires an explicit danger confirmation', async () => {
    const offline = row('offline', {
      folderMissing: true, lockedReason: 'external drive', unpushed: 1,
      workspaces: [{ id: 'w1', name: 'Offline', tabs: 1, runningClaude: 0 }]
    })
    vi.mocked(api.listWorktrees).mockResolvedValue([{ repoPath: '/repo', error: null,
      worktrees: [row('main', { path: '/repo', main: true }), row('healthy'), offline] }])
    vi.mocked(api.deleteWorktree).mockResolvedValue({ outcome: 'entryRemoved' })
    render(<ProjectWorktrees projectId="p" />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete worktree healthy' })).toBeTruthy())
    expect(screen.getByText('folder missing')).toBeTruthy()
    expect(screen.getByText('1 tab open')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Remove entry' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Delete worktree offline' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('external drive')
    expect(dialog.textContent).toContain('branch and workspaces')
    expect(screen.queryByRole('checkbox', { name: /Also delete branch/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Override lock and remove entry' }))
    await waitFor(() => expect(api.deleteWorktree).toHaveBeenCalledWith(expect.objectContaining({
      overrideLock: true, deleteBranch: false, path: offline.path
    })))
  })

  test('one unpushed commit uses singular confirmation copy', async () => {
    vi.mocked(api.listWorktrees).mockResolvedValue([{ repoPath: '/repo', error: null,
      worktrees: [row('healthy', { unpushed: 1 })] }])
    render(<ProjectWorktrees projectId="p" />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete worktree healthy' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Delete worktree healthy' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Also delete branch healthy' }))
    expect(screen.getByRole('dialog').textContent).toContain('1 commit is on no remote')
  })
})
