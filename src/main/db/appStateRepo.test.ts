import { beforeEach, describe, expect, test } from 'vitest'
import { createAppStateRepo, type AppStateRepo } from './appStateRepo'
import { makeTestDb } from './testkit'

describe('appStateRepo', () => {
  let repo: AppStateRepo

  beforeEach(() => {
    repo = createAppStateRepo(makeTestDb())
  })

  test('get returns null for an unset key', () => {
    expect(repo.get('selected_workspace_id')).toBeNull()
  })

  test('set then get returns the stored value', () => {
    repo.set('selected_workspace_id', 'w1')
    expect(repo.get('selected_workspace_id')).toBe('w1')
  })

  test('set overwrites an existing value', () => {
    repo.set('k', 'a')
    repo.set('k', 'b')
    expect(repo.get('k')).toBe('b')
  })

  test('setting null clears the value', () => {
    repo.set('k', 'a')
    repo.set('k', null)
    expect(repo.get('k')).toBeNull()
  })
})
