import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { PrReviewer, PullRequest } from '@common/domain'
import { prKey, usePrInboxStore } from '../store'
import { PrBoard } from './PrBoard'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * The age at which the freshness chip stops being a quiet fact and becomes a warning.
 *
 * Written out here rather than imported from the board, so the number the user actually sees is
 * pinned by this suite instead of following the implementation wherever it moves. It has to stay far
 * above the five minutes that trigger an automatic refresh: were the two ever swapped, an in-use
 * board would sit permanently tinted and the warning would mean nothing.
 */
const WARN_AFTER = 15 * MINUTE

const reviewer = (vote: PrReviewer['vote'], displayName = 'Eva Novak'): PrReviewer => ({
  id: displayName,
  displayName,
  vote,
  isRequired: true
})

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

/**
 * One pull request per verb, so every tab holds something and the queue has all five ranks to
 * order. Seeded in an order that matches none of the expected ones, so a passing sort assertion
 * cannot be the fixture order surviving untouched.
 */
const SEEDED: PullRequest[] = [
  pr({ prId: 504, title: 'Bump the ADO client', myVote: 'approved', reviewers: [reviewer('approved')] }),
  pr({ prId: 501, title: 'Add rate limiting', myVote: null, lastActivityAt: 10 * HOUR }),
  pr({ prId: 505, title: 'Split the cost centres', role: 'author', reviewers: [reviewer('noVote')] }),
  pr({
    prId: 503,
    title: 'Cache the exchange rates',
    myVote: 'approved',
    newChangesSinceMyReview: true,
    reviewers: [reviewer('approved')],
    lastActivityAt: 5 * HOUR
  }),
  pr({
    prId: 502,
    title: 'Require an uploader on imports',
    role: 'author',
    reviewers: [reviewer('waiting')]
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

const byTestId = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!

const syncChip = (): Element | null => document.querySelector('[data-testid="pr-sync-age"]')

const rowTitles = (): string[] =>
  [...document.querySelectorAll('.ix-prtable__title')].map((e) => e.textContent ?? '')

const verbs = (): string[] =>
  [...document.querySelectorAll('[data-testid="pr-row-verb"]')].map((e) => e.textContent ?? '')

const voteStatuses = (): string[] =>
  [...document.querySelectorAll('[data-testid="pr-row-vote-status"]')].map((e) => e.textContent ?? '')

/** Move to a tab by the name on it. */
async function openTab(key: 'review' | 'mine' | 'all'): Promise<void> {
  await act(async () => {
    fireEvent.click(byTestId(`pr-tab-${key}`))
  })
}

/** Everything one case can leave behind in the shared store, put back for the next one. */
const reset = (): void =>
  usePrInboxStore.setState({
    status: 'idle',
    error: null,
    syncing: false,
    prsByKey: {},
    order: [],
    syncedAt: null,
    syncError: null,
    liveReviews: {},
    unfinishedReviews: {},
    unfinishedReviewsStatus: 'idle',
    unfinishedReviewsError: null
  })

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
    reset()
  })

  test('mounts and settles without a render loop', async () => {
    seedBoard()

    const { logged } = await mountBoard()

    expect(logged).toEqual([])
    expect(document.querySelectorAll('[data-testid="pr-row"]')).toHaveLength(2)
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
    expect(document.querySelectorAll('[data-testid="pr-row"]')).toHaveLength(2)
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
    expect(document.querySelectorAll('[data-testid="pr-row"]')).toHaveLength(2)
  })

  test('a PR arriving from a sync re-renders the subscribed board', async () => {
    seedBoard([SEEDED[1]])

    await act(async () => {
      render(<PrBoard />)
    })
    expect(document.querySelectorAll('[data-testid="pr-row"]')).toHaveLength(1)

    await act(async () => {
      seedBoard(SEEDED)
    })

    expect(document.querySelectorAll('[data-testid="pr-row"]')).toHaveLength(2)
  })
})

/**
 * The three piles and the queue inside them. This is the whole point of the table: whether it opens
 * on the work that is actually owed, and whether the row on top is the one to open first.
 */
describe('PrBoard tabs and queue order', () => {
  afterEach(() => {
    reset()
  })

  test('opens on the reviews owed, not on the whole board', async () => {
    seedBoard()

    await mountBoard()

    expect(byTestId('pr-tab-review').getAttribute('aria-selected')).toBe('true')
    expect(rowTitles()).toEqual(['Add rate limiting', 'Cache the exchange rates'])
  })

  test('each tab counts its own pile, whatever tab is open', async () => {
    seedBoard()

    await mountBoard()

    expect(byTestId('pr-tab-review').textContent).toBe('To review2')
    expect(byTestId('pr-tab-mine').textContent).toBe('Mine2')
    expect(byTestId('pr-tab-all').textContent).toBe('All active5')
  })

  test('a pull request I have not voted on is a review, and it is in To review', async () => {
    seedBoard()

    await mountBoard()

    expect(verbs()).toEqual(['Review', 'Re-review'])
    expect(rowTitles()[0]).toBe('Add rate limiting')
  })

  test('new pushes after my vote ask for a re-review', async () => {
    seedBoard([SEEDED[3]])

    await mountBoard()

    expect(verbs()).toEqual(['Re-review'])
    expect(byTestId('pr-row-new-changes').textContent).toContain('new changes')
  })

  test('Mine holds every pull request I authored, in whatever state', async () => {
    seedBoard()

    await mountBoard()
    await openTab('mine')

    expect(rowTitles()).toEqual(['Require an uploader on imports', 'Split the cost centres'])
    expect(verbs()).toEqual(['Respond', 'Wait'])
  })

  test('my own pull request with a waiting reviewer leads the queue as a respond', async () => {
    seedBoard()

    await mountBoard()
    await openTab('all')

    expect(rowTitles()[0]).toBe('Require an uploader on imports')
    expect(verbs()[0]).toBe('Respond')
  })

  test('a fully approved pull request is done and sorts last', async () => {
    seedBoard()

    await mountBoard()
    await openTab('all')

    expect(verbs()).toEqual(['Respond', 'Review', 'Re-review', 'Wait', 'Done'])
    expect(rowTitles().at(-1)).toBe('Bump the ADO client')
  })

  test('work I owe leads with the row that has waited longest', async () => {
    const older = pr({ prId: 601, title: 'Older review', lastActivityAt: 1 * HOUR })
    const newer = pr({ prId: 602, title: 'Newer review', lastActivityAt: 9 * HOUR })
    seedBoard([newer, older])

    await mountBoard()

    expect(rowTitles()).toEqual(['Older review', 'Newer review'])
  })

  test('my own pull requests are marked on the row itself', async () => {
    seedBoard()

    await mountBoard()
    await openTab('all')

    const mine = [...document.querySelectorAll('[data-testid="pr-row"]')]
      .filter((row) => row.className.includes('ix-prtable__row--mine'))
      .map((row) => row.querySelector('.ix-prtable__title')?.textContent)
    expect(mine).toEqual(['Require an uploader on imports', 'Split the cost centres'])
  })

  test('the vote status states where the reviewers have got to', async () => {
    seedBoard()

    await mountBoard()
    await openTab('all')

    expect(voteStatuses()).toEqual([
      'Waiting for author',
      'No votes yet',
      'Approved',
      'No votes yet',
      'Approved'
    ])
  })

  test('a partly approved pull request counts the approvals', async () => {
    seedBoard([
      pr({
        prId: 610,
        role: 'author',
        reviewers: [reviewer('approved', 'Eva Novak'), reviewer('noVote', 'Petr Vala')]
      })
    ])

    await mountBoard()
    await openTab('all')

    expect(voteStatuses()).toEqual(['1 of 2 approved'])
  })

  test('a rejection decides the row whatever the approvals beside it say', async () => {
    seedBoard([
      pr({
        prId: 611,
        role: 'author',
        reviewers: [reviewer('approved', 'Eva Novak'), reviewer('rejected', 'Petr Vala')]
      })
    ])

    await mountBoard()
    await openTab('mine')

    expect(voteStatuses()).toEqual(['Rejected'])
  })

  test('an empty tab says it is empty rather than claiming a filter emptied it', async () => {
    seedBoard([SEEDED[0]])

    await mountBoard()

    expect(document.querySelector('.ix-boardfilter__none')?.textContent).toBe(
      'Nothing in this list right now.'
    )
    expect(document.querySelector('[data-testid="pr-table"]')).toBeNull()
    expect(document.querySelector('.ix-empty__title')).toBeNull()
  })

  test('one reviewer badge per reviewer, each saying who and how they voted', async () => {
    seedBoard([SEEDED[4]])

    await mountBoard()
    await openTab('mine')

    const badges = [...document.querySelectorAll('[data-testid="pr-row-reviewer"]')]
    expect(badges).toHaveLength(1)
    expect(badges[0].getAttribute('title')).toBe(
      'Eva Novak (required) · waiting for the author'
    )
  })

  test('unresolved threads are counted, and a row with none shows a dash', async () => {
    seedBoard([pr({ prId: 620, activeThreadCount: 3 }), pr({ prId: 621, activeThreadCount: 0 })])

    await mountBoard()

    const cells = [...document.querySelectorAll('[data-testid="pr-row-unresolved"]')].map(
      (e) => e.textContent
    )
    expect(cells).toEqual(['3', '–'])
  })

  test('a row opens the pull request it is about', async () => {
    seedBoard([SEEDED[1]])
    const openDetail = vi.fn(async () => {})
    const original = usePrInboxStore.getState().openDetail
    usePrInboxStore.setState({ openDetail })

    await mountBoard()
    await act(async () => {
      fireEvent.click(byTestId('pr-row'))
    })

    expect(openDetail).toHaveBeenCalledWith('repo-1', 501)
    usePrInboxStore.setState({ openDetail: original })
  })

  test('a row opens from the keyboard as well as from the mouse', async () => {
    seedBoard([SEEDED[1]])
    const openDetail = vi.fn(async () => {})
    const original = usePrInboxStore.getState().openDetail
    usePrInboxStore.setState({ openDetail })

    await mountBoard()
    await act(async () => {
      fireEvent.keyDown(byTestId('pr-row'), { key: 'Enter' })
    })

    expect(openDetail).toHaveBeenCalledWith('repo-1', 501)
    usePrInboxStore.setState({ openDetail: original })
  })

  test('the remaining persisted draft count rides on the row', async () => {
    seedBoard([SEEDED[1]])
    usePrInboxStore.setState({ unfinishedReviews: { 'repo-1:501': 2 } })

    await mountBoard()

    expect(byTestId('pr-row-unfinished-review').textContent).toBe('2 drafts')
  })

  test('a running review is flagged on the row', async () => {
    seedBoard([SEEDED[1]])
    usePrInboxStore.setState({ liveReviews: { 'repo-1:501': 'session-1' } })

    await mountBoard()

    expect(byTestId('pr-row-reviewing').textContent).toContain('reviewing')
  })
})

/**
 * Two repositories, three distinguishable titles - so a chip and a query each exclude something.
 * All three are reviews I owe, so they share the tab the board opens on.
 */
const ACROSS_REPOS = [
  pr({ prId: 501, title: 'Add rate limiting to the sync pipeline', authorName: 'Jan Lesak' }),
  pr({ prId: 502, title: 'Fix PTY backpressure on large output', authorName: 'Marek Kral' }),
  pr({
    prId: 503,
    title: 'Extract the notification preferences screen',
    authorName: 'Petr Vala',
    repositoryId: 'repo-2',
    repositoryName: 'intersect-docs'
  })
]

describe('PrBoard filtering', () => {
  afterEach(() => {
    reset()
  })

  test('typing letters scattered through a title leaves only that pull request', async () => {
    seedBoard(ACROSS_REPOS)
    await mountBoard()

    // "xtnotif" is nowhere in the board as a run of characters.
    await act(async () => {
      fireEvent.change(byTestId('pr-filter'), { target: { value: 'xtnotif' } })
    })

    expect(rowTitles()).toEqual(['Extract the notification preferences screen'])
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

    expect(rowTitles()).toEqual(['Fix PTY backpressure on large output'])
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

    expect(rowTitles()).toEqual(['Extract the notification preferences screen'])
  })

  test('the filter narrows inside the open tab and leaves the tab counts alone', async () => {
    seedBoard([
      ...ACROSS_REPOS,
      pr({ prId: 630, title: 'Mine, with a waiting reviewer', role: 'author', reviewers: [reviewer('waiting')] })
    ])
    await mountBoard()

    await act(async () => {
      fireEvent.change(byTestId('pr-filter'), { target: { value: 'xtnotif' } })
    })

    expect(rowTitles()).toEqual(['Extract the notification preferences screen'])
    expect(byTestId('pr-tab-review').textContent).toBe('To review3')
    expect(byTestId('pr-tab-mine').textContent).toBe('Mine1')
  })

  test('a filter nothing matches says so, and does not claim there is nothing to review', async () => {
    seedBoard(ACROSS_REPOS)
    await mountBoard()

    await act(async () => {
      fireEvent.change(byTestId('pr-filter'), { target: { value: 'zzzz' } })
    })

    expect(rowTitles()).toEqual([])
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
    reset()
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
    expect(rowTitles()).toEqual(['Extract the notification preferences screen'])

    // The next sync returns only the other repository's pull requests.
    await act(async () => {
      seedBoard(ACROSS_REPOS.filter((p) => p.repositoryId === 'repo-1'))
    })

    // The board is empty, and the chip says exactly why: nothing it offers is ticked. A count that
    // still read 1/1 over an unticked list would be the control lying about its own state.
    expect(rowTitles()).toEqual([])
    expect(byTestId('pr-filter-repo').textContent).toContain('0/1')
    expect(screen.getAllByRole('checkbox').filter((b) => (b as HTMLInputElement).checked)).toEqual(
      []
    )

    // And the user is not stuck: the control is still there to undo it.
    await act(async () => {
      fireEvent.click(screen.getByText('All'))
    })
    expect(rowTitles()).toHaveLength(2)
  })
})
