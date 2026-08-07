import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { PullRequest } from '@common/domain'

// The board reads the shared relative-time formatter through the My Work barrel, which transitively
// reaches monaco - and monaco cannot initialise under jsdom.
vi.mock('monaco-editor', () => ({ editor: {} }))

import { prKey, usePrInboxStore } from '../store'
import { PrBoard } from './PrBoard'

const MINUTE = 60_000

/**
 * The age at which the freshness chip stops being a quiet fact and becomes a warning.
 *
 * Written out here rather than imported from the board, so the number the user actually sees is
 * pinned by this suite instead of following the implementation wherever it moves. It has to stay far
 * above the five minutes that trigger an automatic refresh: were the two ever swapped, an in-use
 * board would sit permanently tinted and the warning would mean nothing.
 */
const WARN_AFTER = 15 * MINUTE

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
    lastActivityAt: 3,
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

/** Mount the board and fail the test on any React or store-guard complaint. */
async function mountBoard(): Promise<{ logged: string[] }> {
  const logged: string[] = []
  const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
  })
  try {
    await act(async () => {
      render(<PrBoard />)
    })
  } finally {
    consoleError.mockRestore()
  }
  return { logged }
}

const syncChip = (): Element | null => document.querySelector('[data-testid="pr-sync-age"]')

/**
 * The PR review board, mounted client-side. Static markup cannot expose a re-render loop, so only a
 * real root exercises how the board subscribes to the cached PR list.
 */
describe('PrBoard', () => {
  // Freshness is read in milliseconds against a threshold, so a real clock makes the cases that sit
  // a millisecond either side of it a coin toss. A controlled clock also lets time pass on demand.
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    usePrInboxStore.setState({
      status: 'idle',
      error: null,
      syncing: false,
      prsByKey: {},
      order: [],
      syncedAt: null,
      syncError: null
    })
  })

  test('mounts and settles without a render loop', async () => {
    seedBoard()

    const { logged } = await mountBoard()

    expect(logged).toEqual([])
    expect(document.querySelectorAll('[data-testid="pr-card"]')).toHaveLength(3)
    const counts = [...document.querySelectorAll('.ix-board-col__count')].map((e) => e.textContent)
    expect(counts).toEqual(['1', '1', '1'])
  })

  test('says how long ago the board last synced', async () => {
    seedBoard()
    usePrInboxStore.setState({ syncedAt: Date.now() - 4 * MINUTE })

    const { logged } = await mountBoard()

    expect(logged).toEqual([])
    expect(syncChip()?.textContent).toBe('Synced 4m ago')
    expect(syncChip()?.className).not.toContain('ix-chip--warn')
  })

  test('a board that never synced says so instead of claiming an age', async () => {
    seedBoard()

    await mountBoard()

    expect(syncChip()?.textContent).toBe('never synced')
  })

  test('warns once the board has gone a quarter of an hour without a sync', async () => {
    seedBoard()
    usePrInboxStore.setState({ syncedAt: Date.now() - 16 * MINUTE })

    await mountBoard()

    expect(syncChip()?.textContent).toBe('Synced 16m ago')
    expect(syncChip()?.className).toContain('ix-chip--warn')
  })

  test('stays quiet a millisecond short of a quarter of an hour', async () => {
    seedBoard()
    usePrInboxStore.setState({ syncedAt: Date.now() - (WARN_AFTER - 1) })

    await mountBoard()

    expect(syncChip()?.className).not.toContain('ix-chip--warn')
  })

  test('warns the millisecond the board turns a quarter of an hour stale', async () => {
    seedBoard()
    usePrInboxStore.setState({ syncedAt: Date.now() - WARN_AFTER })

    await mountBoard()

    expect(syncChip()?.className).toContain('ix-chip--warn')
  })

  test('keeps its own clock, so freshness ages while the board stays open', async () => {
    seedBoard()
    usePrInboxStore.setState({ syncedAt: Date.now() - 4 * MINUTE })

    await mountBoard()
    expect(syncChip()?.textContent).toBe('Synced 4m ago')

    await act(async () => {
      vi.advanceTimersByTime(MINUTE)
    })

    expect(syncChip()?.textContent).toBe('Synced 5m ago')
  })

  test('a failed refresh is admitted with the cached board still readable', async () => {
    seedBoard()
    usePrInboxStore.setState({ syncedAt: Date.now() - MINUTE, syncError: 'ADO is unreachable' })

    const { logged } = await mountBoard()

    expect(logged).toEqual([])
    expect(document.querySelector('[data-testid="pr-sync-error"]')?.textContent).toBe(
      'Could not refresh: ADO is unreachable'
    )
    expect(document.querySelectorAll('[data-testid="pr-card"]')).toHaveLength(3)
  })

  test('says nothing about refreshing while the last sync succeeded', async () => {
    seedBoard()
    usePrInboxStore.setState({ syncedAt: Date.now() - MINUTE })

    await mountBoard()

    expect(document.querySelector('[data-testid="pr-sync-error"]')).toBeNull()
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
