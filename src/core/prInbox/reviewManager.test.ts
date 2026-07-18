import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { Server as NetServer } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { PullRequest, ReviewSession } from '@common/domain'
import type { DraftCommentRepo } from '../db/draftCommentRepo'
import type { PrCacheRepo } from '../db/prCacheRepo'
import type { ReviewSessionRepo } from '../db/reviewSessionRepo'
import type { PtyProcess, SpawnRequest } from '../pty/sessionManager'
import { createReviewManager } from './reviewManager'
import type { WorktreeManager } from './worktreeManager'

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

const pr: PullRequest = {
  prId: 33,
  repositoryId: 'repo-id',
  repositoryName: 'Intersect',
  projectId: 'project-id',
  title: 'Use ordinary Claude Code for reviews',
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
  activeThreadCount: 0
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'intersect-review-manager-'))
  const worktreePath = join(root, 'worktree')
  await mkdir(worktreePath)
  const session: ReviewSession = {
    id: randomUUID(),
    prId: pr.prId,
    repositoryId: pr.repositoryId,
    repoDir: '/repo',
    worktreePath,
    status: 'running',
    createdAt: 1
  }
  const pty = makeFakePty()
  const spawned: SpawnRequest[] = []
  const statuses: string[] = []
  const removedWorktrees: string[] = []
  const sentData: string[] = []
  const sentExit: number[] = []
  let reviewPrompt = 'Initial review prompt.'
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
    create: vi.fn(() => session),
    getActive: vi.fn(() => undefined),
    get: vi.fn(() => session),
    setStatus: vi.fn((_id: string, status: ReviewSession['status']) => {
      statuses.push(status)
      return { ...session, status }
    }),
    remove: vi.fn()
  } as unknown as ReviewSessionRepo
  const worktrees: WorktreeManager = {
    resolveRepoDir: vi.fn(async () => '/repo'),
    createWorktree: vi.fn(async () => worktreePath),
    removeWorktree: vi.fn(async (_repoDir, path) => {
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
      return pty
    },
    sendData: (data) => sentData.push(data),
    sendExit: (code) => sentExit.push(code),
    onDraft: () => {},
    reviewPrompt: () => reviewPrompt,
    draftServerPath: '/Applications/Intersect/draft server.js',
    createSocketServer: vi.fn(() => fakeSocketServer) as unknown as typeof import('node:net').createServer
  })

  return {
    root,
    worktreePath,
    manager,
    pty,
    spawned,
    statuses,
    removedWorktrees,
    sentData,
    sentExit,
    setReviewPrompt: (prompt: string) => {
      reviewPrompt = prompt
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
      cwd: h.worktreePath,
      cols: 120,
      rows: 32
    })
    expect(h.pty.writes).toEqual([])

    h.pty.emitData('shell prompt')
    h.pty.emitData('claude output')

    expect(h.pty.writes).toHaveLength(1)
    expect(h.pty.writes[0]).toContain('stty -ixon; claude ')
    expect(h.pty.writes[0]).toContain('--mcp-config')
    expect(h.spawned[0].env.INTERSECT_REVIEW_SYSTEM_PROMPT).toContain('record_draft_comment')
    expect(h.pty.writes[0]).toMatch(/\r$/)
  })

  test('reads the latest configured review prompt when a review starts', async () => {
    h.setReviewPrompt("Review in English. Check O'Brien's change.")

    await h.manager.start(pr, '# Review context', 80, 24)
    h.pty.emitData('shell prompt')

    expect(h.pty.writes).toHaveLength(1)
    expect(h.spawned[0].env.INTERSECT_REVIEW_PROMPT).toBe(
      "Review in English. Check O'Brien's change."
    )
    expect(h.pty.writes[0]).toContain('"$INTERSECT_REVIEW_PROMPT"')
    expect(h.pty.writes[0]).not.toContain("O'Brien")
    expect(h.pty.writes[0]).not.toContain('Initial review prompt.')
  })

  test.each(['', '  \n\t '])('preserves an intentionally blank prompt at spawn time', async (prompt) => {
    h.setReviewPrompt(prompt)

    await h.manager.start(pr, '# Review context', 80, 24)
    h.pty.emitData('shell prompt')

    expect(h.spawned[0].env.INTERSECT_REVIEW_PROMPT).toBe(prompt)
  })

  test('preserves interactive input, resize, and terminal output forwarding', async () => {
    await h.manager.start(pr, '# Review context', 80, 24)

    h.manager.input('answer\r')
    h.manager.resize(140, 48)
    h.pty.emitData('ready')

    expect(h.pty.writes[0]).toBe('answer\r')
    expect(h.pty.writes[1]).toContain('stty -ixon; claude ')
    expect(h.pty.resizes).toEqual([{ cols: 140, rows: 48 }])
    expect(h.sentData).toEqual(['ready'])
  })

  test('preserves the draft MCP config and exit cleanup lifecycle', async () => {
    await h.manager.start(pr, '# Review context', 80, 24)

    const mcpConfigPath = join(h.worktreePath, '.intersect-review-mcp.json')
    const config = JSON.parse(await readFile(mcpConfigPath, 'utf8')) as {
      mcpServers: { intersectReview: { command: string; args: string[]; env: Record<string, string> } }
    }
    expect(config.mcpServers.intersectReview).toMatchObject({
      command: 'node',
      args: ['/Applications/Intersect/draft server.js'],
      env: { INTERSECT_REVIEW_SESSION: expect.any(String), INTERSECT_DRAFT_SOCK: expect.any(String) }
    })

    h.pty.emitExit(0)

    expect(h.sentExit).toEqual([0])
    await vi.waitFor(() => {
      expect(h.statuses).toEqual(['completed', 'cleaned'])
      expect(h.removedWorktrees).toEqual([h.worktreePath])
    })
    await expect(access(mcpConfigPath)).rejects.toThrow()
  })
})
