import { beforeEach, describe, expect, test } from 'vitest'
import { createPrReviewWatermarkRepo, type PrReviewWatermarkRepo } from './prReviewWatermarkRepo'
import { makeTestDb, makeTestDeps } from './testkit'

describe('prReviewWatermarkRepo', () => {
  let repo: PrReviewWatermarkRepo

  beforeEach(() => {
    repo = createPrReviewWatermarkRepo(makeTestDb(), makeTestDeps())
  })

  test('returns undefined before anything was recorded', () => {
    expect(repo.get('repo-a', 1)).toBeUndefined()
  })

  test('upsert then get round-trips, stamped with the clock', () => {
    repo.upsert('repo-a', 1, 'commit-1')
    expect(repo.get('repo-a', 1)).toEqual({
      repositoryId: 'repo-a',
      prId: 1,
      votedCommitId: 'commit-1',
      updatedAt: 1001
    })
  })

  test('a second upsert moves the watermark to the new commit', () => {
    repo.upsert('repo-a', 1, 'commit-1')
    repo.upsert('repo-a', 1, 'commit-2')
    expect(repo.get('repo-a', 1)?.votedCommitId).toBe('commit-2')
  })

  test('the same prId in two repos are distinct rows (composite key)', () => {
    repo.upsert('repo-a', 1, 'commit-a')
    repo.upsert('repo-b', 1, 'commit-b')
    expect(repo.get('repo-a', 1)?.votedCommitId).toBe('commit-a')
    expect(repo.get('repo-b', 1)?.votedCommitId).toBe('commit-b')
  })

  test('delete removes exactly the addressed watermark', () => {
    repo.upsert('repo-a', 1, 'commit-1')
    repo.upsert('repo-a', 2, 'commit-2')
    repo.delete('repo-a', 1)
    expect(repo.get('repo-a', 1)).toBeUndefined()
    expect(repo.get('repo-a', 2)).toBeDefined()
  })

  test('prune drops watermarks absent from the latest sync and keeps the rest', () => {
    repo.upsert('repo-a', 1, 'commit-1')
    repo.upsert('repo-a', 2, 'commit-2')
    repo.upsert('repo-b', 1, 'commit-3')
    repo.prune([{ repositoryId: 'repo-a', prId: 1 }])
    expect(repo.get('repo-a', 1)).toBeDefined()
    expect(repo.get('repo-a', 2)).toBeUndefined()
    expect(repo.get('repo-b', 1)).toBeUndefined()
  })

  test('prune with an empty sync clears everything', () => {
    repo.upsert('repo-a', 1, 'commit-1')
    repo.prune([])
    expect(repo.get('repo-a', 1)).toBeUndefined()
  })
})
