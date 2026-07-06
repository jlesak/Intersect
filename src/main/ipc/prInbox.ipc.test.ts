import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { FileDiff, PrChangeFile, PrThread, PullRequest, ReviewSession } from '@common/domain'
import { createDraftCommentRepo, type DraftCommentRepo } from '../db/draftCommentRepo'
import { createPrCacheRepo, type PrCacheRepo } from '../db/prCacheRepo'
import { createPrReviewWatermarkRepo, type PrReviewWatermarkRepo } from '../db/prReviewWatermarkRepo'
import { makeTestDb, makeTestDeps } from '../db/testkit'
import type { AdoService, SyncResult } from '../prInbox/adoService'
import type { ReviewManager } from '../prInbox/reviewManager'
import { buildReviewContext, createPrInboxHandlers, type PrInboxHandlers } from './prInbox.ipc'

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  prId: 100,
  repositoryId: 'repo-a',
  repositoryName: 'spot-backend',
  projectId: 'SPOT',
  title: 'a change',
  authorId: 'a1',
  authorName: 'Jan',
  createdAt: 1000,
  status: 'active',
  sourceRefName: 'refs/heads/feature/x',
  targetRefName: 'refs/heads/main',
  sourceCommitId: 'src-sha',
  targetCommitId: 'tgt-sha',
  url: 'https://ado/pr/100',
  role: 'author',
  myVote: null,
  reviewers: [],
  newChangesSinceMyReview: false,
  ...over
})

function makeAdo(over: Partial<AdoService> = {}): { ado: AdoService; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { publishComment: [], syncMyPrs: [] }
  const ado: AdoService = {
    syncMyPrs: vi.fn(async (): Promise<SyncResult> => ({ prs: [pr()], failedRepos: [] })),
    getChanges: vi.fn(
      async (): Promise<PrChangeFile[]> => [{ path: 'src/a.ts', changeType: 'edit', originalPath: null }]
    ),
    getFileDiff: vi.fn(
      async (): Promise<FileDiff> => ({
        path: 'src/a.ts',
        original: 'old',
        modified: 'new',
        language: 'typescript',
        binary: false,
        tooLarge: false
      })
    ),
    getThreads: vi.fn(async (): Promise<PrThread[]> => []),
    publishComment: vi.fn(async (input) => {
      calls.publishComment.push(input)
      return 5555
    }),
    ...over
  }
  return { ado, calls }
}

function makeReview(over: Partial<ReviewManager> = {}): ReviewManager {
  return {
    start: vi.fn(
      async (p: PullRequest): Promise<ReviewSession> => ({
        id: 'rs-1',
        prId: p.prId,
        repositoryId: p.repositoryId,
        repoDir: '/clone',
        worktreePath: '/wt',
        status: 'running',
        createdAt: 1
      })
    ),
    input: vi.fn(),
    resize: vi.fn(),
    end: vi.fn(async () => {}),
    shutdown: vi.fn(),
    pruneOnBoot: vi.fn(async () => {}),
    ...over
  }
}

describe('prInbox handlers', () => {
  let prCache: PrCacheRepo
  let drafts: DraftCommentRepo
  let watermarks: PrReviewWatermarkRepo

  beforeEach(() => {
    const db = makeTestDb()
    const deps = makeTestDeps()
    prCache = createPrCacheRepo(db, deps)
    drafts = createDraftCommentRepo(db, deps)
    watermarks = createPrReviewWatermarkRepo(db, deps)
  })

  function handlers(overrides: {
    ado?: ReturnType<typeof makeAdo>
    review?: ReviewManager
    warn?: (m: string) => void
  } = {}): { h: PrInboxHandlers; ado: ReturnType<typeof makeAdo> } {
    const ado = overrides.ado ?? makeAdo()
    const h = createPrInboxHandlers({
      prCache,
      drafts,
      watermarks,
      ado: ado.ado,
      review: overrides.review ?? makeReview(),
      atomically: (fn) => fn(),
      warn: overrides.warn
    })
    return { h, ado }
  }

  test('sync fetches, caches, and returns the fresh list', async () => {
    const { h } = handlers()
    const result = await h.sync()
    expect(result.map((p) => p.prId)).toEqual([100])
    expect(prCache.list()).toHaveLength(1)
  })

  test('the first sync of a voted PR seeds the watermark without flagging it (bootstrap)', async () => {
    const reviewed = pr({ role: 'reviewer', myVote: 'approved', sourceCommitId: 'commit-1' })
    const ado = makeAdo({ syncMyPrs: vi.fn(async () => ({ prs: [reviewed], failedRepos: [] })) })
    const { h } = handlers({ ado })
    const result = await h.sync()
    expect(result[0].newChangesSinceMyReview).toBe(false)
    expect(watermarks.get('repo-a', 100)?.votedCommitId).toBe('commit-1')
  })

  test('a later sync with a moved source commit flags the PR on sync and list alike', async () => {
    const reviewed = (commit: string): PullRequest =>
      pr({ role: 'reviewer', myVote: 'approved', sourceCommitId: commit })
    const syncMyPrs = vi
      .fn<() => Promise<SyncResult>>()
      .mockResolvedValueOnce({ prs: [reviewed('commit-1')], failedRepos: [] })
      .mockResolvedValueOnce({ prs: [reviewed('commit-2')], failedRepos: [] })
    const { h } = handlers({ ado: makeAdo({ syncMyPrs }) })
    await h.sync()
    const second = await h.sync()
    expect(second[0].newChangesSinceMyReview).toBe(true)
    const listed = await h.list()
    expect(listed[0].newChangesSinceMyReview).toBe(true)
  })

  test('re-voting on the updated PR moves the watermark and clears the flag', async () => {
    const syncMyPrs = vi
      .fn<() => Promise<SyncResult>>()
      .mockResolvedValueOnce({
        prs: [pr({ role: 'reviewer', myVote: 'waiting', sourceCommitId: 'commit-1' })],
        failedRepos: []
      })
      .mockResolvedValueOnce({
        prs: [pr({ role: 'reviewer', myVote: 'approved', sourceCommitId: 'commit-2' })],
        failedRepos: []
      })
    const { h } = handlers({ ado: makeAdo({ syncMyPrs }) })
    await h.sync()
    const second = await h.sync()
    expect(second[0].newChangesSinceMyReview).toBe(false)
    expect(watermarks.get('repo-a', 100)?.votedCommitId).toBe('commit-2')
  })

  test('a PR gone from the sync has its watermark pruned', async () => {
    const syncMyPrs = vi
      .fn<() => Promise<SyncResult>>()
      .mockResolvedValueOnce({
        prs: [pr({ role: 'reviewer', myVote: 'approved' })],
        failedRepos: []
      })
      .mockResolvedValueOnce({ prs: [], failedRepos: [] })
    const { h } = handlers({ ado: makeAdo({ syncMyPrs }) })
    await h.sync()
    expect(watermarks.get('repo-a', 100)).toBeDefined()
    await h.sync()
    expect(watermarks.get('repo-a', 100)).toBeUndefined()
  })

  test('a vote withdrawn to noVote drops the watermark', async () => {
    const syncMyPrs = vi
      .fn<() => Promise<SyncResult>>()
      .mockResolvedValueOnce({
        prs: [pr({ role: 'reviewer', myVote: 'approved' })],
        failedRepos: []
      })
      .mockResolvedValueOnce({
        prs: [pr({ role: 'reviewer', myVote: 'noVote' })],
        failedRepos: []
      })
    const { h } = handlers({ ado: makeAdo({ syncMyPrs }) })
    await h.sync()
    await h.sync()
    expect(watermarks.get('repo-a', 100)).toBeUndefined()
  })

  test('sync warns about repos that failed but still caches the rest', async () => {
    const warn = vi.fn()
    const ado = makeAdo({ syncMyPrs: vi.fn(async () => ({ prs: [pr()], failedRepos: ['spot-frontend'] })) })
    const { h } = handlers({ ado, warn })
    await h.sync()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('spot-frontend'))
  })

  test('a failed repo keeps its last-known PRs and their review watermark across the sync', async () => {
    // First sync: I have reviewed PR 200 in spot-frontend at commit c1; the author pushes c2.
    const reviewed = pr({
      prId: 200,
      repositoryId: 'repo-b',
      repositoryName: 'spot-frontend',
      role: 'reviewer',
      myVote: 'approved',
      sourceCommitId: 'c1'
    })
    const okSync = makeAdo({
      syncMyPrs: vi.fn(async () => ({ prs: [pr(), reviewed], failedRepos: [] }))
    })
    const { h: h1 } = handlers({ ado: okSync })
    await h1.sync()

    const pushed = { ...reviewed, sourceCommitId: 'c2' }
    const pushSync = makeAdo({
      syncMyPrs: vi.fn(async () => ({ prs: [pr(), pushed], failedRepos: [] }))
    })
    const { h: h2 } = handlers({ ado: pushSync })
    const afterPush = await h2.sync()
    expect(afterPush.find((p) => p.prId === 200)?.newChangesSinceMyReview).toBe(true)

    // The repo fails one sync: its PR must survive with the flag, not vanish or re-baseline.
    const failedSync = makeAdo({
      syncMyPrs: vi.fn(async () => ({ prs: [pr()], failedRepos: ['spot-frontend'] }))
    })
    const { h: h3 } = handlers({ ado: failedSync, warn: vi.fn() })
    const afterFailure = await h3.sync()
    expect(afterFailure.find((p) => p.prId === 200)?.newChangesSinceMyReview).toBe(true)

    // The repo recovers: the flag still stands because the watermark was never re-seeded.
    const { h: h4 } = handlers({ ado: pushSync })
    const afterRecovery = await h4.sync()
    expect(afterRecovery.find((p) => p.prId === 200)?.newChangesSinceMyReview).toBe(true)
  })

  test('getFileDiff resolves the change type and diff base commits from the cached PR', async () => {
    const { h, ado } = handlers()
    prCache.replaceAll([pr()])
    await h.getFileDiff('repo-a', 100, 'src/a.ts')
    expect(ado.ado.getFileDiff).toHaveBeenCalledWith(
      expect.objectContaining({ sourceCommit: 'src-sha', targetCommit: 'tgt-sha', changeType: 'edit' })
    )
  })

  test('addManualDraft then listDrafts round-trips', async () => {
    const { h } = handlers()
    await h.addManualDraft({ prId: 100, repositoryId: 'repo-a', filePath: 'src/a.ts', line: 3, side: 'right', body: 'x' })
    expect(await h.listDrafts('repo-a', 100)).toHaveLength(1)
  })

  test('publishDraft posts to ADO and marks the draft published with the thread id', async () => {
    const { h, ado } = handlers()
    prCache.replaceAll([pr()])
    const d = await h.addManualDraft({ prId: 100, repositoryId: 'repo-a', filePath: 'src/a.ts', line: 3, side: 'right', body: 'x' })
    const published = await h.publishDraft(d.id)
    expect(ado.calls.publishComment).toHaveLength(1)
    expect(published.status).toBe('published')
    expect(published.publishedThreadId).toBe(5555)
  })

  test('publishDraft refuses a left-side draft (e.g. one recorded by the review session)', async () => {
    const { h } = handlers()
    prCache.replaceAll([pr()])
    // addManualDraft forces right-side, so create a left-side draft directly (as the draft socket could).
    const d = drafts.create(
      { prId: 100, repositoryId: 'repo-a', filePath: 'src/a.ts', line: 3, side: 'left', body: 'x' },
      'claude'
    )
    await expect(h.publishDraft(d.id)).rejects.toThrow(/right-side/i)
  })

  test('addManualDraft forces right-side even if left is requested', async () => {
    const { h } = handlers()
    const d = await h.addManualDraft({ prId: 100, repositoryId: 'repo-a', filePath: 'src/a.ts', line: 3, side: 'left', body: 'x' })
    expect(d.side).toBe('right')
  })

  test('publishDraft refuses a draft anchored to a file not in the PR', async () => {
    const { h } = handlers()
    prCache.replaceAll([pr()])
    const d = await h.addManualDraft({ prId: 100, repositoryId: 'repo-a', filePath: 'src/ghost.ts', line: 1, side: 'right', body: 'x' })
    await expect(h.publishDraft(d.id)).rejects.toThrow(/not changed/i)
  })

  test('publishDraft is idempotent under a double call (second loses the claim)', async () => {
    const { h, ado } = handlers()
    prCache.replaceAll([pr()])
    const d = await h.addManualDraft({ prId: 100, repositoryId: 'repo-a', filePath: 'src/a.ts', line: 3, side: 'right', body: 'x' })
    await h.publishDraft(d.id)
    await expect(h.publishDraft(d.id)).rejects.toThrow(/already published|being published/i)
    expect(ado.calls.publishComment).toHaveLength(1)
  })

  test('publishDraft reverts the draft to pending when the ADO write fails', async () => {
    const ado = makeAdo({
      publishComment: vi.fn(async () => {
        throw new Error('ADO down')
      })
    })
    const { h } = handlers({ ado })
    prCache.replaceAll([pr()])
    const d = await h.addManualDraft({ prId: 100, repositoryId: 'repo-a', filePath: 'src/a.ts', line: 3, side: 'right', body: 'x' })
    await expect(h.publishDraft(d.id)).rejects.toThrow(/ADO down/)
    expect(drafts.get(d.id)?.status).toBe('pending')
  })

  test('discardDraft hides the draft from the list', async () => {
    const { h } = handlers()
    const d = await h.addManualDraft({ prId: 100, repositoryId: 'repo-a', filePath: 'src/a.ts', line: 3, side: 'right', body: 'x' })
    await h.discardDraft(d.id)
    expect(await h.listDrafts('repo-a', 100)).toEqual([])
  })

  test('startReview builds context from changes and starts the review', async () => {
    const review = makeReview()
    const { h } = handlers({ review })
    prCache.replaceAll([pr()])
    const session = await h.startReview('repo-a', 100)
    expect(session.id).toBe('rs-1')
    expect(review.start).toHaveBeenCalled()
    const context = (review.start as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    expect(context).toContain('PR 100')
    expect(context).toContain('src/a.ts')
  })

  test('startReview on an unknown PR throws to sync first', async () => {
    const { h } = handlers()
    await expect(h.startReview('repo-a', 999)).rejects.toThrow(/sync first/i)
  })
})

describe('buildReviewContext', () => {
  test('summarizes the PR and changed files', () => {
    const md = buildReviewContext(pr(), [
      { path: 'src/a.ts', changeType: 'edit', originalPath: null },
      { path: 'src/b.ts', changeType: 'add', originalPath: null }
    ])
    expect(md).toContain('# PR 100: a change')
    expect(md).toContain('- edit: src/a.ts')
    expect(md).toContain('- add: src/b.ts')
  })
})
