import { describe, expect, test } from 'vitest'
import type { PrReviewer, PrThread, PullRequest } from './domain'
import { boardColumn, boardReason, isThreadUnresolved } from './prBoard'

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
