import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { PullRequest } from '@common/domain'
import { prKey, usePrInboxStore } from '../store'
import { PrBoard } from './PrBoard'

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    prId: 7,
    repositoryId: 'repo-1',
    repositoryName: 'spot-backend',
    projectId: 'ado',
    title: 'Fix the sync',
    authorId: 'u1',
    authorName: 'Jan Lesak',
    createdAt: 3,
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
    ...over
  }
}

/** One PR per board column, so every column renders a card. */
const SEEDED = [
  pr(),
  pr({
    prId: 8,
    title: 'Rework the importer',
    role: 'author',
    createdAt: 2,
    reviewers: [{ id: 'r1', displayName: 'Eva Novak', vote: 'noVote', isRequired: true }]
  }),
  pr({
    prId: 9,
    title: 'Bump the ADO client',
    role: 'author',
    createdAt: 1,
    reviewers: [{ id: 'r1', displayName: 'Eva Novak', vote: 'approved', isRequired: true }]
  })
]

function seedBoard(prs: PullRequest[] = SEEDED): void {
  usePrInboxStore.setState({
    status: 'ready',
    error: null,
    syncing: false,
    prsByKey: Object.fromEntries(prs.map((p) => [prKey(p.repositoryId, p.prId), p])),
    order: prs.map((p) => prKey(p.repositoryId, p.prId))
  })
}

/**
 * The PR review board, mounted client-side. Static markup cannot expose a re-render loop, so only a
 * real root exercises how the board subscribes to the cached PR list.
 */
describe('PrBoard', () => {
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
    seedBoard()
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })
    try {
      await act(async () => {
        render(<PrBoard />)
      })

      expect(logged).toEqual([])
      expect(document.querySelectorAll('[data-testid="pr-card"]')).toHaveLength(3)
      const counts = [...document.querySelectorAll('.ix-board-col__count')].map((e) => e.textContent)
      expect(counts).toEqual(['1', '1', '1'])
    } finally {
      consoleError.mockRestore()
    }
  })

  test('a PR arriving from a sync re-renders the subscribed board', async () => {
    seedBoard([SEEDED[0]])

    await act(async () => {
      render(<PrBoard />)
    })
    await act(async () => {
      seedBoard(SEEDED)
    })

    expect(document.querySelectorAll('[data-testid="pr-card"]')).toHaveLength(3)
  })
})
