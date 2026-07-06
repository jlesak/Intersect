import { describe, expect, test } from 'vitest'
import type { JiraIssue } from '@common/domain'
import { createMyWorkCacheRepo } from './myWorkCacheRepo'
import { makeTestDb } from './testkit'

const issue = (key: string): JiraIssue => ({
  key,
  url: `https://jira.skoda.vwgroup.com/browse/${key}`,
  summary: `Issue ${key}`,
  column: 'todo',
  priority: 'high',
  updatedAt: 1000
})

describe('myWorkCacheRepo', () => {
  test('returns null before anything was cached', () => {
    const repo = createMyWorkCacheRepo(makeTestDb())
    expect(repo.get()).toBeNull()
  })

  test('round-trips a snapshot', () => {
    const repo = createMyWorkCacheRepo(makeTestDb())
    repo.put({ issues: [issue('A-1'), issue('A-2')], fetchedAt: 42 })
    const got = repo.get()
    expect(got?.fetchedAt).toBe(42)
    expect(got?.issues.map((i) => i.key)).toEqual(['A-1', 'A-2'])
  })

  test('put replaces the previous snapshot', () => {
    const repo = createMyWorkCacheRepo(makeTestDb())
    repo.put({ issues: [issue('A-1')], fetchedAt: 1 })
    repo.put({ issues: [issue('B-1')], fetchedAt: 2 })
    const got = repo.get()
    expect(got?.fetchedAt).toBe(2)
    expect(got?.issues.map((i) => i.key)).toEqual(['B-1'])
  })
})
