import { describe, expect, test } from 'vitest'
import type { PullRequest } from '@common/domain'
import { approvalCount, groupPrs, initials } from './prGroups'

const pr = (prId: number, over: Partial<PullRequest> = {}): PullRequest => ({
  prId,
  repositoryId: 'repo',
  repositoryName: 'intersect-app',
  projectId: 'SPOT',
  title: `PR ${prId}`,
  authorId: 'u1',
  authorName: 'Author',
  createdAt: 1000,
  status: 'active',
  sourceRefName: 'refs/heads/feature',
  targetRefName: 'refs/heads/main',
  sourceCommitId: 'src',
  targetCommitId: 'tgt',
  url: 'https://ado/pr',
  role: 'reviewer',
  myVote: null,
  myReviewerId: null,
  reviewers: [],
  newChangesSinceMyReview: false,
  ...over
})

describe('groupPrs', () => {
  test('routes each PR into exactly the subgroup its role and vote dictate', () => {
    const groups = groupPrs([
      pr(1, { role: 'author' }),
      pr(2, { role: 'reviewer', myVote: 'noVote' }),
      pr(3, { role: 'reviewer', myVote: null }),
      pr(4, { role: 'reviewer', myVote: 'approved', newChangesSinceMyReview: true })
    ])
    expect(groups.myPrs.map((p) => p.prId)).toEqual([1])
    expect(groups.waitingOnMe.map((p) => p.prId)).toEqual([2, 3])
    expect(groups.updatedSinceReview.map((p) => p.prId)).toEqual([4])
  })

  test('a reviewed PR without new changes is caught up and belongs to no group', () => {
    const groups = groupPrs([
      pr(1, { role: 'reviewer', myVote: 'approved', newChangesSinceMyReview: false })
    ])
    expect(groups.myPrs).toEqual([])
    expect(groups.waitingOnMe).toEqual([])
    expect(groups.updatedSinceReview).toEqual([])
  })

  test('a noVote never lands in the updated group even when changes exist', () => {
    const groups = groupPrs([
      pr(1, { role: 'reviewer', myVote: 'noVote', newChangesSinceMyReview: true })
    ])
    expect(groups.waitingOnMe.map((p) => p.prId)).toEqual([1])
    expect(groups.updatedSinceReview).toEqual([])
  })

  test('only active PRs qualify anywhere', () => {
    const groups = groupPrs([
      pr(1, { role: 'author', status: 'completed' }),
      pr(2, { role: 'reviewer', myVote: 'noVote', status: 'abandoned' }),
      pr(3, { role: 'reviewer', myVote: 'approved', newChangesSinceMyReview: true, status: 'completed' })
    ])
    expect(groups.myPrs).toEqual([])
    expect(groups.waitingOnMe).toEqual([])
    expect(groups.updatedSinceReview).toEqual([])
  })

  test('each group is sorted newest first by createdAt', () => {
    const groups = groupPrs([
      pr(1, { role: 'author', createdAt: 100 }),
      pr(2, { role: 'author', createdAt: 300 }),
      pr(3, { role: 'author', createdAt: 200 })
    ])
    expect(groups.myPrs.map((p) => p.prId)).toEqual([2, 3, 1])
  })
})

describe('approvalCount', () => {
  test('counts plain and with-suggestions approvals only', () => {
    const count = approvalCount(
      pr(1, {
        reviewers: [
          { id: 'a', displayName: 'A', vote: 'approved', isRequired: true },
          { id: 'b', displayName: 'B', vote: 'approvedWithSuggestions', isRequired: false },
          { id: 'c', displayName: 'C', vote: 'waiting', isRequired: false },
          { id: 'd', displayName: 'D', vote: 'noVote', isRequired: false },
          { id: 'e', displayName: 'E', vote: 'rejected', isRequired: false }
        ]
      })
    )
    expect(count).toBe(2)
  })
})

describe('initials', () => {
  test.each([
    ['Jan Lesák', 'JL'],
    ['Marek K.', 'MK'],
    ['  Tereza   Nova  ', 'TN'],
    ['Cher', 'C'],
    ['anna beata carla', 'AB'],
    ['', '?']
  ])('%s -> %s', (name, expected) => {
    expect(initials(name)).toBe(expected)
  })
})
