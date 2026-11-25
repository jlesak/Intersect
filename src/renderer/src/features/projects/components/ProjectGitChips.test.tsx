import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ProjectGitBranch, ProjectGitPreview, ProjectGitStatus } from '@common/domain'
import { useGitBusyStore } from '../gitBusyStore'
import * as api from '../ipc'
import { ProjectGitChips } from './ProjectGitChips'

vi.mock('../ipc', () => ({
  gitStatuses: vi.fn(), gitBranches: vi.fn(), gitAction: vi.fn(), gitPreview: vi.fn(),
  gitCommit: vi.fn(), gitValidateName: vi.fn()
}))

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function status(repoPath: string, commonDir: string): ProjectGitStatus {
  return {
    repoPath, commonDir, mainPath: '/repos/main', branch: 'main', head: 'abc',
    upstream: null, ahead: 0, behind: 0, files: [], progress: null, error: null,
    claudeSessions: 0, terminalSessions: 0
  }
}

function branch(name: string): ProjectGitBranch {
  return { name, kind: 'remote', current: false, inWorktree: false, timestamp: 0, defaultRemote: true }
}

function setup(statuses: ProjectGitStatus[]): void {
  vi.mocked(api.gitStatuses).mockResolvedValue(statuses)
  vi.mocked(api.gitBranches).mockResolvedValue([])
  vi.mocked(api.gitValidateName).mockResolvedValue(null)
  render(<ProjectGitChips projectId="p" repoPaths={statuses.map((item) => item.repoPath)} />)
}

afterEach(() => {
  vi.clearAllMocks()
  useGitBusyStore.setState({ byRepo: {} })
})

describe('ProjectGitChips async repository state', () => {
  test('a push stays busy after project A unmounts and project B mounts its linked worktree', async () => {
    const pending = deferred<string>()
    const main = status('/repos/main', '/git/shared')
    const linked = status('/repos/linked', '/git/shared')
    vi.mocked(api.gitStatuses).mockImplementation((projectId) => Promise.resolve(projectId === 'a' ? [main] : [linked]))
    vi.mocked(api.gitBranches).mockResolvedValue([])
    vi.mocked(api.gitAction).mockReturnValue(pending.promise)
    const first = render(<ProjectGitChips projectId="a" repoPaths={[main.repoPath]} />)
    await waitFor(() => expect(first.container.querySelector('.ix-git__chip')?.textContent).toContain('main'))
    fireEvent.click(first.container.querySelector('.ix-git__chip')!)
    fireEvent.click(screen.getByRole('button', { name: /Push/ }))
    first.unmount()

    const second = render(<ProjectGitChips projectId="b" repoPaths={[linked.repoPath]} />)
    await waitFor(() => expect(second.container.querySelector('.ix-git__chip')?.textContent).toContain('Pushing'))
    fireEvent.click(second.container.querySelector('.ix-git__chip')!)
    expect((screen.getByRole('button', { name: /New branch…/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /Fetch/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(api.gitAction).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve('Pushed'))
    await waitFor(() => expect(second.container.querySelector('.ix-git__chip')?.textContent).not.toContain('Pushing'))
  })

  test('aliases of the same repository stay busy during a slow push', async () => {
    const pending = deferred<string>()
    vi.mocked(api.gitAction).mockReturnValue(pending.promise)
    setup([status('/repos/main', '/git/shared'), status('/repos/linked', '/git/shared')])
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Git .*main/ })).toHaveLength(1))
    const chips = document.querySelectorAll<HTMLButtonElement>('.ix-git__chip')
    fireEvent.click(chips[0])
    fireEvent.click(screen.getByRole('button', { name: /Push/ }))
    fireEvent.mouseDown(document.querySelector('.ix-git__backdrop')!)
    await waitFor(() => expect(chips[1].textContent).toContain('Pushing'))
    fireEvent.click(chips[1])
    expect((screen.getByRole('button', { name: /New branch…/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /Fetch/ }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => pending.resolve('Pushed'))
  })

  test('late origin discovery from A cannot replace B dialog start points', async () => {
    const a = deferred<ProjectGitBranch[]>()
    const b = deferred<ProjectGitBranch[]>()
    setup([status('/repos/a', '/git/a'), status('/repos/b', '/git/b')])
    vi.mocked(api.gitBranches).mockImplementation((_project, path, discover) =>
      discover ? path === '/repos/a' ? a.promise : b.promise : Promise.resolve([]))
    const chips = document.querySelectorAll<HTMLButtonElement>('.ix-git__chip')
    await waitFor(() => expect(chips[0].textContent).toContain('main'))
    fireEvent.click(chips[0])
    fireEvent.click(screen.getByRole('button', { name: /New branch…/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(chips[1])
    fireEvent.click(screen.getByRole('button', { name: /New branch…/ }))
    await act(async () => b.resolve([branch('origin/b')]))
    expect(screen.getByRole('dialog').querySelector('option[value="origin/b"]')).not.toBeNull()
    await act(async () => a.resolve([branch('origin/a')]))
    expect(screen.getByRole('dialog').querySelector('option[value="origin/b"]')).not.toBeNull()
    expect(screen.getByRole('dialog').querySelector('option[value="origin/a"]')).toBeNull()
  })

  test('late commit preview from A cannot replace B branch dialog', async () => {
    const preview = deferred<ProjectGitPreview>()
    vi.mocked(api.gitPreview).mockReturnValue(preview.promise)
    const a: ProjectGitStatus = { ...status('/repos/a', '/git/a'), files: [{ path: 'changed', code: 'M', staged: false, unstaged: true }] }
    setup([a, status('/repos/b', '/git/b')])
    const chips = document.querySelectorAll<HTMLButtonElement>('.ix-git__chip')
    await waitFor(() => expect(chips[0].textContent).toContain('main'))
    fireEvent.click(chips[0])
    fireEvent.click(screen.getByRole('button', { name: /Commit…/ }))
    fireEvent.mouseDown(document.querySelector('.ix-git__backdrop')!)
    fireEvent.click(chips[1])
    fireEvent.click(screen.getByRole('button', { name: /New branch…/ }))
    await act(async () => preview.resolve({ mode: 'all', files: a.files, otherCount: 0, token: 'old' }))
    expect(screen.getByRole('dialog').textContent).toContain('New branch')
    expect(screen.getByRole('dialog').textContent).not.toContain('Commit to')
  })
})
