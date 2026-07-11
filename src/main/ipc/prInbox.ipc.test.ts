import { beforeEach, describe, expect, test, vi } from 'vitest'
import type {
  FileDiff,
  PrChangeFile,
  PrThread,
  PullRequest,
  ReviewSession
} from '@common/domain'
import type { AdoIdentity } from '../prInbox/adoMapping'
import { createDraftCommentRepo, type DraftCommentRepo } from '../db/draftCommentRepo'
import { createPrCacheRepo, type PrCacheRepo } from '../db/prCacheRepo'
import { createPrReviewWatermarkRepo, type PrReviewWatermarkRepo } from '../db/prReviewWatermarkRepo'
import { makeTestDb, makeTestDeps } from '../db/testkit'
import type { AdoService, SyncResult } from '../prInbox/adoService'
import type { LocalDiffService } from '../prInbox/localDiff'
import type { ReviewManager } from '../prInbox/reviewManager'
import { applyMyVote, buildReviewContext, createPrInboxHandlers, type PrInboxHandlers } from './prInbox.ipc'

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
  myReviewerId: null,
  reviewers: [],
  newChangesSinceMyReview: false,
  activeThreadCount: 0,
  ...over
})

function makeAdo(over: Partial<AdoService> = {}): { ado: AdoService; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {
    publishComment: [],
    syncMyPrs: [],
    replyToThread: [],
    setThreadStatus: []
  }
  const ado: AdoService = {
    syncMyPrs: vi.fn(async (): Promise<SyncResult> => ({ prs: [pr()], failedRepos: [] })),
    getThreads: vi.fn(async (): Promise<PrThread[]> => []),
    publishComment: vi.fn(async (input) => {
      calls.publishComment.push(input)
      return 5555
    }),
    replyToThread: vi.fn(async (input) => {
      calls.replyToThread.push(input)
    }),
    setThreadStatus: vi.fn(async (input) => {
      calls.setThreadStatus.push(input)
    }),
    castVote: vi.fn(async () => {}),
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

function makeLocalDiff(over: Partial<LocalDiffService> = {}): LocalDiffService {
  return {
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
    forget: vi.fn(),
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
    localDiff?: LocalDiffService
    review?: ReviewManager
    warn?: (m: string) => void
    atomically?: <T>(fn: () => T) => T
    resolveIdentity?: () => Promise<AdoIdentity>
  } = {}): { h: PrInboxHandlers; ado: ReturnType<typeof makeAdo>; localDiff: LocalDiffService } {
    const ado = overrides.ado ?? makeAdo()
    const localDiff = overrides.localDiff ?? makeLocalDiff()
    const h = createPrInboxHandlers({
      prCache,
      drafts,
      watermarks,
      ado: ado.ado,
      localDiff,
      workspaceFolders: () => ['/clone'],
      review: overrides.review ?? makeReview(),
      atomically: overrides.atomically ?? ((fn) => fn()),
      resolveIdentity: overrides.resolveIdentity,
      warn: overrides.warn
    })
    return { h, ado, localDiff }
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

  test('getFileDiff delegates to the local diff engine for the cached PR', async () => {
    const { h, localDiff } = handlers()
    prCache.replaceAll([pr()])
    await h.getFileDiff('repo-a', 100, 'src/a.ts')
    expect(localDiff.getFileDiff).toHaveBeenCalledWith(
      expect.objectContaining({ prId: 100, sourceCommitId: 'src-sha', targetCommitId: 'tgt-sha' }),
      'src/a.ts',
      ['/clone']
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

  test('castVote sends the vote for my cached reviewer entry and returns the updated PR', async () => {
    const { h, ado } = handlers()
    prCache.replaceAll([
      pr({
        role: 'reviewer',
        myVote: 'noVote',
        myReviewerId: 'rev-me',
        reviewers: [{ id: 'rev-me', displayName: 'Jan', vote: 'noVote', isRequired: true }]
      })
    ])
    const updated = await h.castVote('repo-a', 100, 'approved')
    expect(ado.ado.castVote).toHaveBeenCalledWith('repo-a', 100, 'rev-me', 'approved')
    expect(updated.myVote).toBe('approved')
    expect(updated.reviewers).toEqual([
      { id: 'rev-me', displayName: 'Jan', vote: 'approved', isRequired: true }
    ])
    expect(updated.newChangesSinceMyReview).toBe(false)
    // The cache row itself is updated, so a later list() agrees without a fresh sync.
    expect(prCache.get('repo-a', 100)?.myVote).toBe('approved')
  })

  test('a vote cast while a sync fetch is in flight survives the sync (no local revert)', async () => {
    // The fetched snapshot predates the vote: it still says noVote.
    const stale = pr({
      role: 'reviewer',
      myVote: 'noVote',
      myReviewerId: 'rev-me',
      reviewers: [{ id: 'rev-me', displayName: 'Jan', vote: 'noVote', isRequired: true }]
    })
    let resolveFetch!: (value: { prs: PullRequest[]; failedRepos: string[] }) => void
    const ado = makeAdo({
      syncMyPrs: vi.fn(
        () =>
          new Promise<{ prs: PullRequest[]; failedRepos: string[] }>((resolve) => {
            resolveFetch = resolve
          })
      ),
      castVote: vi.fn(async () => {})
    })
    const { h } = handlers({ ado })
    prCache.replaceAll([stale])

    const syncing = h.sync()
    await h.castVote('repo-a', 100, 'approved')
    resolveFetch({ prs: [stale], failedRepos: [] })
    const synced = await syncing

    expect(synced.find((p) => p.prId === 100)?.myVote).toBe('approved')
    expect(prCache.get('repo-a', 100)?.myVote).toBe('approved')
    // The watermark seeded by the vote survives the sync too.
    expect(watermarks.get('repo-a', 100)?.votedCommitId).toBe('src-sha')
  })

  test('castVote moves the review watermark to the PR source commit ("caught up as of now")', async () => {
    const { h } = handlers()
    prCache.replaceAll([pr({ role: 'reviewer', myVote: 'noVote', myReviewerId: 'rev-me' })])
    await h.castVote('repo-a', 100, 'waiting')
    expect(watermarks.get('repo-a', 100)?.votedCommitId).toBe('src-sha')
    const listed = await h.list()
    expect(listed[0].newChangesSinceMyReview).toBe(false)
  })

  test('castVote appends my reviewer entry when the cached PR listed me nowhere', async () => {
    const { h } = handlers()
    prCache.replaceAll([
      pr({
        role: 'reviewer',
        myVote: 'noVote',
        myReviewerId: 'rev-me',
        reviewers: [{ id: 'other', displayName: 'Radek', vote: 'approved', isRequired: true }]
      })
    ])
    const updated = await h.castVote('repo-a', 100, 'approvedWithSuggestions')
    expect(updated.reviewers).toEqual([
      { id: 'other', displayName: 'Radek', vote: 'approved', isRequired: true },
      { id: 'rev-me', displayName: 'You', vote: 'approvedWithSuggestions', isRequired: false }
    ])
  })

  test('castVote falls back to my configured UUID identity when the PR has no reviewer entry of mine', async () => {
    const { h, ado } = handlers({ resolveIdentity: () => Promise.resolve({ id: 'my-uuid' }) })
    prCache.replaceAll([pr({ myReviewerId: null })])
    const updated = await h.castVote('repo-a', 100, 'approved')
    expect(ado.ado.castVote).toHaveBeenCalledWith('repo-a', 100, 'my-uuid', 'approved')
    expect(updated.myReviewerId).toBe('my-uuid')
  })

  test('castVote refuses when neither a reviewer entry nor a UUID identity exists', async () => {
    const { h, ado } = handlers({ resolveIdentity: () => Promise.resolve({ displayName: 'Jan' }) })
    prCache.replaceAll([pr({ myReviewerId: null })])
    await expect(h.castVote('repo-a', 100, 'approved')).rejects.toThrow(/reviewer identity .* is unknown/i)
    expect(ado.ado.castVote).not.toHaveBeenCalled()
  })

  test('castVote treats a throwing identity resolution as unresolvable', async () => {
    const { h } = handlers({
      resolveIdentity: () => Promise.reject(new Error('identity lookup failed'))
    })
    prCache.replaceAll([pr({ myReviewerId: null })])
    await expect(h.castVote('repo-a', 100, 'approved')).rejects.toThrow(/reviewer identity .* is unknown/i)
  })

  test('a failed ADO vote leaves the cache and the watermark untouched', async () => {
    const ado = makeAdo({
      castVote: vi.fn(async () => {
        throw new Error('ADO down')
      })
    })
    const { h } = handlers({ ado })
    prCache.replaceAll([pr({ role: 'reviewer', myVote: 'noVote', myReviewerId: 'rev-me' })])
    await expect(h.castVote('repo-a', 100, 'approved')).rejects.toThrow(/ADO down/)
    expect(prCache.get('repo-a', 100)?.myVote).toBe('noVote')
    expect(watermarks.get('repo-a', 100)).toBeUndefined()
  })

  test('castVote writes the cache row and the watermark inside one atomically block', async () => {
    let atomicallyCalls = 0
    const atomically = <T,>(fn: () => T): T => {
      atomicallyCalls += 1
      return fn()
    }
    const { h } = handlers({ atomically })
    prCache.replaceAll([pr({ role: 'reviewer', myVote: 'noVote', myReviewerId: 'rev-me' })])
    await h.castVote('repo-a', 100, 'approved')
    expect(atomicallyCalls).toBe(1)
    expect(prCache.get('repo-a', 100)?.myVote).toBe('approved')
    expect(watermarks.get('repo-a', 100)?.votedCommitId).toBe('src-sha')
  })

  test('castVote on an unknown PR throws to sync first, without hitting ADO', async () => {
    const { h, ado } = handlers()
    await expect(h.castVote('repo-a', 999, 'approved')).rejects.toThrow(/sync first/i)
    expect(ado.ado.castVote).not.toHaveBeenCalled()
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

  test('addComment publishes immediately and returns fresh threads', async () => {
    const fresh: PrThread[] = [
      { threadId: 1, filePath: 'src/a.ts', line: 3, status: 'active', isSystem: false, comments: [] }
    ]
    const ado = makeAdo({ getThreads: vi.fn(async () => fresh) })
    const { h } = handlers({ ado })
    const threads = await h.addComment({
      repositoryId: 'repo-a',
      prId: 100,
      filePath: 'src/a.ts',
      line: 3,
      body: 'looks off'
    })
    expect(ado.calls.publishComment[0]).toMatchObject({
      filePath: 'src/a.ts',
      line: 3,
      body: 'looks off'
    })
    expect(threads).toEqual(fresh)
  })

  test('replyToThread and setThreadStatus return fresh threads', async () => {
    const fresh: PrThread[] = [
      { threadId: 42, filePath: null, line: null, status: 'fixed', isSystem: false, comments: [] }
    ]
    const ado = makeAdo({ getThreads: vi.fn(async () => fresh) })
    const { h } = handlers({ ado })
    const afterReply = await h.replyToThread('repo-a', 100, 42, 'reply body')
    expect(ado.calls.replyToThread[0]).toMatchObject({ threadId: 42, body: 'reply body' })
    expect(afterReply).toEqual(fresh)
    const afterStatus = await h.setThreadStatus('repo-a', 100, 42, 'fixed')
    expect(ado.calls.setThreadStatus[0]).toMatchObject({ threadId: 42, status: 'fixed' })
    expect(afterStatus).toEqual(fresh)
  })
})

describe('applyMyVote', () => {
  test('updates my entry in place, leaving the others untouched', () => {
    const reviewers = [
      { id: 'other', displayName: 'Radek', vote: 'approved' as const, isRequired: true },
      { id: 'me', displayName: 'Jan', vote: 'noVote' as const, isRequired: false }
    ]
    expect(applyMyVote(reviewers, 'me', 'waiting')).toEqual([
      { id: 'other', displayName: 'Radek', vote: 'approved', isRequired: true },
      { id: 'me', displayName: 'Jan', vote: 'waiting', isRequired: false }
    ])
  })

  test('appends a minimal entry when I am absent', () => {
    expect(applyMyVote([], 'me', 'approved')).toEqual([
      { id: 'me', displayName: 'You', vote: 'approved', isRequired: false }
    ])
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
