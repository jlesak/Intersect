import type { FileDiff, PrChangeFile, PrThread, PrVote, PullRequest } from '@common/domain'
import { isThreadUnresolved } from '@common/prBoard'
import type { AdoService, SyncResult } from './adoService'
import type { LocalDiffService } from './localDiff'

/**
 * Deterministic Azure DevOps backend for E2E runs, so the PR radar and inbox can be exercised
 * without a live server. `INTERSECT_E2E_ADO` picks the sync outcome: `empty` (default) keeps the
 * cache clear, `radar` returns one PR per My Work radar subgroup. In radar mode the PR I already
 * approved advances its source commit on the second sync, so a Refresh drives the real watermark
 * flow end to end: the first sync seeds the watermark (caught up), the second flags new changes.
 * Votes cast during the run are remembered and applied on top of the canned PRs, so a later sync
 * reflects them exactly like the real server would.
 */

const REPO = { repositoryId: 'e2e-repo', repositoryName: 'intersect-app', projectId: 'SPOT' }

const basePr = {
  ...REPO,
  status: 'active',
  targetRefName: 'refs/heads/main',
  targetCommitId: 'target-1',
  newChangesSinceMyReview: false,
  activeThreadCount: 0
}

function radarPrs(syncCount: number): PullRequest[] {
  const now = Date.now()
  return [
    {
      ...basePr,
      prId: 501,
      title: 'Add rate limiting to the sync pipeline',
      authorId: 'me',
      authorName: 'Jan Lesak',
      createdAt: now - 20 * 60_000,
      sourceRefName: 'refs/heads/feature/rate-limit',
      sourceCommitId: 'source-501',
      url: 'https://devops/pr/501',
      role: 'author',
      myVote: null,
      myReviewerId: null,
      reviewers: [
        { id: 'rev-1', displayName: 'Marek Kral', vote: 'approved', isRequired: true },
        { id: 'rev-2', displayName: 'Tereza Nova', vote: 'approvedWithSuggestions', isRequired: false }
      ]
    },
    {
      ...basePr,
      prId: 502,
      title: 'Fix PTY backpressure on large output',
      authorId: 'author-marek',
      authorName: 'Marek Kral',
      createdAt: now - 60 * 60_000,
      sourceRefName: 'refs/heads/fix/pty-backpressure',
      sourceCommitId: 'source-502',
      url: 'https://devops/pr/502',
      role: 'reviewer',
      myVote: 'noVote',
      myReviewerId: 'me',
      reviewers: [{ id: 'me', displayName: 'Jan Lesak', vote: 'noVote', isRequired: true }]
    },
    {
      ...basePr,
      prId: 503,
      title: 'Extract the notification preferences screen',
      authorId: 'author-petr',
      authorName: 'Petr Vala',
      createdAt: now - 3 * 60 * 60_000,
      sourceRefName: 'refs/heads/feature/notif-prefs',
      // The author "pushes" between the first and second sync of an app run.
      sourceCommitId: syncCount <= 1 ? 'source-503-reviewed' : 'source-503-updated',
      url: 'https://devops/pr/503',
      role: 'reviewer',
      myVote: 'approved',
      myReviewerId: 'me',
      reviewers: [{ id: 'me', displayName: 'Jan Lesak', vote: 'approved', isRequired: true }]
    }
  ]
}

/**
 * Deterministic diff engine for E2E runs, standing in for the local-git service (which would need a
 * real clone on disk). Mirrors the canned changed files the inbox specs assert on in `radar` mode.
 */
export function createLocalDiffE2eStub(env: NodeJS.ProcessEnv): LocalDiffService {
  const mode = env.INTERSECT_E2E_ADO ?? 'empty'
  const changes: PrChangeFile[] =
    mode === 'radar'
      ? [
          { path: '/src/app/sync/rateLimiter.ts', changeType: 'edit', originalPath: null },
          { path: '/src/app/sync/queue.ts', changeType: 'edit', originalPath: null },
          { path: '/src/app/config/limits.ts', changeType: 'add', originalPath: null },
          { path: '/tests/sync/rateLimiter.test.ts', changeType: 'edit', originalPath: null }
        ]
      : []
  return {
    async getChanges() {
      return changes
    },
    async getFileDiff(_pr, filePath): Promise<FileDiff> {
      return {
        path: filePath,
        original: 'const limit = 10\n',
        modified: 'const limit = 25\nconst burst = 5\n',
        language: 'typescript',
        binary: false,
        tooLarge: false
      }
    },
    forget() {}
  }
}

export function createAdoE2eStub(env: NodeJS.ProcessEnv): AdoService {
  const mode = env.INTERSECT_E2E_ADO ?? 'empty'
  let syncCount = 0
  // Votes cast during this run, keyed by PR id, layered over the canned PRs on every sync.
  const castVotes = new Map<number, { reviewerId: string; vote: PrVote }>()
  // Threads per PR, mutated by comment/reply/resolve during the run so the full review loop
  // (comment -> reply -> resolve, board thread counts) is exercisable offline.
  const threadsByPr = new Map<number, PrThread[]>([
    [
      501,
      [
        {
          threadId: 9001,
          filePath: '/src/app/sync/rateLimiter.ts',
          line: 12,
          status: 'active',
          isSystem: false,
          comments: [
            {
              authorName: 'Marek Kral',
              body: 'Should the limit be configurable?',
              publishedAt: Date.now() - 3_600_000
            }
          ]
        },
        {
          threadId: 9002,
          filePath: null,
          line: null,
          status: 'unknown',
          isSystem: true,
          comments: [
            {
              authorName: 'ADO',
              body: 'Policy status has been updated',
              publishedAt: Date.now() - 7_200_000
            }
          ]
        }
      ]
    ]
  ])
  let nextThreadId = 9100

  function applyVotes(prs: PullRequest[]): PullRequest[] {
    return prs.map((pr) => {
      const cast = castVotes.get(pr.prId)
      if (!cast) return pr
      return {
        ...pr,
        myVote: cast.vote,
        reviewers: pr.reviewers.map((r) => (r.id === cast.reviewerId ? { ...r, vote: cast.vote } : r))
      }
    })
  }

  function applyThreadCounts(prs: PullRequest[]): PullRequest[] {
    return prs.map((pr) => ({
      ...pr,
      activeThreadCount: (threadsByPr.get(pr.prId) ?? []).filter(
        (t) => !t.isSystem && isThreadUnresolved(t)
      ).length
    }))
  }

  return {
    async syncMyPrs(): Promise<SyncResult> {
      syncCount += 1
      return {
        prs: mode === 'radar' ? applyThreadCounts(applyVotes(radarPrs(syncCount))) : [],
        failedRepos: []
      }
    },

    async getThreads(_repositoryId, prId) {
      return threadsByPr.get(prId) ?? []
    },

    async publishComment(input) {
      const threadId = nextThreadId++
      const threads = threadsByPr.get(input.prId) ?? []
      threads.push({
        threadId,
        filePath: input.filePath,
        line: input.line,
        status: 'active',
        isSystem: false,
        comments: [{ authorName: 'Jan Lesak', body: input.body, publishedAt: Date.now() }]
      })
      threadsByPr.set(input.prId, threads)
      return threadId
    },

    async replyToThread(input) {
      const thread = (threadsByPr.get(input.prId) ?? []).find((t) => t.threadId === input.threadId)
      if (!thread) throw new Error(`Unknown thread ${input.threadId} in the E2E stub`)
      thread.comments.push({ authorName: 'Jan Lesak', body: input.body, publishedAt: Date.now() })
    },

    async setThreadStatus(input) {
      const thread = (threadsByPr.get(input.prId) ?? []).find((t) => t.threadId === input.threadId)
      if (!thread) throw new Error(`Unknown thread ${input.threadId} in the E2E stub`)
      thread.status = input.status
    },

    async castVote(_repositoryId, prId, reviewerId, vote) {
      castVotes.set(prId, { reviewerId, vote })
    }
  }
}
