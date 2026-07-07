import { describe, expect, test } from 'vitest'
import { PR_VOTES } from '@common/domain'
import {
  mapPullRequest,
  mapStatus,
  mapVote,
  matchesIdentity,
  mergeMyPrs,
  roleForIdentity,
  toNumericVote,
  type AdoIdentity,
  type AdoRawPullRequest
} from './adoMapping'

const me: AdoIdentity = {
  id: '6dc11d09-387d-4a25-8699-0dc709e21280',
  uniqueName: 'dmz\\DZCUP4C',
  displayName: 'Lesak, Jan (Green:Code s.r.o.)'
}

// Trimmed from a real on-prem SPOT PR payload.
const rawAuthored: AdoRawPullRequest = {
  pullRequestId: 33719,
  title: 'FID2507-809 cycle start plans overview endpoints',
  status: 1,
  creationDate: '2026-07-02T15:19:42.045Z',
  sourceRefName: 'refs/heads/feature/FID2507-809',
  targetRefName: 'refs/heads/main',
  url: 'https://devops/pr/33719',
  createdBy: { id: '6dc11d09-387d-4a25-8699-0dc709e21280', displayName: 'Lesak, Jan (Green:Code s.r.o.)', uniqueName: 'dmz\\DZCUP4C' },
  repository: { id: 'c2941d43', name: 'spot-backend', project: { id: 'e0fc249c', name: 'SPOT' } },
  lastMergeSourceCommit: { commitId: 'ad67eb11' },
  lastMergeTargetCommit: { commitId: 'ed283352' },
  reviewers: [
    { id: 'fcb74157', displayName: 'Novacek, Radek', uniqueName: 'dmz\\DZCDERH', vote: 10, isRequired: true }
  ]
}

describe('mapVote', () => {
  test.each([
    [10, 'approved'],
    [5, 'approvedWithSuggestions'],
    [0, 'noVote'],
    [-5, 'waiting'],
    [-10, 'rejected'],
    [undefined, 'noVote'],
    [999, 'noVote']
  ])('%s -> %s', (code, expected) => {
    expect(mapVote(code as number)).toBe(expected)
  })
})

describe('toNumericVote', () => {
  test.each([
    ['approved', 10],
    ['approvedWithSuggestions', 5],
    ['noVote', 0],
    ['waiting', -5],
    ['rejected', -10]
  ] as const)('%s -> %s', (vote, expected) => {
    expect(toNumericVote(vote)).toBe(expected)
  })

  test('is the exact inverse of mapVote for every vote', () => {
    for (const vote of PR_VOTES) {
      expect(mapVote(toNumericVote(vote))).toBe(vote)
    }
  })
})

describe('mapStatus', () => {
  test('numeric 1 is active', () => expect(mapStatus(1)).toBe('active'))
  test('string passes through', () => expect(mapStatus('completed')).toBe('completed'))
})

describe('matchesIdentity', () => {
  test('matches on id case-insensitively', () => {
    expect(matchesIdentity({ id: '6DC11D09-387D-4A25-8699-0DC709E21280' }, me)).toBe(true)
  })
  test('matches on uniqueName when id absent', () => {
    expect(matchesIdentity({ uniqueName: 'dmz\\dzcup4c' }, me)).toBe(true)
  })
  test('matches on displayName as last resort', () => {
    expect(matchesIdentity({ displayName: 'Lesak, Jan (Green:Code s.r.o.)' }, me)).toBe(true)
  })
  test('does not match a different person', () => {
    expect(matchesIdentity({ id: 'other', uniqueName: 'dmz\\DZCDERH' }, me)).toBe(false)
  })
  test('undefined person never matches', () => {
    expect(matchesIdentity(undefined, me)).toBe(false)
  })
})

describe('roleForIdentity', () => {
  test('author when I created the PR', () => {
    expect(roleForIdentity(rawAuthored, me)).toBe('author')
  })
  test('reviewer when I am only a reviewer', () => {
    const raw = { ...rawAuthored, createdBy: { id: 'someone-else' } }
    const asReviewer: AdoRawPullRequest = {
      ...raw,
      reviewers: [{ id: me.id, displayName: me.displayName, uniqueName: me.uniqueName, vote: 0 }]
    }
    expect(roleForIdentity(asReviewer, me)).toBe('reviewer')
  })
  test('null when the PR is not mine', () => {
    const notMine: AdoRawPullRequest = {
      ...rawAuthored,
      createdBy: { id: 'x' },
      reviewers: [{ id: 'y' }]
    }
    expect(roleForIdentity(notMine, me)).toBeNull()
  })
})

describe('mapPullRequest', () => {
  test('maps the real payload including commit ids and reviewers', () => {
    const pr = mapPullRequest(rawAuthored, 'author', me)
    expect(pr.prId).toBe(33719)
    expect(pr.repositoryName).toBe('spot-backend')
    expect(pr.projectId).toBe('SPOT')
    expect(pr.authorName).toBe('Lesak, Jan (Green:Code s.r.o.)')
    expect(pr.createdAt).toBe(Date.parse('2026-07-02T15:19:42.045Z'))
    expect(pr.sourceCommitId).toBe('ad67eb11')
    expect(pr.targetCommitId).toBe('ed283352')
    expect(pr.status).toBe('active')
    expect(pr.role).toBe('author')
    expect(pr.reviewers).toEqual([
      { id: 'fcb74157', displayName: 'Novacek, Radek', vote: 'approved', isRequired: true }
    ])
  })

  test('myVote is null when I am not among the reviewers (pure author)', () => {
    expect(mapPullRequest(rawAuthored, 'author', me).myVote).toBeNull()
  })

  test('myVote is my reviewer entry, matched by identity id', () => {
    const raw: AdoRawPullRequest = {
      ...rawAuthored,
      reviewers: [...(rawAuthored.reviewers ?? []), { id: me.id, vote: -5 }]
    }
    expect(mapPullRequest(raw, 'reviewer', me).myVote).toBe('waiting')
  })

  test('myVote matches by uniqueName when the reviewer entry has no id', () => {
    const raw: AdoRawPullRequest = {
      ...rawAuthored,
      reviewers: [{ uniqueName: 'dmz\\dzcup4c', vote: 10 }]
    }
    expect(mapPullRequest(raw, 'reviewer', me).myVote).toBe('approved')
  })

  test('myVote matches by displayName as last resort', () => {
    const raw: AdoRawPullRequest = {
      ...rawAuthored,
      reviewers: [{ displayName: 'Lesak, Jan (Green:Code s.r.o.)', vote: 5 }]
    }
    expect(mapPullRequest(raw, 'reviewer', me).myVote).toBe('approvedWithSuggestions')
  })

  test('my reviewer entry without a vote code reads as noVote, distinct from null', () => {
    const raw: AdoRawPullRequest = { ...rawAuthored, reviewers: [{ id: me.id }] }
    expect(mapPullRequest(raw, 'reviewer', me).myVote).toBe('noVote')
  })

  test('the derived new-changes flag is never set by the mapper', () => {
    expect(mapPullRequest(rawAuthored, 'author', me).newChangesSinceMyReview).toBe(false)
  })

  test('myReviewerId is my matched reviewer entry id', () => {
    const raw: AdoRawPullRequest = {
      ...rawAuthored,
      reviewers: [...(rawAuthored.reviewers ?? []), { id: me.id, vote: -5 }]
    }
    expect(mapPullRequest(raw, 'reviewer', me).myReviewerId).toBe(me.id)
  })

  test('myReviewerId is null when I am not among the reviewers (pure author)', () => {
    expect(mapPullRequest(rawAuthored, 'author', me).myReviewerId).toBeNull()
  })

  test('myReviewerId is null when my entry matched by name carries no id', () => {
    const raw: AdoRawPullRequest = {
      ...rawAuthored,
      reviewers: [{ uniqueName: 'dmz\\dzcup4c', vote: 10 }]
    }
    const pr = mapPullRequest(raw, 'reviewer', me)
    expect(pr.myVote).toBe('approved')
    expect(pr.myReviewerId).toBeNull()
  })
})

describe('mergeMyPrs', () => {
  test('dedupes the same PR from creator+reviewer fan-out, author wins', () => {
    const asReviewer = mapPullRequest(rawAuthored, 'reviewer', me)
    const asAuthor = mapPullRequest(rawAuthored, 'author', me)
    const merged = mergeMyPrs([asReviewer, asAuthor])
    expect(merged).toHaveLength(1)
    expect(merged[0].role).toBe('author')
  })
  test('keeps distinct PRs across repos', () => {
    const a = mapPullRequest(rawAuthored, 'author', me)
    const b = mapPullRequest({ ...rawAuthored, repository: { id: 'other', name: 'spot-frontend' } }, 'reviewer', me)
    expect(mergeMyPrs([a, b])).toHaveLength(2)
  })
})
