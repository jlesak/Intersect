import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { PullRequest } from '@common/domain'
import { usePrInboxStore } from '@renderer/features/prInbox'
import { PrRadar } from './PrRadar'

// The PR-inbox barrel transitively imports monaco, which cannot initialise under jsdom. The radar
// never renders an editor, so an inert stand-in is enough to import the barrel's store.
vi.mock('monaco-editor', () => ({ editor: {} }))

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    prId: 7,
    repositoryId: 'repo-1',
    repositoryName: 'spot-backend',
    projectId: 'ado',
    title: 'Fix the sync',
    description: '',
    authorId: 'u1',
    authorName: 'Jan Lesak',
    createdAt: Date.now() - 3_600_000,
    status: 'active',
    sourceRefName: 'refs/heads/feature',
    targetRefName: 'refs/heads/main',
    sourceCommitId: 'a',
    targetCommitId: 'b',
    url: 'https://ado/pr/7',
    role: 'reviewer',
    myVote: null,
    myReviewerId: null,
    reviewers: [],
    newChangesSinceMyReview: false,
    activeThreadCount: 0,
    lastActivityAt: Date.now() - 3_600_000,
    ...over
  }
}

/** One PR per radar subgroup, plus a caught-up review that belongs to no group. */
const SEEDED = [
  pr({
    prId: 8,
    title: 'Rework the importer',
    role: 'author',
    reviewers: [{ id: 'r1', displayName: 'Eva Novak', vote: 'approved', isRequired: true }]
  }),
  pr(),
  pr({
    prId: 9,
    title: 'Bump the ADO client',
    myVote: 'approved',
    myReviewerId: 'me',
    newChangesSinceMyReview: true
  }),
  pr({ prId: 10, title: 'Tidy the logs', myVote: 'approved', myReviewerId: 'me' })
]

/** The `${repositoryId}:${prId}` key the PR-inbox slice stores and orders a PR under. */
const key = (p: PullRequest): string => `${p.repositoryId}:${p.prId}`

function seedPrs(prs: PullRequest[]): void {
  usePrInboxStore.setState({
    status: 'ready',
    error: null,
    syncing: false,
    prsByKey: Object.fromEntries(prs.map((p) => [key(p), p])),
    order: prs.map(key)
  })
}

/**
 * The My Work PR radar, mounted client-side. Static markup cannot expose a re-render loop, so only
 * a real root exercises how the card subscribes to the cached PR list.
 */
describe('PrRadar', () => {
  afterEach(() => {
    usePrInboxStore.setState({
      status: 'idle',
      error: null,
      syncing: false,
      prsByKey: {},
      order: []
    })
  })

  test('mounts and settles without a render loop', async () => {
    seedPrs(SEEDED)
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })
    try {
      await act(async () => {
        render(<PrRadar />)
      })

      expect(logged).toEqual([])
      const labels = [...document.querySelectorAll('.ix-mw-subgroup__label')].map((e) => e.textContent)
      expect(labels).toEqual([
        'My PRs waiting to merge',
        'Waiting on my review',
        'New changes since my review'
      ])
      // The caught-up review is deliberately off the radar.
      expect(document.querySelectorAll('.ix-mw-row')).toHaveLength(3)
      expect(document.querySelector('.ix-mw-section__count')?.textContent).toBe('3')
    } finally {
      consoleError.mockRestore()
    }
  })

  test('a finished sync re-renders the subscribed radar', async () => {
    usePrInboxStore.setState({ status: 'loading', syncing: true, prsByKey: {}, order: [] })

    await act(async () => {
      render(<PrRadar />)
    })
    expect(document.querySelector('.ix-mw-pr-loading')).toBeTruthy()

    await act(async () => {
      seedPrs(SEEDED)
    })

    expect(document.querySelector('.ix-mw-pr-loading')).toBeNull()
    expect(document.querySelectorAll('.ix-mw-row')).toHaveLength(3)
  })
})
