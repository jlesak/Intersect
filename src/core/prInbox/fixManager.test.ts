import { describe, expect, test, vi } from 'vitest'
import type { FixWorktreeClosedEvent, PrThread, PullRequest } from '@common/domain'
import { createFixManager, type FixManagerDeps } from './fixManager'
import { fixWorktreePath, type RemoveCleanResult } from './worktreeManager'

const USER_DATA = '/nonexistent-intersect-test/userdata'

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  prId: 501,
  repositoryId: 'repo',
  repositoryName: 'intersect-app',
  projectId: 'SPOT',
  title: 'Add rate limiting',
  description: '',
  authorId: 'me',
  authorName: 'Jan Lesak',
  createdAt: 0,
  status: 'active',
  sourceRefName: 'refs/heads/feature/rate-limit',
  targetRefName: 'refs/heads/main',
  sourceCommitId: 's',
  targetCommitId: 't',
  url: 'u',
  role: 'author',
  myVote: null,
  myReviewerId: null,
  reviewers: [],
  newChangesSinceMyReview: false,
  activeThreadCount: 0,
  lastActivityAt: 0,
  ...over
})

const reviewerThread: PrThread = {
  threadId: 9001,
  filePath: '/src/app/sync/rateLimiter.ts',
  line: 12,
  status: 'active',
  isSystem: false,
  comments: [{ authorName: 'Marek Kral', body: 'Should the limit be configurable?', publishedAt: 0 }]
}

const PATH = fixWorktreePath(USER_DATA, { repositoryName: 'intersect-app', prId: 501 })

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function harness(over: Partial<FixManagerDeps> = {}) {
  const closed: FixWorktreeClosedEvent[] = []
  const deps: FixManagerDeps = {
    userDataDir: USER_DATA,
    ado: { getThreads: vi.fn(async () => [reviewerThread]) },
    worktrees: {
      resolveRepoDir: vi.fn(async () => '/repos/intersect-app'),
      createBranchWorktree: vi.fn(async () => ({ diverged: false })),
      removeCleanWorktree: vi.fn(
        async (): Promise<RemoveCleanResult> => ({ outcome: 'removed', detail: null })
      )
    },
    sessions: { whenWorkspaceExited: vi.fn(async () => 'exited' as const) },
    workspaceFolders: () => ['/repos/intersect-app'],
    hasOpenTabs: vi.fn(() => false),
    removeWorkspaceIfEmpty: vi.fn(() => true),
    onClosed: (ev) => closed.push(ev),
    ...over
  }
  return { fix: createFixManager(deps), deps, closed }
}

describe('starting a fix', () => {
  test('creates the worktree on the source branch and parks the comment list for its first tab', async () => {
    const { fix, deps } = harness()

    await expect(fix.start(pr())).resolves.toEqual({ worktreePath: PATH, alreadyOpen: false })

    expect(deps.worktrees.createBranchWorktree).toHaveBeenCalledWith({
      repoDir: '/repos/intersect-app',
      path: PATH,
      branch: 'feature/rate-limit'
    })
    const prompt = fix.takePrompt(PATH)
    expect(prompt).toContain('Should the limit be configurable?')
    expect(fix.takePrompt(PATH)).toBeNull()
  })

  test('tells Claude when the local branch has diverged', async () => {
    const { fix } = harness({
      worktrees: {
        resolveRepoDir: async () => '/repos/intersect-app',
        createBranchWorktree: async () => ({ diverged: true }),
        removeCleanWorktree: async () => ({ outcome: 'removed', detail: null })
      }
    })
    await fix.start(pr())
    expect(fix.takePrompt(PATH)).toMatch(/diverged/i)
  })

  test('a pull request I only review cannot be fixed', async () => {
    const { fix, deps } = harness()
    await expect(fix.start(pr({ role: 'reviewer' }))).rejects.toThrow(/your own pull requests/i)
    expect(deps.worktrees.createBranchWorktree).not.toHaveBeenCalled()
  })

  test('a pull request with no open reviewer comment is refused', async () => {
    const { fix, deps } = harness({
      ado: { getThreads: async () => [{ ...reviewerThread, status: 'fixed' }] }
    })
    await expect(fix.start(pr())).rejects.toThrow('No open reviewer comments on this pull request.')
    expect(deps.worktrees.createBranchWorktree).not.toHaveBeenCalled()
  })

  test('with a tab already open there, nothing is created and no prompt is parked', async () => {
    const { fix, deps } = harness({ hasOpenTabs: (path) => path === PATH })

    await expect(fix.start(pr())).resolves.toEqual({ worktreePath: PATH, alreadyOpen: true })

    expect(deps.worktrees.createBranchWorktree).not.toHaveBeenCalled()
    expect(fix.takePrompt(PATH)).toBeNull()
  })

  test('a second start for the same pull request while one is running is refused', async () => {
    const gate = deferred<{ diverged: boolean }>()
    const { fix } = harness({
      worktrees: {
        resolveRepoDir: async () => '/repos/intersect-app',
        createBranchWorktree: () => gate.promise,
        removeCleanWorktree: async () => ({ outcome: 'removed', detail: null })
      }
    })
    const first = fix.start(pr())
    await expect(fix.start(pr())).rejects.toThrow(/already starting/i)
    gate.resolve({ diverged: false })
    await expect(first).resolves.toMatchObject({ alreadyOpen: false })
    // Once settled, the pull request can be started again.
    await expect(fix.start(pr())).resolves.toMatchObject({ alreadyOpen: false })
  })

  test('the clone is looked for among the workspace folders that are not fix worktrees', async () => {
    const { fix, deps } = harness({ workspaceFolders: () => [PATH, '/repos/intersect-app'] })
    await fix.start(pr())
    expect(deps.worktrees.resolveRepoDir).toHaveBeenCalledWith('intersect-app', [
      '/repos/intersect-app'
    ])
  })

  test('a start waits for a close of the same worktree that is still running', async () => {
    const exited = deferred<'exited' | 'timeout'>()
    const { fix, deps } = harness({ sessions: { whenWorkspaceExited: () => exited.promise } })
    fix.scheduleClose('ws-1', PATH)

    let started = false
    const start = fix.start(pr()).then(() => (started = true))
    await tick()
    expect(started).toBe(false)
    expect(deps.worktrees.createBranchWorktree).not.toHaveBeenCalled()

    exited.resolve('exited')
    await start
    expect(deps.worktrees.removeCleanWorktree).toHaveBeenCalledBefore(
      vi.mocked(deps.worktrees.createBranchWorktree)
    )
  })

  test('a later start overwrites a prompt a failed launch never collected', async () => {
    const threads = [reviewerThread]
    const { fix } = harness({ ado: { getThreads: async () => threads } })
    await fix.start(pr())
    threads[0] = { ...reviewerThread, comments: [{ ...reviewerThread.comments[0], body: 'Newer.' }] }
    await fix.start(pr())
    expect(fix.takePrompt(PATH)).toContain('Newer.')
  })

  test('fix folders are recognised, other folders are not', () => {
    const { fix } = harness()
    expect(fix.isFixFolder(PATH)).toBe(true)
    expect(fix.isFixFolder('/repos/intersect-app')).toBe(false)
  })
})

describe('closing the last tab of a fix workspace', () => {
  test('removal waits until the session has really exited', async () => {
    const exited = deferred<'exited' | 'timeout'>()
    const { fix, deps, closed } = harness({
      sessions: { whenWorkspaceExited: () => exited.promise }
    })

    fix.scheduleClose('ws-1', PATH)
    await tick()
    expect(deps.worktrees.removeCleanWorktree).not.toHaveBeenCalled()

    exited.resolve('exited')
    await vi.waitFor(() => expect(closed).toHaveLength(1))
    expect(deps.worktrees.removeCleanWorktree).toHaveBeenCalledWith(PATH)
    expect(deps.removeWorkspaceIfEmpty).toHaveBeenCalledWith('ws-1')
    expect(closed[0]).toEqual({
      workspaceId: 'ws-1',
      path: PATH,
      outcome: 'removed',
      workspaceRemoved: true,
      detail: null
    })
  })

  test('a tab opened and closed again during the wait has its session waited for too', async () => {
    // The first wait only knows the sessions alive when it began; a tab the user opened and
    // closed meanwhile has a PTY of its own that may still be exiting.
    const first = deferred<'exited' | 'timeout'>()
    const second = deferred<'exited' | 'timeout'>()
    const whenWorkspaceExited = vi
      .fn<(workspaceId: string, timeoutMs: number) => Promise<'exited' | 'timeout'>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue('exited')
    const { fix, deps, closed } = harness({ sessions: { whenWorkspaceExited } })

    fix.scheduleClose('ws-1', PATH)
    first.resolve('exited')
    await tick()
    await tick()
    expect(deps.worktrees.removeCleanWorktree).not.toHaveBeenCalled()

    second.resolve('exited')
    await vi.waitFor(() => expect(closed).toHaveLength(1))
    expect(deps.worktrees.removeCleanWorktree).toHaveBeenCalledTimes(1)
  })

  test('closing again while the first close still waits removes once and reports once', async () => {
    // The real flow: the last tab closes, the user opens another tab and closes it before the
    // first session has exited, so the workspace empties a second time. A queued second cleanup
    // would find the folder already gone and claim it could not be removed.
    const first = deferred<'exited' | 'timeout'>()
    const whenWorkspaceExited = vi
      .fn<(workspaceId: string, timeoutMs: number) => Promise<'exited' | 'timeout'>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue('exited')
    const { fix, deps, closed } = harness({ sessions: { whenWorkspaceExited } })

    fix.scheduleClose('ws-1', PATH)
    await tick()
    fix.scheduleClose('ws-1', PATH)
    first.resolve('exited')

    await vi.waitFor(() => expect(closed).toHaveLength(1))
    await tick()
    await tick()
    expect(closed).toEqual([
      { workspaceId: 'ws-1', path: PATH, outcome: 'removed', workspaceRemoved: true, detail: null }
    ])
    expect(deps.worktrees.removeCleanWorktree).toHaveBeenCalledTimes(1)
  })

  test('a close arriving during the last wait gets one more wait before the removal', async () => {
    // The tab closed during the second wait spawned after the second wait took its list of
    // sessions, so only a third wait covers its PTY.
    const waits = [
      deferred<'exited' | 'timeout'>(),
      deferred<'exited' | 'timeout'>(),
      deferred<'exited' | 'timeout'>()
    ]
    const whenWorkspaceExited = vi
      .fn<(workspaceId: string, timeoutMs: number) => Promise<'exited' | 'timeout'>>()
      .mockReturnValueOnce(waits[0].promise)
      .mockReturnValueOnce(waits[1].promise)
      .mockReturnValueOnce(waits[2].promise)
    const { fix, deps, closed } = harness({ sessions: { whenWorkspaceExited } })

    fix.scheduleClose('ws-1', PATH)
    await tick()
    waits[0].resolve('exited')
    await tick()
    await tick()
    expect(whenWorkspaceExited).toHaveBeenCalledTimes(2)

    fix.scheduleClose('ws-1', PATH)
    waits[1].resolve('exited')
    await tick()
    await tick()
    expect(deps.worktrees.removeCleanWorktree).not.toHaveBeenCalled()
    expect(whenWorkspaceExited).toHaveBeenCalledTimes(3)

    waits[2].resolve('exited')
    await vi.waitFor(() => expect(closed).toHaveLength(1))
    await tick()
    await tick()
    expect(closed).toHaveLength(1)
    expect(deps.worktrees.removeCleanWorktree).toHaveBeenCalledTimes(1)
  })

  test('a session still running after the wait is reported busy and nothing is removed', async () => {
    const { fix, deps, closed } = harness({
      sessions: { whenWorkspaceExited: async () => 'timeout' as const }
    })
    fix.scheduleClose('ws-1', PATH)
    await vi.waitFor(() => expect(closed).toHaveLength(1))
    expect(closed[0]).toMatchObject({ outcome: 'busy', workspaceRemoved: false })
    expect(deps.worktrees.removeCleanWorktree).not.toHaveBeenCalled()
    expect(deps.removeWorkspaceIfEmpty).not.toHaveBeenCalled()
  })

  test('a workspace that is not a fix worktree is left alone', async () => {
    const { fix, deps, closed } = harness()
    fix.scheduleClose('ws-1', '/repos/intersect-app')
    await tick()
    expect(deps.sessions.whenWorkspaceExited).not.toHaveBeenCalled()
    expect(deps.worktrees.removeCleanWorktree).not.toHaveBeenCalled()
    expect(closed).toEqual([])
  })

  test('a tab opened there before the removal starts stops it, silently', async () => {
    const { fix, deps, closed } = harness({ hasOpenTabs: () => true })
    fix.scheduleClose('ws-1', PATH)
    await tick()
    await tick()
    expect(deps.worktrees.removeCleanWorktree).not.toHaveBeenCalled()
    expect(closed).toEqual([])
  })

  test('a tab opened during the removal keeps its workspace', async () => {
    const { fix, closed } = harness({ removeWorkspaceIfEmpty: () => false })
    fix.scheduleClose('ws-1', PATH)
    await vi.waitFor(() => expect(closed).toHaveLength(1))
    expect(closed[0]).toMatchObject({ outcome: 'removed', workspaceRemoved: false })
  })

  test.each([
    ['dirty', 'M feature.txt'],
    ['failed', 'fatal: not a git repository']
  ] as const)('a %s outcome keeps the workspace and carries git’s detail', async (outcome, detail) => {
    const { fix, deps, closed } = harness({
      worktrees: {
        resolveRepoDir: async () => '/repos/intersect-app',
        createBranchWorktree: async () => ({ diverged: false }),
        removeCleanWorktree: async () => ({ outcome, detail })
      }
    })
    fix.scheduleClose('ws-1', PATH)
    await vi.waitFor(() => expect(closed).toHaveLength(1))
    expect(closed[0]).toEqual({ workspaceId: 'ws-1', path: PATH, outcome, workspaceRemoved: false, detail })
    expect(deps.removeWorkspaceIfEmpty).not.toHaveBeenCalled()
  })

  test('an error inside the cleanup never escapes into the tab handler', async () => {
    const warn = vi.fn()
    const { fix } = harness({
      sessions: {
        whenWorkspaceExited: async () => {
          throw new Error('boom')
        }
      },
      logger: { warn }
    })
    expect(() => fix.scheduleClose('ws-1', PATH)).not.toThrow()
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
  })
})
