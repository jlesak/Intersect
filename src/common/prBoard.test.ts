import { describe, expect, test } from 'vitest'
import type { PrReviewer, PrThread, PullRequest } from './domain'
import {
  boardColumn,
  boardReason,
  compareQueue,
  isThreadUnresolved,
  queueVerb,
  voteRollup
} from './prBoard'

const reviewer = (vote: PrReviewer['vote'], name = 'R'): PrReviewer => ({
  id: name,
  displayName: name,
  vote,
  isRequired: false
})

const pr = (over: Partial<PullRequest>): PullRequest => ({
  prId: 1,
  repositoryId: 'repo',
  repositoryName: 'repo',
  projectId: 'p',
  title: 't',
  description: '',
  authorId: 'a',
  authorName: 'A',
  createdAt: 0,
  status: 'active',
  sourceRefName: 'refs/heads/f',
  targetRefName: 'refs/heads/main',
  sourceCommitId: 's',
  targetCommitId: 't',
  url: 'u',
  role: 'reviewer',
  myVote: null,
  myReviewerId: null,
  reviewers: [],
  newChangesSinceMyReview: false,
  activeThreadCount: 0,
  lastActivityAt: 0,
  ...over
})

describe('boardColumn', () => {
  test('reviewer without a vote needs action', () => {
    expect(boardColumn(pr({ role: 'reviewer', myVote: null }))).toBe('action')
    expect(boardColumn(pr({ role: 'reviewer', myVote: 'noVote' }))).toBe('action')
  })

  test('reviewer with new changes since their vote needs action', () => {
    expect(
      boardColumn(pr({ role: 'reviewer', myVote: 'approved', newChangesSinceMyReview: true }))
    ).toBe('action')
  })

  test('reviewer who voted and is caught up waits', () => {
    expect(boardColumn(pr({ role: 'reviewer', myVote: 'waiting' }))).toBe('waiting')
  })

  test('author with a rejected or waiting vote needs action', () => {
    expect(boardColumn(pr({ role: 'author', reviewers: [reviewer('rejected')] }))).toBe('action')
    expect(boardColumn(pr({ role: 'author', reviewers: [reviewer('waiting')] }))).toBe('action')
  })

  test('author with unresolved threads needs action', () => {
    expect(boardColumn(pr({ role: 'author', activeThreadCount: 2 }))).toBe('action')
  })

  test('author waiting on reviews waits', () => {
    expect(boardColumn(pr({ role: 'author', reviewers: [reviewer('noVote')] }))).toBe('waiting')
    expect(boardColumn(pr({ role: 'author', reviewers: [] }))).toBe('waiting')
  })

  test('every reviewer approved -> approved (author view)', () => {
    expect(
      boardColumn(
        pr({
          role: 'author',
          reviewers: [reviewer('approved'), reviewer('approvedWithSuggestions', 'S')]
        })
      )
    ).toBe('approved')
  })

  test('every reviewer approved -> approved (reviewer view, my vote in)', () => {
    expect(
      boardColumn(pr({ role: 'reviewer', myVote: 'approved', reviewers: [reviewer('approved')] }))
    ).toBe('approved')
  })

  test('author with unresolved threads stays action even when all approved', () => {
    expect(
      boardColumn(pr({ role: 'author', activeThreadCount: 1, reviewers: [reviewer('approved')] }))
    ).toBe('action')
  })
})

describe('boardReason', () => {
  test('explains the action column', () => {
    expect(boardReason(pr({ role: 'reviewer', myVote: null }))).toBe('no vote yet')
    expect(
      boardReason(pr({ role: 'reviewer', myVote: 'approved', newChangesSinceMyReview: true }))
    ).toBe('new changes since your review')
    expect(boardReason(pr({ role: 'author', reviewers: [reviewer('rejected')] }))).toBe(
      'review response needed'
    )
    expect(boardReason(pr({ role: 'author', activeThreadCount: 2 }))).toBe('2 unresolved comments')
    expect(boardReason(pr({ role: 'author', activeThreadCount: 1 }))).toBe('1 unresolved comment')
  })

  test('explains waiting, silent on approved', () => {
    expect(boardReason(pr({ role: 'author', reviewers: [reviewer('noVote', 'Marek Kral')] }))).toBe(
      'waiting for Marek Kral'
    )
    expect(boardReason(pr({ role: 'reviewer', myVote: 'approved' }))).toBe('voted')
    expect(boardReason(pr({ role: 'author', reviewers: [reviewer('approved')] }))).toBeNull()
  })

  test('lists at most two pending reviewers and counts the rest', () => {
    expect(
      boardReason(
        pr({
          role: 'author',
          reviewers: [reviewer('noVote', 'A B'), reviewer('noVote', 'C D'), reviewer('noVote', 'E F')]
        })
      )
    ).toBe('waiting for A B, C D +1')
  })
})

describe('queueVerb', () => {
  test('my own pull request in the action column asks me to respond', () => {
    expect(queueVerb(pr({ role: 'author', reviewers: [reviewer('waiting')] }))).toEqual({
      kind: 'respond',
      rank: 0
    })
    expect(queueVerb(pr({ role: 'author', activeThreadCount: 3 })).kind).toBe('respond')
  })

  test('a pull request I have not voted on asks for a review', () => {
    expect(queueVerb(pr({ role: 'reviewer', myVote: null }))).toEqual({ kind: 'review', rank: 1 })
    expect(queueVerb(pr({ role: 'reviewer', myVote: 'noVote' })).kind).toBe('review')
  })

  test('new pushes after my vote ask for a re-review', () => {
    expect(
      queueVerb(pr({ role: 'reviewer', myVote: 'approved', newChangesSinceMyReview: true }))
    ).toEqual({ kind: 'reReview', rank: 2 })
  })

  test('a first vote stays a review even when the author pushed since', () => {
    expect(
      queueVerb(pr({ role: 'reviewer', myVote: 'noVote', newChangesSinceMyReview: true })).kind
    ).toBe('review')
  })

  test('nothing owed by me is wait, and all approved is done', () => {
    expect(queueVerb(pr({ role: 'reviewer', myVote: 'waiting' }))).toEqual({
      kind: 'wait',
      rank: 3
    })
    expect(queueVerb(pr({ role: 'author', reviewers: [reviewer('noVote')] })).kind).toBe('wait')
    expect(
      queueVerb(pr({ role: 'reviewer', myVote: 'approved', reviewers: [reviewer('approved')] }))
    ).toEqual({ kind: 'done', rank: 4 })
  })
})

describe('voteRollup', () => {
  test('one rejection decides the row', () => {
    expect(voteRollup(pr({ reviewers: [reviewer('approved'), reviewer('rejected', 'X')] }))).toEqual(
      { kind: 'rejected' }
    )
  })

  test('a waiting vote outranks the approvals beside it', () => {
    expect(voteRollup(pr({ reviewers: [reviewer('approved'), reviewer('waiting', 'X')] }))).toEqual({
      kind: 'waitingForAuthor'
    })
  })

  test('rejection outranks waiting', () => {
    expect(voteRollup(pr({ reviewers: [reviewer('waiting'), reviewer('rejected', 'X')] }))).toEqual({
      kind: 'rejected'
    })
  })

  test('every reviewer approving is approved, suggestions included', () => {
    expect(
      voteRollup(pr({ reviewers: [reviewer('approved'), reviewer('approvedWithSuggestions', 'S')] }))
    ).toEqual({ kind: 'approved' })
  })

  test('some approvals are counted', () => {
    expect(
      voteRollup(pr({ reviewers: [reviewer('approved'), reviewer('noVote', 'X')] }))
    ).toEqual({ kind: 'partial', approved: 1, total: 2 })
  })

  test('no approvals is none, and so is a pull request nobody reviews', () => {
    expect(voteRollup(pr({ reviewers: [reviewer('noVote')] }))).toEqual({ kind: 'none' })
    expect(voteRollup(pr({ reviewers: [] }))).toEqual({ kind: 'none' })
  })
})

describe('compareQueue', () => {
  const respond = pr({ prId: 1, role: 'author', activeThreadCount: 1, lastActivityAt: 500 })
  const review = pr({ prId: 2, role: 'reviewer', myVote: null, lastActivityAt: 500 })
  const done = pr({
    prId: 3,
    role: 'reviewer',
    myVote: 'approved',
    reviewers: [reviewer('approved')],
    lastActivityAt: 500
  })

  test('orders by what wants me first', () => {
    expect([done, review, respond].sort(compareQueue).map((p) => p.prId)).toEqual([1, 2, 3])
  })

  test('work I owe leads with the row that has waited longest', () => {
    const older = { ...review, prId: 10, lastActivityAt: 100 }
    const newer = { ...review, prId: 11, lastActivityAt: 900 }
    expect([newer, older].sort(compareQueue).map((p) => p.prId)).toEqual([10, 11])
  })

  test('rows that ask nothing lead with what moved most recently', () => {
    const older = { ...done, prId: 20, lastActivityAt: 100 }
    const newer = { ...done, prId: 21, lastActivityAt: 900 }
    expect([older, newer].sort(compareQueue).map((p) => p.prId)).toEqual([21, 20])
  })
})

describe('isThreadUnresolved', () => {
  test('active and pending are unresolved; fixed, closed, wontFix are not', () => {
    const t = (status: string): PrThread => ({
      threadId: 1,
      filePath: null,
      line: null,
      status,
      isSystem: false,
      comments: []
    })
    expect(isThreadUnresolved(t('active'))).toBe(true)
    expect(isThreadUnresolved(t('pending'))).toBe(true)
    expect(isThreadUnresolved(t('fixed'))).toBe(false)
    expect(isThreadUnresolved(t('closed'))).toBe(false)
    expect(isThreadUnresolved(t('wontFix'))).toBe(false)
  })
})
