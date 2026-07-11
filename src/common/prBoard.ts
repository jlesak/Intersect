import type { PrThread, PullRequest } from './domain'

/**
 * Which board column a PR belongs to. The board reads left to right as a pipeline:
 * do (action) -> wait (waiting) -> done (approved).
 */
export type BoardColumn = 'action' | 'waiting' | 'approved'

const APPROVING = new Set(['approved', 'approvedWithSuggestions'])

/** A thread that still asks for a reaction (ADO statuses `active` and `pending`). */
export function isThreadUnresolved(thread: PrThread): boolean {
  return thread.status === 'active' || thread.status === 'pending'
}

/**
 * Classify a PR by what it needs from me. As reviewer I owe a vote (or a re-review after new
 * pushes); as author I owe a reaction to negative votes or unresolved comments. A PR whose
 * reviewers all approved is done.
 */
export function boardColumn(pr: PullRequest): BoardColumn {
  if (pr.role === 'reviewer') {
    if (!pr.myVote || pr.myVote === 'noVote') return 'action'
    if (pr.newChangesSinceMyReview) return 'action'
  } else {
    if (pr.reviewers.some((r) => r.vote === 'rejected' || r.vote === 'waiting')) return 'action'
    if (pr.activeThreadCount > 0) return 'action'
  }
  if (pr.reviewers.length > 0 && pr.reviewers.every((r) => APPROVING.has(r.vote))) {
    return 'approved'
  }
  return 'waiting'
}

/** The chip on a board card explaining why the PR sits in its column; null when self-evident. */
export function boardReason(pr: PullRequest): string | null {
  const column = boardColumn(pr)
  if (column === 'action') {
    if (pr.role === 'reviewer') {
      if (!pr.myVote || pr.myVote === 'noVote') return 'no vote yet'
      return 'new changes since your review'
    }
    if (pr.reviewers.some((r) => r.vote === 'rejected' || r.vote === 'waiting')) {
      return 'review response needed'
    }
    return `${pr.activeThreadCount} unresolved comment${pr.activeThreadCount === 1 ? '' : 's'}`
  }
  if (column === 'waiting') {
    if (pr.role === 'reviewer') return 'voted'
    const pending = pr.reviewers.filter((r) => !APPROVING.has(r.vote)).map((r) => r.displayName)
    if (pending.length === 0) return null
    const shown = pending.slice(0, 2).join(', ')
    return `waiting for ${shown}${pending.length > 2 ? ` +${pending.length - 2}` : ''}`
  }
  return null
}
