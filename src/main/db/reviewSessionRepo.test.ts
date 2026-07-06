import { beforeEach, describe, expect, test } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { createReviewSessionRepo, type ReviewSessionRepo } from './reviewSessionRepo'
import { makeTestDb, makeTestDeps } from './testkit'

const input = {
  prId: 7,
  repositoryId: 'repo-a',
  repoDir: '/clones/repo-a',
  worktreePath: '/wt/abc'
}

describe('reviewSessionRepo', () => {
  let db: DatabaseSync
  let repo: ReviewSessionRepo

  beforeEach(() => {
    db = makeTestDb()
    repo = createReviewSessionRepo(db, makeTestDeps())
  })

  test('create starts a running session', () => {
    const s = repo.create(input)
    expect(s.id).toBe('id-1')
    expect(s.status).toBe('running')
    expect(s.worktreePath).toBe('/wt/abc')
  })

  test('getActive returns the running session and nothing once it is done', () => {
    const s = repo.create(input)
    expect(repo.getActive()?.id).toBe(s.id)
    repo.setStatus(s.id, 'completed')
    expect(repo.getActive()).toBeUndefined()
  })

  test('setStatus can mark a crashed session failed', () => {
    const s = repo.create(input)
    expect(repo.setStatus(s.id, 'failed').status).toBe('failed')
  })

  test('remove deletes the row', () => {
    const s = repo.create(input)
    repo.remove(s.id)
    expect(repo.get(s.id)).toBeUndefined()
  })

  test('CHECK rejects an invalid status', () => {
    const s = repo.create(input)
    expect(() => repo.setStatus(s.id, 'paused' as unknown as 'running')).toThrow()
  })
})
