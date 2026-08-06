import { beforeEach, describe, expect, test } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import type { PullRequest } from '@common/domain'
import { createPrCacheRepo, type PrCacheRepo } from './prCacheRepo'
import { makeTestDb, makeTestDeps } from './testkit'

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  prId: 100,
  repositoryId: 'repo-a',
  repositoryName: 'spot-backend',
  projectId: 'SPOT',
  title: 'a change',
  authorId: 'author-1',
  authorName: 'Jan',
  createdAt: 5000,
  status: 'active',
  sourceRefName: 'refs/heads/feature/x',
  targetRefName: 'refs/heads/main',
  sourceCommitId: 'aaa',
  targetCommitId: 'bbb',
  url: 'https://ado/pr/100',
  role: 'author',
  myVote: null,
  myReviewerId: null,
  reviewers: [{ id: 'r1', displayName: 'Radek', vote: 'approved', isRequired: true }],
  newChangesSinceMyReview: false,
  activeThreadCount: 0,
  lastActivityAt: 5000,
  ...over
})

describe('prCacheRepo', () => {
  let db: DatabaseSync
  let repo: PrCacheRepo

  beforeEach(() => {
    db = makeTestDb()
    repo = createPrCacheRepo(db, makeTestDeps())
  })

  test('replaceAll inserts PRs and round-trips reviewers + commit ids', () => {
    repo.replaceAll([pr()])
    const got = repo.get('repo-a', 100)
    expect(got?.title).toBe('a change')
    expect(got?.sourceCommitId).toBe('aaa')
    expect(got?.reviewers).toEqual([
      { id: 'r1', displayName: 'Radek', vote: 'approved', isRequired: true }
    ])
  })

  test('round-trips the active thread count', () => {
    repo.replaceAll([pr({ activeThreadCount: 3 })])
    expect(repo.get('repo-a', 100)?.activeThreadCount).toBe(3)
  })

  test('round-trips when the PR was last touched, distinct from when it was created', () => {
    repo.replaceAll([pr({ createdAt: 5000, lastActivityAt: 9000 })])
    expect(repo.get('repo-a', 100)?.lastActivityAt).toBe(9000)
    expect(repo.list()[0].lastActivityAt).toBe(9000)
  })

  test('replaceAll clears the previous cache', () => {
    repo.replaceAll([pr({ prId: 1 }), pr({ prId: 2 })])
    repo.replaceAll([pr({ prId: 3 })])
    expect(repo.list().map((p) => p.prId)).toEqual([3])
  })

  test('list orders newest-first by createdAt', () => {
    repo.replaceAll([pr({ prId: 1, createdAt: 100 }), pr({ prId: 2, createdAt: 300 })])
    expect(repo.list().map((p) => p.prId)).toEqual([2, 1])
  })

  test('round-trips my vote, and a missing vote stays null', () => {
    repo.replaceAll([pr({ prId: 1, myVote: 'approved' }), pr({ prId: 2, myVote: null })])
    expect(repo.get('repo-a', 1)?.myVote).toBe('approved')
    expect(repo.get('repo-a', 2)?.myVote).toBeNull()
  })

  test('a row cached before the my_vote column existed reads as a null vote', () => {
    repo.replaceAll([pr()])
    // Simulate the pre-migration state: the column exists but the row never had it written.
    db.prepare('UPDATE pr_cache SET my_vote = NULL WHERE pr_id = 100').run()
    expect(repo.get('repo-a', 100)?.myVote).toBeNull()
  })

  test('round-trips my reviewer id, and a missing one stays null', () => {
    repo.replaceAll([pr({ prId: 1, myReviewerId: 'rev-me' }), pr({ prId: 2, myReviewerId: null })])
    expect(repo.get('repo-a', 1)?.myReviewerId).toBe('rev-me')
    expect(repo.get('repo-a', 2)?.myReviewerId).toBeNull()
  })

  test('a row cached before the my_reviewer_id column existed reads as a null reviewer id', () => {
    repo.replaceAll([pr({ myReviewerId: 'rev-me' })])
    // Simulate the pre-migration state: the column exists but the row never had it written.
    db.prepare('UPDATE pr_cache SET my_reviewer_id = NULL WHERE pr_id = 100').run()
    expect(repo.get('repo-a', 100)?.myReviewerId).toBeNull()
  })

  test('updateVote rewrites my vote and the reviewers array in place', () => {
    repo.replaceAll([pr({ myVote: 'noVote', myReviewerId: 'r1' })])
    repo.updateVote(
      'repo-a',
      100,
      'approved',
      [{ id: 'r1', displayName: 'Radek', vote: 'approved', isRequired: true }],
      'r1'
    )
    const got = repo.get('repo-a', 100)
    expect(got?.myVote).toBe('approved')
    expect(got?.myReviewerId).toBe('r1')
    expect(got?.reviewers).toEqual([
      { id: 'r1', displayName: 'Radek', vote: 'approved', isRequired: true }
    ])
  })

  test('updateVote round-trips a reviewer entry appended for me and fills a NULL my_reviewer_id', () => {
    repo.replaceAll([pr({ myVote: null, myReviewerId: null })])
    const appended = [
      ...pr().reviewers,
      { id: 'me-uuid', displayName: 'You', vote: 'waiting' as const, isRequired: false }
    ]
    repo.updateVote('repo-a', 100, 'waiting', appended, 'me-uuid')
    const got = repo.get('repo-a', 100)
    expect(got?.myVote).toBe('waiting')
    expect(got?.myReviewerId).toBe('me-uuid')
    expect(got?.reviewers).toEqual(appended)
  })

  test('updateVote on an uncached PR is a no-op and creates no row', () => {
    repo.replaceAll([pr()])
    expect(() => repo.updateVote('repo-a', 999, 'approved', [], 'me-uuid')).not.toThrow()
    expect(repo.get('repo-a', 999)).toBeUndefined()
    expect(repo.list()).toHaveLength(1)
  })

  test('updateVote leaves the other cached rows untouched', () => {
    repo.replaceAll([pr({ prId: 1, myVote: 'noVote' }), pr({ prId: 2, myVote: 'noVote' })])
    repo.updateVote('repo-a', 1, 'approved', pr().reviewers, 'me-uuid')
    expect(repo.get('repo-a', 2)?.myVote).toBe('noVote')
  })

  test('the derived new-changes flag always reads false from the cache itself', () => {
    repo.replaceAll([pr({ newChangesSinceMyReview: true })])
    expect(repo.get('repo-a', 100)?.newChangesSinceMyReview).toBe(false)
  })

  test('the same prId in two repos are distinct rows (composite key)', () => {
    repo.replaceAll([pr({ prId: 5, repositoryId: 'repo-a' }), pr({ prId: 5, repositoryId: 'repo-b' })])
    expect(repo.list()).toHaveLength(2)
    expect(repo.get('repo-b', 5)?.repositoryId).toBe('repo-b')
  })

  test('CHECK rejects an invalid role', () => {
    expect(() => repo.replaceAll([pr({ role: 'owner' as unknown as 'author' })])).toThrow()
  })

  test('an empty cache has never been synced', () => {
    expect(repo.getSyncedAt()).toBeNull()
  })

  test('getSyncedAt reports the moment the cache was filled, and moves with each sync', () => {
    // The injected clock advances by one on every read, so the two syncs are distinguishable.
    repo.replaceAll([pr()])
    const first = repo.getSyncedAt()
    expect(first).toBe(1001)

    repo.replaceAll([pr()])
    expect(repo.getSyncedAt()).toBe(1002)
  })

  test('a sync that found no PRs at all still reports when it ran', () => {
    // An empty inbox is an ordinary state, and "no PRs" must not read as "never synced".
    repo.replaceAll([])
    expect(repo.getSyncedAt()).toBe(1001)
  })

  test('a cache filled before the freshness stamp existed falls back to its rows', () => {
    repo.replaceAll([pr()])
    db.prepare(`DELETE FROM app_state WHERE key = 'pr_cache_synced_at'`).run()
    expect(repo.getSyncedAt()).toBe(1001)
  })
})
