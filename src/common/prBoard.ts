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

/**
 * What a pull request asks of me next, named as the verb I would use for it.
 *
 * `respond` and `review` are both the action column, split by whose move it is: my own pull request
 * waits for my reaction, someone else's waits for my vote. `reReview` is the same vote asked a
 * second time after new pushes. `wait` and `done` ask nothing.
 */
export const QUEUE_VERBS = ['respond', 'review', 'reReview', 'wait', 'done'] as const
export type QueueVerbKind = (typeof QUEUE_VERBS)[number]

/** A verb plus its place in the queue: the lower the rank, the sooner it wants me. */
export interface QueueVerb {
  kind: QueueVerbKind
  rank: number
}

const VERB_RANK: Record<QueueVerbKind, number> = {
  respond: 0,
  review: 1,
  reReview: 2,
  wait: 3,
  done: 4
}

/**
 * The verb for one pull request, derived from the same column rules rather than from a second set,
 * so the table and the column classification cannot disagree about what needs me.
 *
 * A reviewer who has not voted at all is asked to `review` even when the author has pushed since:
 * a first vote is the same work either way, and calling it a re-review would claim I had already
 * looked.
 */
export function queueVerb(pr: PullRequest): QueueVerb {
  const kind = verbKind(pr)
  return { kind, rank: VERB_RANK[kind] }
}

function verbKind(pr: PullRequest): QueueVerbKind {
  const column = boardColumn(pr)
  if (column === 'approved') return 'done'
  if (column === 'waiting') return 'wait'
  if (pr.role === 'author') return 'respond'
  if (!pr.myVote || pr.myVote === 'noVote') return 'review'
  return 'reReview'
}

/**
 * Every reviewer's vote read as one state, the way Azure DevOps summarises a pull request.
 *
 * `partial` carries its counts because "2 of 4 approved" is the useful form; the other states are
 * complete on their own.
 */
export type VoteRollup =
  | { kind: 'rejected' }
  | { kind: 'waitingForAuthor' }
  | { kind: 'approved' }
  | { kind: 'partial'; approved: number; total: number }
  | { kind: 'none' }

/**
 * Roll the reviewer votes up into the one state worth showing in a table cell.
 *
 * Ordered by how much each vote blocks a merge: a single rejection decides the row whatever the
 * others said, then a waiting vote, and only an unblocked pull request is read for how far its
 * approvals have got. A pull request with no reviewers at all is `none`, never `approved` - nobody
 * has approved anything.
 */
export function voteRollup(pr: PullRequest): VoteRollup {
  if (pr.reviewers.some((r) => r.vote === 'rejected')) return { kind: 'rejected' }
  if (pr.reviewers.some((r) => r.vote === 'waiting')) return { kind: 'waitingForAuthor' }
  const approved = pr.reviewers.filter((r) => APPROVING.has(r.vote)).length
  const total = pr.reviewers.length
  if (total > 0 && approved === total) return { kind: 'approved' }
  if (approved > 0) return { kind: 'partial', approved, total }
  return { kind: 'none' }
}

/**
 * Queue order for the status table: what wants me first, and within that the row that has waited
 * longest.
 *
 * The two halves of the queue are read in opposite directions on purpose. Work I owe is a backlog,
 * so the oldest row is the most overdue and goes on top. Rows that ask nothing are a log, so the
 * newest is the interesting one - it is what just moved.
 */
export function compareQueue(a: PullRequest, b: PullRequest): number {
  const byVerb = queueVerb(a).rank - queueVerb(b).rank
  if (byVerb !== 0) return byVerb
  return queueVerb(a).rank <= VERB_RANK.reReview
    ? a.lastActivityAt - b.lastActivityAt
    : b.lastActivityAt - a.lastActivityAt
}

const NEW_CHANGES_REASON = 'new changes since your review'
const unresolvedReason = (count: number): string =>
  `${count} unresolved comment${count === 1 ? '' : 's'}`

/** The chip on a board card explaining why the PR sits in its column; null when self-evident. */
export function boardReason(pr: PullRequest): string | null {
  const column = boardColumn(pr)
  if (column === 'action') {
    if (pr.role === 'reviewer') {
      if (!pr.myVote || pr.myVote === 'noVote') return 'no vote yet'
      return NEW_CHANGES_REASON
    }
    if (pr.reviewers.some((r) => r.vote === 'rejected' || r.vote === 'waiting')) {
      return 'review response needed'
    }
    return unresolvedReason(pr.activeThreadCount)
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

/**
 * Which of a card's own signals the column reason is already announcing.
 *
 * A card carries a chip for new pushes and one for unresolved threads, and in the action column the
 * reason chip beside them can be saying exactly the same thing. Two adjacent chips for one fact read
 * as two separate signals, so the card drops whichever the reason has covered.
 *
 * Answered by comparing against what `boardReason` actually returned rather than by re-deciding from
 * the pull request, so the two cannot drift into disagreeing about what has already been said.
 */
export function reasonAlreadyStates(pr: PullRequest): {
  newChanges: boolean
  unresolved: boolean
} {
  const reason = boardReason(pr)
  return {
    newChanges: reason === NEW_CHANGES_REASON,
    unresolved: reason === unresolvedReason(pr.activeThreadCount)
  }
}
