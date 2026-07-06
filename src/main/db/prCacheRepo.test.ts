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
  reviewers: [{ id: 'r1', displayName: 'Radek', vote: 'approved', isRequired: true }],
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

  test('the same prId in two repos are distinct rows (composite key)', () => {
    repo.replaceAll([pr({ prId: 5, repositoryId: 'repo-a' }), pr({ prId: 5, repositoryId: 'repo-b' })])
    expect(repo.list()).toHaveLength(2)
    expect(repo.get('repo-b', 5)?.repositoryId).toBe('repo-b')
  })

  test('CHECK rejects an invalid role', () => {
    expect(() => repo.replaceAll([pr({ role: 'owner' as unknown as 'author' })])).toThrow()
  })
})
