import { describe, expect, test } from 'vitest'
import {
  computeWorkItemState,
  parsePrExternalKey,
  type WorkItemStateDeps
} from './workItemState'

const deps = (over: Partial<WorkItemStateDeps> = {}): WorkItemStateDeps => ({
  jiraIssuePresence: () => 'present',
  todoExists: () => true,
  prCached: () => true,
  ...over
})

describe('computeWorkItemState', () => {
  test('a jira issue still cached anywhere is linked', () => {
    expect(computeWorkItemState('jira', 'FID-1', deps())).toBe('linked')
  })

  test('a jira issue flagged absent by every source is stale, never deleted', () => {
    expect(
      computeWorkItemState('jira', 'FID-1', deps({ jiraIssuePresence: () => 'absent' }))
    ).toBe('stale')
  })

  test('a jira issue no cache has ever seen is missing', () => {
    expect(
      computeWorkItemState('jira', 'FID-1', deps({ jiraIssuePresence: () => 'unknown' }))
    ).toBe('missing')
  })

  test('a todo task that still exists is linked - done counts as existing', () => {
    expect(computeWorkItemState('todo', 't-1', deps())).toBe('linked')
  })

  test('a hard-deleted todo task is missing', () => {
    expect(computeWorkItemState('todo', 't-1', deps({ todoExists: () => false }))).toBe('missing')
  })

  test('a cached PR is linked', () => {
    expect(computeWorkItemState('ado-pr', 'repo-guid:12', deps())).toBe('linked')
  })

  test('a PR gone from the replace-on-sync cache is only stale (absence is weak evidence)', () => {
    expect(
      computeWorkItemState('ado-pr', 'repo-guid:12', deps({ prCached: () => false }))
    ).toBe('stale')
  })

  test('a malformed PR key degrades to stale rather than throwing', () => {
    expect(computeWorkItemState('ado-pr', 'garbage', deps())).toBe('stale')
  })
})

describe('parsePrExternalKey', () => {
  test('splits on the last colon and parses the PR id', () => {
    expect(parsePrExternalKey('repo-guid:12')).toEqual({ repositoryId: 'repo-guid', prId: 12 })
  })

  test('returns null for keys without a colon, an empty side, or a non-numeric id', () => {
    expect(parsePrExternalKey('repo-guid')).toBeNull()
    expect(parsePrExternalKey(':12')).toBeNull()
    expect(parsePrExternalKey('repo:')).toBeNull()
    expect(parsePrExternalKey('repo:abc')).toBeNull()
  })
})
