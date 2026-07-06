import type { PullRequest } from '@common/domain'
import type { AdoService, SyncResult } from './adoService'

/**
 * Deterministic Azure DevOps backend for E2E runs, so the PR radar and inbox can be exercised
 * without a live server. `INTERSECT_E2E_ADO` picks the sync outcome: `empty` (default) keeps the
 * cache clear, `radar` returns one PR per My Work radar subgroup. In radar mode the PR I already
 * approved advances its source commit on the second sync, so a Refresh drives the real watermark
 * flow end to end: the first sync seeds the watermark (caught up), the second flags new changes.
 */

const REPO = { repositoryId: 'e2e-repo', repositoryName: 'intersect-app', projectId: 'SPOT' }

const basePr = {
  ...REPO,
  status: 'active',
  targetRefName: 'refs/heads/main',
  targetCommitId: 'target-1',
  newChangesSinceMyReview: false
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
      reviewers: [{ id: 'me', displayName: 'Jan Lesak', vote: 'approved', isRequired: true }]
    }
  ]
}

export function createAdoE2eStub(env: NodeJS.ProcessEnv): AdoService {
  const mode = env.INTERSECT_E2E_ADO ?? 'empty'
  let syncCount = 0
  return {
    async syncMyPrs(): Promise<SyncResult> {
      syncCount += 1
      return { prs: mode === 'radar' ? radarPrs(syncCount) : [], failedRepos: [] }
    },

    async getChanges() {
      return []
    },

    async getFileDiff(input) {
      return {
        path: input.filePath,
        original: '',
        modified: '',
        language: 'plaintext',
        binary: false,
        tooLarge: false
      }
    },

    async getThreads() {
      return []
    },

    async publishComment() {
      throw new Error('Publishing is not available in the E2E stub')
    }
  }
}
