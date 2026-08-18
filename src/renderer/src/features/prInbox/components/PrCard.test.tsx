import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { PullRequest } from '@common/domain'
import { usePrInboxStore } from '../store'
import { PrCard } from './PrCard'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** A fixed clock, so an age on screen is a fact about the fixture rather than about the test run. */
const NOW = 1_780_000_000_000

/** A pull request opened a dozen days ago and untouched since, unless a case says otherwise. */
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
    createdAt: NOW - 12 * DAY,
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
    lastActivityAt: NOW - 12 * DAY,
    ...over
  }
}

/** Mount one card and fail the test on any React or store-guard complaint. */
async function mountCard(card: PullRequest): Promise<{ logged: string[] }> {
  const logged: string[] = []
  const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
  })
  try {
    await act(async () => {
      render(<PrCard pr={card} urgent={false} now={NOW} />)
    })
  } finally {
    consoleError.mockRestore()
  }
  return { logged }
}

const meta = (): string => document.querySelector('.ix-board-card__meta')?.textContent ?? ''
const chips = (): string[] =>
  [...document.querySelectorAll('.ix-board-card__row .ix-chip')].map((e) => e.textContent ?? '')

/**
 * One board card. What it dates itself by decides whether a review queue reads as a queue, so the
 * age and the two attention badges are pinned rather than eyeballed.
 */
describe('PrCard', () => {
  afterEach(() => {
    usePrInboxStore.setState({ reviewPrKey: null, unfinishedReviews: {} })
  })

  test('dates the card by its last activity, not by when it was opened', async () => {
    const { logged } = await mountCard(pr({ lastActivityAt: NOW - 2 * HOUR }))

    expect(logged).toEqual([])
    expect(meta()).toContain('2h ago')
    expect(meta()).not.toContain('12d')
  })

  test('ages with the board clock rather than with the wall clock', async () => {
    await mountCard(pr({ lastActivityAt: NOW - 45 * MINUTE }))

    expect(meta()).toContain('45m ago')
  })

  test('flags new changes only when there are changes since my review', async () => {
    await mountCard(pr({ newChangesSinceMyReview: true }))
    expect(chips().some((c) => c.includes('new changes'))).toBe(true)

    cleanup()
    await mountCard(pr({ newChangesSinceMyReview: false }))
    expect(chips().some((c) => c.includes('new changes'))).toBe(false)
  })

  test('counts unresolved threads only when some are unresolved', async () => {
    await mountCard(pr({ activeThreadCount: 3 }))
    expect(chips()).toContain('3 unresolved')

    cleanup()
    await mountCard(pr({ activeThreadCount: 0 }))
    expect(chips().some((c) => c.includes('unresolved'))).toBe(false)
  })

  /**
   * In the action column the reason chip can be announcing the very thing the badge beside it
   * announces. One fact wearing two chips reads as two things needing attention, which on the one
   * surface built to say what needs the user is the wrong answer.
   */
  test('does not repeat new changes the reason chip has already given as the reason', async () => {
    await mountCard(pr({ role: 'reviewer', myVote: 'approved', newChangesSinceMyReview: true }))

    expect(chips()).toContain('new changes since your review')
    expect(chips().filter((c) => c.includes('new changes'))).toHaveLength(1)
  })

  test('still flags new changes when the reason chip is saying something else', async () => {
    await mountCard(pr({ role: 'reviewer', myVote: null, newChangesSinceMyReview: true }))

    expect(chips()).toContain('no vote yet')
    expect(chips().some((c) => c.includes('● new changes'))).toBe(true)
  })

  test('does not repeat a thread count the reason chip has already given as the reason', async () => {
    await mountCard(pr({ role: 'author', reviewers: [], activeThreadCount: 3 }))

    expect(chips()).toContain('3 unresolved comments')
    expect(chips()).not.toContain('3 unresolved')
  })

  test('still counts unresolved threads when the reason chip is saying something else', async () => {
    await mountCard(pr({ role: 'reviewer', myVote: null, activeThreadCount: 3 }))

    expect(chips()).toContain('no vote yet')
    expect(chips()).toContain('3 unresolved')
  })

  test('surfaces the remaining persisted draft count independently of a live review', async () => {
    usePrInboxStore.setState({ unfinishedReviews: { 'repo-1:7': 2 }, reviewPrKey: null })

    await mountCard(pr())

    expect(document.querySelector('[data-testid="pr-card-unfinished-review"]')?.textContent).toContain(
      '2 drafts to review'
    )
  })
})
