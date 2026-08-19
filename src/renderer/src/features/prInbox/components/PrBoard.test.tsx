import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { PullRequest } from '@common/domain'
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
    order: prs.map((p) => prKey(p.repositoryId, p.prId)),
    unfinishedReviewsStatus: 'ready',
    unfinishedReviewsError: null
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
      syncError: null,
      unfinishedReviews: {},
      unfinishedReviewsStatus: 'idle',
      unfinishedReviewsError: null
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

  test('admits when unfinished review counts could not be loaded', async () => {
    seedBoard()
    usePrInboxStore.setState({
      unfinishedReviewsStatus: 'error',
      unfinishedReviewsError: 'draft database unavailable'
    })

    await mountBoard()

    expect(document.querySelector('[data-testid="pr-draft-reviews-error"]')?.textContent).toContain(
      'draft database unavailable'
    )
    expect(document.querySelectorAll('[data-testid="pr-card"]')).toHaveLength(3)
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

/**
 * Two repositories, three distinguishable titles, and one pull request per column - so a chip and
 * a query each exclude something, and each of them empties a different column.
 */
const ACROSS_REPOS = [
  pr({ prId: 501, title: 'Add rate limiting to the sync pipeline', authorName: 'Jan Lesak' }),
  pr({
    prId: 502,
    title: 'Fix PTY backpressure on large output',
    authorName: 'Marek Kral',
    role: 'author',
    reviewers: [{ id: 'r1', displayName: 'Eva Novak', vote: 'noVote', isRequired: true }]
  }),
  pr({
    prId: 503,
    title: 'Extract the notification preferences screen',
    authorName: 'Petr Vala',
    repositoryId: 'repo-2',
    repositoryName: 'intersect-docs',
    role: 'author',
    reviewers: [{ id: 'r1', displayName: 'Eva Novak', vote: 'approved', isRequired: true }]
  })
]

const cardTitles = (): string[] =>
  [...document.querySelectorAll('.ix-board-card__title')].map((e) => e.textContent ?? '')

const byTestId = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!

describe('PrBoard filtering', () => {
  afterEach(() => {
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

  test('typing letters scattered through a title leaves only that pull request', async () => {
    seedBoard(ACROSS_REPOS)
    await mountBoard()

    // "xtnotif" is nowhere in the board as a run of characters.
    await act(async () => {
      fireEvent.change(byTestId('pr-filter'), { target: { value: 'xtnotif' } })
    })

    expect(cardTitles()).toEqual(['Extract the notification preferences screen'])
    expect(byTestId('pr-filter-count').textContent).toBe('1 of 3')
  })

  test('the box you type in tells a screen reader what it filters', async () => {
    seedBoard(ACROSS_REPOS)
    await mountBoard()

    expect(screen.getByRole('searchbox', { name: 'Filter pull requests' })).toBeTruthy()
  })

  test('a pull request is found by the number it is known as', async () => {
    seedBoard(ACROSS_REPOS)
    await mountBoard()

    await act(async () => {
      fireEvent.change(byTestId('pr-filter'), { target: { value: '!502' } })
    })

    expect(cardTitles()).toEqual(['Fix PTY backpressure on large output'])
  })

  test('narrowing to one repository drops the pull requests from the others', async () => {
    seedBoard(ACROSS_REPOS)
    await mountBoard()

    await act(async () => {
      fireEvent.click(byTestId('pr-filter-repo'))
    })
    await act(async () => {
      fireEvent.click(screen.getByText('None'))
    })
    await act(async () => {
      fireEvent.click(screen.getByLabelText('intersect-docs'))
    })

    expect(cardTitles()).toEqual(['Extract the notification preferences screen'])
  })

  test('a column the filter emptied collapses but still says which column it is', async () => {
    seedBoard(ACROSS_REPOS)
    await mountBoard()
    expect(byTestId('pr-col-action').className).not.toContain('ix-board-col--collapsed')

    await act(async () => {
      fireEvent.change(byTestId('pr-filter'), { target: { value: 'xtnotif' } })
    })

    expect(byTestId('pr-col-action').className).toContain('ix-board-col--collapsed')
    expect(byTestId('pr-col-action').textContent).toContain('Needs my action')
  })

  test('a filter nothing matches says so, and does not claim there is nothing to review', async () => {
    seedBoard(ACROSS_REPOS)
    await mountBoard()

    await act(async () => {
      fireEvent.change(byTestId('pr-filter'), { target: { value: 'zzzz' } })
    })

    expect(cardTitles()).toEqual([])
    expect(document.querySelector('.ix-boardfilter__none')?.textContent).toBe(
      'No pull requests match this filter.'
    )
    expect(document.querySelector('.ix-empty__title')).toBeNull()
  })

  test('a board with nothing synced still says there is nothing to review, with no bar to type in', async () => {
    seedBoard([])
    await mountBoard()

    expect(document.querySelector('.ix-empty__title')?.textContent).toBe('Nothing to review')
    expect(document.querySelector('[data-testid="pr-filter"]')).toBeNull()
  })
})

describe('PrBoard chip reconciliation', () => {
  afterEach(() => {
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

  test('a repository that drops out of a sync stops narrowing instead of trapping an empty board', async () => {
    seedBoard(ACROSS_REPOS)
    await mountBoard()
    await act(async () => {
      fireEvent.click(byTestId('pr-filter-repo'))
    })
    await act(async () => {
      fireEvent.click(screen.getByText('None'))
    })
    await act(async () => {
      fireEvent.click(screen.getByLabelText('intersect-docs'))
    })
    expect(cardTitles()).toEqual(['Extract the notification preferences screen'])

    // The next sync returns only the other repository's pull requests.
    await act(async () => {
      seedBoard(ACROSS_REPOS.filter((p) => p.repositoryId === 'repo-1'))
    })

    // The board is empty, and the chip says exactly why: nothing it offers is ticked. A count that
    // still read 1/1 over an unticked list would be the control lying about its own state.
    expect(cardTitles()).toEqual([])
    expect(byTestId('pr-filter-repo').textContent).toContain('0/1')
    expect(screen.getAllByRole('checkbox').filter((b) => (b as HTMLInputElement).checked)).toEqual(
      []
    )

    // And the user is not stuck: the control is still there to undo it.
    await act(async () => {
      fireEvent.click(screen.getByText('All'))
    })
    expect(cardTitles()).toHaveLength(2)
  })
})
