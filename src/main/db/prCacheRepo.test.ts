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
  reviewers: [{ id: 'r1', displayName: 'Radek', vote: 'approved', isRequired: true }],
  newChangesSinceMyReview: false,
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
})
