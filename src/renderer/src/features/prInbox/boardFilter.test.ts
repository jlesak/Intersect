import type { PullRequest } from '@common/domain'
import { describe, expect, test } from 'vitest'
import { NO_PR_FILTER, filterPrs, prFilterOptions } from './boardFilter'

function pr(over: Partial<PullRequest> & Pick<PullRequest, 'prId'>): PullRequest {
  return {
    repositoryId: 'repo-1',
    repositoryName: 'intersect-app',
    projectId: 'SPOT',
    title: '',
    description: '',
    authorId: 'u1',
    authorName: 'Jan Lesak',
    createdAt: 0,
    status: 'active',
    sourceRefName: 'refs/heads/feature',
    targetRefName: 'refs/heads/main',
    sourceCommitId: 'a',
    targetCommitId: 'b',
    url: 'https://ado/pr',
    role: 'reviewer',
    myVote: null,
    myReviewerId: null,
    reviewers: [],
    newChangesSinceMyReview: false,
    activeThreadCount: 0,
    lastActivityAt: 0,
    ...over
  }
}

const RATE = pr({ prId: 501, title: 'Add rate limiting to the sync pipeline', authorName: 'Jan Lesak' })
const PTY = pr({ prId: 502, title: 'Fix PTY backpressure on large output', authorName: 'Marek Kral' })
const NOTIF = pr({
  prId: 503,
  title: 'Extract the notification preferences screen',
  authorName: 'Petr Vala',
  repositoryId: 'repo-2',
  repositoryName: 'intersect-docs'
})

const ALL = [RATE, PTY, NOTIF]
const ids = (prs: readonly PullRequest[]): number[] => prs.map((p) => p.prId)

describe('filterPrs', () => {
  test('an empty filter keeps every pull request in the order given', () => {
    expect(filterPrs(ALL, NO_PR_FILTER)).toEqual(ALL)
  })

  test('free text finds a pull request by scattered letters of its title', () => {
    // "xtnotif" appears nowhere as a run of characters; only a subsequence matcher finds it.
    expect(ids(filterPrs(ALL, { ...NO_PR_FILTER, query: 'xtnotif' }))).toEqual([503])
  })

  test('free text finds a pull request by its author', () => {
    expect(ids(filterPrs(ALL, { ...NO_PR_FILTER, query: 'Marek' }))).toEqual([502])
  })

  test('free text finds a pull request by its repository', () => {
    expect(ids(filterPrs(ALL, { ...NO_PR_FILTER, query: 'docs' }))).toEqual([503])
  })

  test('free text finds a pull request by its number, with or without the mark', () => {
    expect(ids(filterPrs(ALL, { ...NO_PR_FILTER, query: '!502' }))).toEqual([502])
    expect(ids(filterPrs(ALL, { ...NO_PR_FILTER, query: '502' }))).toEqual([502])
  })

  test('surviving pull requests keep the order they came in, so the columns own their sort', () => {
    const found = filterPrs(ALL, { ...NO_PR_FILTER, query: 'ra' })
    expect(ids(found)).toEqual([501, 502, 503])
  })

  test('a repository chip drops the pull requests from every other repository', () => {
    expect(ids(filterPrs(ALL, { ...NO_PR_FILTER, repos: ['repo-2'] }))).toEqual([503])
    expect(ids(filterPrs(ALL, { ...NO_PR_FILTER, repos: ['repo-1'] }))).toEqual([501, 502])
  })

  test('text and the repository chip narrow together', () => {
    const inApp = { query: 'e', repos: ['repo-1'] }
    expect(ids(filterPrs(ALL, inApp))).toEqual([501, 502])
    expect(ids(filterPrs(ALL, { ...inApp, query: 'xtnotif' }))).toEqual([])
  })
})

describe('prFilterOptions', () => {
  test('offers each repository once, named as the cards name it', () => {
    expect(prFilterOptions(ALL).repos).toEqual([
      { value: 'repo-1', label: 'intersect-app' },
      { value: 'repo-2', label: 'intersect-docs' }
    ])
  })

  test('a board with nothing on it offers nothing to choose from', () => {
    expect(prFilterOptions([]).repos).toEqual([])
  })
})
