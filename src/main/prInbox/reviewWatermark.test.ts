import { describe, expect, test } from 'vitest'
import type { PullRequest } from '@common/domain'
import { decorateNewChanges, planWatermarks } from './reviewWatermark'

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
  sourceCommitId: 'commit-1',
  targetCommitId: 'tgt-sha',
  url: 'https://ado/pr/100',
  role: 'reviewer',
  myVote: 'approved',
  reviewers: [],
  newChangesSinceMyReview: false,
  ...over
})

describe('planWatermarks', () => {
  test('a freshly voted PR with no cached row seeds the watermark at its current commit (bootstrap)', () => {
    const plan = planWatermarks([], [pr({ myVote: 'approved', sourceCommitId: 'commit-1' })])
    expect(plan.upserts).toEqual([{ repositoryId: 'repo-a', prId: 100, votedCommitId: 'commit-1' }])
    expect(plan.deletes).toEqual([])
  })

  test('a cached row without a recorded vote (pre-migration) also seeds - nothing is retroactively flagged', () => {
    const plan = planWatermarks(
      [pr({ myVote: null, sourceCommitId: 'commit-1' })],
      [pr({ myVote: 'approved', sourceCommitId: 'commit-2' })]
    )
    expect(plan.upserts).toEqual([{ repositoryId: 'repo-a', prId: 100, votedCommitId: 'commit-2' }])
  })

  test('a changed vote re-seeds the watermark to the commit just voted on', () => {
    const plan = planWatermarks(
      [pr({ myVote: 'waiting' })],
      [pr({ myVote: 'approved', sourceCommitId: 'commit-3' })]
    )
    expect(plan.upserts).toEqual([{ repositoryId: 'repo-a', prId: 100, votedCommitId: 'commit-3' }])
  })

  test('an unchanged vote leaves the watermark untouched even when the source commit moved', () => {
    const plan = planWatermarks(
      [pr({ myVote: 'approved', sourceCommitId: 'commit-1' })],
      [pr({ myVote: 'approved', sourceCommitId: 'commit-9' })]
    )
    expect(plan.upserts).toEqual([])
    expect(plan.deletes).toEqual([])
  })

  test('a vote reset to noVote drops the watermark', () => {
    const plan = planWatermarks([pr({ myVote: 'approved' })], [pr({ myVote: 'noVote' })])
    expect(plan.deletes).toEqual([{ repositoryId: 'repo-a', prId: 100 }])
    expect(plan.upserts).toEqual([])
  })

  test('no longer being a reviewer (myVote null) drops the watermark', () => {
    const plan = planWatermarks([pr({ myVote: 'approved' })], [pr({ role: 'author', myVote: null })])
    expect(plan.deletes).toEqual([{ repositoryId: 'repo-a', prId: 100 }])
  })

  test('a vote on a PR I authored never seeds a watermark (the radar is reviewer-only)', () => {
    const plan = planWatermarks([], [pr({ role: 'author', myVote: 'approved' })])
    expect(plan.upserts).toEqual([])
    expect(plan.deletes).toEqual([])
  })

  test('transitions are keyed per repo+pr, not by prId alone', () => {
    const plan = planWatermarks(
      [pr({ repositoryId: 'repo-a', myVote: 'approved' })],
      [
        pr({ repositoryId: 'repo-a', myVote: 'approved' }),
        pr({ repositoryId: 'repo-b', myVote: 'approved', sourceCommitId: 'commit-b' })
      ]
    )
    expect(plan.upserts).toEqual([{ repositoryId: 'repo-b', prId: 100, votedCommitId: 'commit-b' }])
  })
})

describe('decorateNewChanges', () => {
  const watermarks = new Map<string, { votedCommitId: string }>()
  const lookup = (repositoryId: string, prId: number) => watermarks.get(`${repositoryId}:${prId}`)

  test('flags a PR whose source commit moved past the watermark', () => {
    watermarks.set('repo-a:100', { votedCommitId: 'commit-1' })
    const [decorated] = decorateNewChanges([pr({ sourceCommitId: 'commit-2' })], lookup)
    expect(decorated.newChangesSinceMyReview).toBe(true)
  })

  test('a PR still at the watermark commit is caught up', () => {
    watermarks.set('repo-a:100', { votedCommitId: 'commit-1' })
    const [decorated] = decorateNewChanges([pr({ sourceCommitId: 'commit-1' })], lookup)
    expect(decorated.newChangesSinceMyReview).toBe(false)
  })

  test('a PR without a watermark is never flagged', () => {
    watermarks.clear()
    const [decorated] = decorateNewChanges([pr({ sourceCommitId: 'commit-2' })], lookup)
    expect(decorated.newChangesSinceMyReview).toBe(false)
  })
})
