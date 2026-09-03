import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { Server as NetServer } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { PullRequest, ReviewSession, ReviewStatus } from '@common/domain'
import type { DraftCommentRepo } from '../db/draftCommentRepo'
import type { PrCacheRepo } from '../db/prCacheRepo'
import type { ReviewSessionRepo } from '../db/reviewSessionRepo'
import type { PtyProcess, SpawnRequest } from '../pty/sessionManager'
import { createReviewManager, MAX_CONCURRENT_REVIEWS } from './reviewManager'
import type { CreateWorktreeInput, WorktreeManager } from './worktreeManager'

interface FakePty extends PtyProcess {
  emitData(data: string): void
  emitExit(exitCode: number): void
  writes: string[]
  resizes: { cols: number; rows: number }[]
  killed: boolean
}

function makeFakePty(): FakePty {
  const dataCallbacks: ((data: string) => void)[] = []
  const exitCallbacks: ((event: { exitCode: number }) => void)[] = []
  const pty: FakePty = {
    pid: 42,
    writes: [],
    resizes: [],
    killed: false,
    onData: (callback) => dataCallbacks.push(callback),
    onExit: (callback) => exitCallbacks.push(callback),
    write: (data) => pty.writes.push(data),
    resize: (cols, rows) => pty.resizes.push({ cols, rows }),
    pause: () => {},
    resume: () => {},
    kill: () => {
      pty.killed = true
    },
    emitData: (data) => dataCallbacks.forEach((callback) => callback(data)),
    emitExit: (exitCode) => exitCallbacks.forEach((callback) => callback({ exitCode }))
  }
  return pty
}

const basePr: PullRequest = {
  prId: 33,
  repositoryId: 'repo-id',
  repositoryName: 'Intersect',
  projectId: 'project-id',
  title: 'Use ordinary Claude Code for reviews',
  description: '',
  authorId: 'author-id',
  authorName: 'Author',
  createdAt: 1,
  status: 'active',
  sourceRefName: 'refs/heads/fix/review-shell',
  targetRefName: 'refs/heads/main',
  sourceCommitId: 'abc123',
  targetCommitId: 'def456',
  url: 'https://example.test/pr/33',
  role: 'reviewer',
  myVote: null,
  myReviewerId: 'reviewer-id',
  reviewers: [],
  newChangesSinceMyReview: false,
  activeThreadCount: 0,
  lastActivityAt: 1
}

const pr = basePr
/** A second pull request, in the same repository so both reviews share one clone. */
const otherPr: PullRequest = { ...basePr, prId: 34, url: 'https://example.test/pr/34' }

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'intersect-review-manager-'))
  const rows = new Map<string, ReviewSession>()
  const ptys: FakePty[] = []
  const spawned: SpawnRequest[] = []
  const statuses: { id: string; status: ReviewStatus }[] = []
  const removedWorktrees: string[] = []
  const createdWorktrees: CreateWorktreeInput[] = []
  const sentData: { sessionId: string; data: string }[] = []
  const sentExit: { sessionId: string; exitCode: number }[] = []
  let reviewPrompt = 'Initial review prompt.'
  let reviewModel = 'opus'
  let nextId = 0

  const fakeSocketServer = {} as NetServer
  fakeSocketServer.on = vi.fn(() => fakeSocketServer) as typeof fakeSocketServer.on
  fakeSocketServer.once = vi.fn(() => fakeSocketServer) as typeof fakeSocketServer.once
  fakeSocketServer.off = vi.fn(() => fakeSocketServer) as typeof fakeSocketServer.off
  fakeSocketServer.listen = vi.fn((...args: unknown[]) => {
    const callback = args.find((arg) => typeof arg === 'function') as (() => void) | undefined
    callback?.()
    return fakeSocketServer
  }) as typeof fakeSocketServer.listen
  fakeSocketServer.close = vi.fn(() => fakeSocketServer) as typeof fakeSocketServer.close

  const reviewSessions = {
    create: vi.fn((input: Omit<ReviewSession, 'id' | 'status' | 'createdAt'>) => {
      const session: ReviewSession = {
        ...input,
        id: `rs-${++nextId}`,
        status: 'running',
        createdAt: nextId
      }
      rows.set(session.id, session)
      return session
    }),
    listActive: vi.fn(() => [...rows.values()].filter((r) => r.status === 'running')),
    get: vi.fn((id: string) => rows.get(id)),
    setStatus: vi.fn((id: string, status: ReviewStatus) => {
      statuses.push({ id, status })
      const next = { ...(rows.get(id) as ReviewSession), status }
      rows.set(id, next)
      return next
    }),
    remove: vi.fn()
  } as unknown as ReviewSessionRepo

  // Deliberately unserialized, unlike production: these tests must be able to observe two starts
  // overlapping. The real clone queue lives in worktreeManager and has its own tests.
  const worktrees: WorktreeManager = {
    resolveRepoDir: vi.fn(async () => '/repo'),
    createWorktree: vi.fn(async (input: CreateWorktreeInput) => {
      createdWorktrees.push(input)
      const path = join(root, `wt-${createdWorktrees.length}`)
      await mkdir(path, { recursive: true })
      return path
    }),
    removeWorktree: vi.fn(async (_repoDir: string, path: string) => {
      removedWorktrees.push(path)
    }),
    pruneStale: vi.fn(async () => {})
  }

  const manager = createReviewManager({
    reviewSessions,
    drafts: {} as DraftCommentRepo,
    prCache: {} as PrCacheRepo,
    worktrees,
    workspaceFolders: () => ['/repo'],
    spawn: (request) => {
      spawned.push(request)
      const pty = makeFakePty()
      ptys.push(pty)
      return pty
    },
    sendData: (sessionId, data) => sentData.push({ sessionId, data }),
    sendExit: (sessionId, exitCode) => sentExit.push({ sessionId, exitCode }),
    onDraft: () => {},
    reviewPrompt: () => reviewPrompt,
    reviewModel: () => reviewModel,
    draftServerPath: '/Applications/Intersect/draft server.js',
    createSocketServer: vi.fn(() => fakeSocketServer) as unknown as typeof import('node:net').createServer
  })

  return {
    root,
    manager,
    worktrees,
    reviewSessions,
    ptys,
    spawned,
    statuses,
    rows,
    removedWorktrees,
    createdWorktrees,
    sentData,
    sentExit,
    /** The worktree the n-th (0-based) started review was given. */
    worktreeOf: (n: number) => join(root, `wt-${n + 1}`),
    statusesOf: (sessionId: string) =>
      statuses.filter((s) => s.id === sessionId).map((s) => s.status),
    setReviewPrompt: (prompt: string) => {
      reviewPrompt = prompt
    },
    setReviewModel: (model: string) => {
      reviewModel = model
    }
  }
}

describe('reviewManager', () => {
  let h: Awaited<ReturnType<typeof harness>>

  beforeEach(async () => {
    h = await harness()
  })

  afterEach(async () => {
    h.manager.shutdown()
    await rm(h.root, { recursive: true, force: true })
  })

  test('types the interactive review command once, after the login shell first emits output', async () => {
    await h.manager.start(pr, '# Review context', 120, 32)

    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0]).toMatchObject({
      file: process.env.SHELL || '/bin/zsh',
      args: ['-l'],
      cwd: h.worktreeOf(0),
      cols: 120,
      rows: 32
    })
    expect(h.ptys[0].writes).toEqual([])

    h.ptys[0].emitData('shell prompt')
    h.ptys[0].emitData('claude output')

    expect(h.ptys[0].writes).toHaveLength(1)
    expect(h.ptys[0].writes[0]).toContain('stty -ixon; claude ')
    expect(h.ptys[0].writes[0]).toContain('--mcp-config')
    expect(h.spawned[0].env.INTERSECT_REVIEW_SYSTEM_PROMPT).toContain('record_draft_comment')
    expect(h.ptys[0].writes[0]).toMatch(/\r$/)
  })

  test('reads the latest configured review prompt and model when a review starts', async () => {
    h.setReviewPrompt("Review in English. Check O'Brien's change.")
    h.setReviewModel('claude-opus-5')

    await h.manager.start(pr, '# Review context', 80, 24)
    h.ptys[0].emitData('shell prompt')

    expect(h.ptys[0].writes).toHaveLength(1)
    expect(h.spawned[0].env.INTERSECT_REVIEW_PROMPT).toBe(
      "Review in English. Check O'Brien's change."
    )
    expect(h.spawned[0].env.INTERSECT_REVIEW_MODEL).toBe('claude-opus-5')
    expect(h.ptys[0].writes[0]).toContain('"$INTERSECT_REVIEW_PROMPT"')
    expect(h.ptys[0].writes[0]).not.toContain("O'Brien")
    expect(h.ptys[0].writes[0]).not.toContain('Initial review prompt.')
  })

  test.each(['', '  \n\t '])('preserves an intentionally blank prompt at spawn time', async (prompt) => {
    h.setReviewPrompt(prompt)

    await h.manager.start(pr, '# Review context', 80, 24)
    h.ptys[0].emitData('shell prompt')

    expect(h.spawned[0].env.INTERSECT_REVIEW_PROMPT).toBe(prompt)
  })

  test('preserves interactive input, resize, and terminal output forwarding', async () => {
    const session = await h.manager.start(pr, '# Review context', 80, 24)

    h.manager.input(session.id, 'answer\r')
    h.manager.resize(session.id, 140, 48)
    h.ptys[0].emitData('ready')

    expect(h.ptys[0].writes[0]).toBe('answer\r')
    expect(h.ptys[0].writes[1]).toContain('stty -ixon; claude ')
    expect(h.ptys[0].resizes).toEqual([{ cols: 140, rows: 48 }])
    expect(h.sentData).toEqual([{ sessionId: session.id, data: 'ready' }])
  })

  test('preserves the draft MCP config and exit cleanup lifecycle', async () => {
    const session = await h.manager.start(pr, '# Review context', 80, 24)

    const mcpConfigPath = join(h.worktreeOf(0), '.intersect-review-mcp.json')
    const config = JSON.parse(await readFile(mcpConfigPath, 'utf8')) as {
      mcpServers: { intersectReview: { command: string; args: string[]; env: Record<string, string> } }
    }
    expect(config.mcpServers.intersectReview).toMatchObject({
      command: 'node',
      args: ['/Applications/Intersect/draft server.js'],
      env: { INTERSECT_REVIEW_SESSION: session.id, INTERSECT_DRAFT_SOCK: expect.any(String) }
    })

    h.ptys[0].emitExit(0)

    expect(h.sentExit).toEqual([{ sessionId: session.id, exitCode: 0 }])
    await vi.waitFor(() => {
      expect(h.statusesOf(session.id)).toEqual(['completed', 'cleaned'])
      expect(h.removedWorktrees).toEqual([h.worktreeOf(0)])
    })
    await expect(access(mcpConfigPath)).rejects.toThrow()
  })

  test('two reviews run at once and route input, resize, and output by session id', async () => {
    const first = await h.manager.start(pr, '# first', 80, 24)
    const second = await h.manager.start(otherPr, '# second', 100, 30)

    expect(first.id).not.toBe(second.id)
    expect(h.ptys).toHaveLength(2)
    expect(h.manager.listLive().map((s) => s.prId).sort()).toEqual([33, 34])

    h.manager.input(second.id, 'to the second\r')
    h.manager.resize(second.id, 200, 60)
    h.ptys[0].emitData('from the first')
    h.ptys[1].emitData('from the second')

    expect(h.ptys[0].writes).toEqual([expect.stringContaining('stty -ixon; claude ')])
    expect(h.ptys[0].resizes).toEqual([])
    expect(h.ptys[1].writes[0]).toBe('to the second\r')
    expect(h.ptys[1].resizes).toEqual([{ cols: 200, rows: 60 }])
    expect(h.sentData).toEqual([
      { sessionId: first.id, data: 'from the first' },
      { sessionId: second.id, data: 'from the second' }
    ])
  })

  test('input for an unknown session goes nowhere rather than to some other review', async () => {
    const session = await h.manager.start(pr, '# Review context', 80, 24)
    h.ptys[0].emitData('ready')
    const before = h.ptys[0].writes.length

    h.manager.input('rs-does-not-exist', 'stray\r')
    h.manager.resize('rs-does-not-exist', 10, 10)

    expect(h.ptys[0].writes).toHaveLength(before)
    expect(h.ptys[0].resizes).toEqual([])
    expect(h.manager.listLive().map((s) => s.id)).toEqual([session.id])
  })

  test('a second start on a pull request already under review returns the live session', async () => {
    const first = await h.manager.start(pr, '# Review context', 80, 24)
    const again = await h.manager.start(pr, '# Review context', 80, 24)

    expect(again.id).toBe(first.id)
    expect(h.spawned).toHaveLength(1)
    expect(h.createdWorktrees).toHaveLength(1)
    expect(h.reviewSessions.create).toHaveBeenCalledTimes(1)
  })

  test('two concurrent starts on one pull request never produce two sessions', async () => {
    const [first, second] = await Promise.allSettled([
      h.manager.start(pr, '# Review context', 80, 24),
      h.manager.start(pr, '# Review context', 80, 24)
    ])

    // One wins; the other is refused rather than opening a second worktree on the same PR.
    const outcomes = [first.status, second.status].sort()
    expect(outcomes).toEqual(['fulfilled', 'rejected'])
    expect(h.spawned).toHaveLength(1)
    expect(h.manager.listLive()).toHaveLength(1)
  })

  test('ending one review leaves every other one running', async () => {
    const first = await h.manager.start(pr, '# first', 80, 24)
    const second = await h.manager.start(otherPr, '# second', 80, 24)

    await h.manager.end(first.id)
    expect(h.ptys[0].killed).toBe(true)
    expect(h.ptys[1].killed).toBe(false)

    h.ptys[0].emitExit(0)

    await vi.waitFor(() => {
      expect(h.removedWorktrees).toEqual([h.worktreeOf(0)])
    })
    expect(h.statusesOf(second.id)).toEqual([])
    expect(h.sentExit).toEqual([{ sessionId: first.id, exitCode: 0 }])
    expect(h.manager.listLive().map((s) => s.id)).toEqual([second.id])
  })

  test('a failed start rolls back only its own state and leaves live reviews alone', async () => {
    const running = await h.manager.start(pr, '# first', 80, 24)
    vi.mocked(h.worktrees.createWorktree).mockRejectedValueOnce(new Error('fetch failed'))

    await expect(h.manager.start(otherPr, '# second', 80, 24)).rejects.toThrow(/fetch failed/)

    expect(h.manager.listLive().map((s) => s.id)).toEqual([running.id])
    expect(h.statusesOf(running.id)).toEqual([])
    expect(h.ptys[0].killed).toBe(false)
    // The refused pull request is not left looking busy: it can be started again.
    const retried = await h.manager.start(otherPr, '# second', 80, 24)
    expect(retried.prId).toBe(34)
  })

  test('a start that fails after its row exists marks that row failed, not another', async () => {
    const running = await h.manager.start(pr, '# first', 80, 24)
    vi.mocked(h.worktrees.createWorktree).mockImplementationOnce(async () => '/nope/missing')

    await expect(h.manager.start(otherPr, '# second', 80, 24)).rejects.toThrow()

    const failed = [...h.rows.values()].find((r) => r.prId === 34)
    expect(failed?.status).toBe('failed')
    expect(h.statusesOf(running.id)).toEqual([])
  })

  test(`refuses the review past ${MAX_CONCURRENT_REVIEWS} without creating a worktree or a row`, async () => {
    for (let i = 0; i < MAX_CONCURRENT_REVIEWS; i++) {
      await h.manager.start({ ...basePr, prId: 100 + i }, '# ctx', 80, 24)
    }
    const worktreesBefore = h.createdWorktrees.length
    const rowsBefore = h.rows.size

    await expect(h.manager.start({ ...basePr, prId: 999 }, '# ctx', 80, 24)).rejects.toThrow(
      /already running/i
    )

    expect(h.createdWorktrees).toHaveLength(worktreesBefore)
    expect(h.rows.size).toBe(rowsBefore)
    expect(h.manager.listLive()).toHaveLength(MAX_CONCURRENT_REVIEWS)
  })

  test('a finished review frees its slot under the cap', async () => {
    const sessions: ReviewSession[] = []
    for (let i = 0; i < MAX_CONCURRENT_REVIEWS; i++) {
      sessions.push(await h.manager.start({ ...basePr, prId: 100 + i }, '# ctx', 80, 24))
    }
    h.ptys[0].emitExit(0)

    await expect(h.manager.start({ ...basePr, prId: 999 }, '# ctx', 80, 24)).resolves.toMatchObject({
      prId: 999
    })
    expect(h.manager.listLive().map((s) => s.id)).not.toContain(sessions[0].id)
  })

  test('pruneOnBoot cleans every leftover running row, not just the first', async () => {
    h.rows.set('old-1', {
      id: 'old-1',
      prId: 1,
      repositoryId: 'repo-id',
      repoDir: '/repo',
      worktreePath: '/wt/1',
      status: 'running',
      createdAt: 1
    })
    h.rows.set('old-2', {
      id: 'old-2',
      prId: 2,
      repositoryId: 'repo-id',
      repoDir: '/repo',
      worktreePath: '/wt/2',
      status: 'running',
      createdAt: 2
    })

    await h.manager.pruneOnBoot()

    expect(h.statusesOf('old-1')).toEqual(['cleaned'])
    expect(h.statusesOf('old-2')).toEqual(['cleaned'])
    expect(h.worktrees.pruneStale).toHaveBeenCalledWith(['/repo'])
  })

  test('a review started during the boot sweep waits for it, so the sweep cannot delete it', async () => {
    let releaseSweep = (): void => {}
    vi.mocked(h.worktrees.pruneStale).mockImplementationOnce(
      () => new Promise<void>((resolve) => (releaseSweep = resolve))
    )
    const boot = h.manager.pruneOnBoot()

    const starting = h.manager.start(pr, '# Review context', 80, 24)
    await Promise.resolve()
    expect(h.createdWorktrees).toHaveLength(0)

    releaseSweep()
    await boot
    await starting
    expect(h.createdWorktrees).toHaveLength(1)
  })

  test('shutdown kills every live pty and writes nothing to the database', async () => {
    await h.manager.start(pr, '# first', 80, 24)
    await h.manager.start(otherPr, '# second', 80, 24)
    const statusWrites = h.statuses.length

    h.manager.shutdown()

    expect(h.ptys.every((p) => p.killed)).toBe(true)
    expect(h.statuses).toHaveLength(statusWrites)
    expect(h.manager.listLive()).toEqual([])
  })
})
