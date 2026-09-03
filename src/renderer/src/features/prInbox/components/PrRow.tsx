import type { PrReviewer, PrVote, PullRequest } from '@common/domain'
import { type QueueVerbKind, queueVerb, voteRollup } from '@common/prBoard'
import { avatarColor, initials } from '@renderer/shared/ui/avatar'
import { IconComment } from '@renderer/shared/ui/icons'
import { relativeAge } from '../relativeAge'
import { prKey, usePrInboxStore } from '../store'

/**
 * The verb column's wording. The label is what the pill says; the hint is the sentence behind it,
 * because a one-word instruction is only obvious once you already know the rules.
 */
const VERBS: Record<QueueVerbKind, { label: string; hint: string; mod: string }> = {
  respond: {
    label: 'Respond',
    hint: 'Your pull request waits for you: a reviewer voted against it, or comments are open.',
    mod: 'respond'
  },
  review: { label: 'Review', hint: 'You have not voted on this pull request yet.', mod: 'review' },
  reReview: {
    label: 'Re-review',
    hint: 'The author pushed new changes after your vote.',
    mod: 'rereview'
  },
  wait: { label: 'Wait', hint: 'Nothing is yours to do. It waits for other people.', mod: 'wait' },
  done: { label: 'Done', hint: 'Every reviewer approved it.', mod: 'done' }
}

/** How each vote is worded in a tooltip, in the first person the board speaks in elsewhere. */
const VOTE_WORDING: Record<PrVote, string> = {
  approved: 'approved',
  approvedWithSuggestions: 'approved with suggestions',
  waiting: 'waiting for the author',
  rejected: 'rejected',
  noVote: 'has not voted'
}

/** The glyph on a reviewer's badge. A missing vote carries none: the hollow dot is the statement. */
const VOTE_GLYPH: Record<PrVote, string> = {
  approved: '✓',
  approvedWithSuggestions: '✓',
  waiting: '!',
  rejected: '✕',
  noVote: ''
}

function Avatar({ name, ring }: { name: string; ring?: boolean }) {
  return (
    <span
      className={`ix-avatar${ring ? ' ix-avatar--ring' : ''}`}
      style={{ background: avatarColor(name) }}
      aria-hidden
    >
      {initials(name)}
    </span>
  )
}

/** One reviewer: who they are, and how they voted, as a glyph on the corner of their avatar. */
function VoteBadge({ reviewer }: { reviewer: PrReviewer }) {
  return (
    <span
      className="ix-vote-badge"
      data-testid="pr-row-reviewer"
      title={`${reviewer.displayName}${reviewer.isRequired ? ' (required)' : ''} · ${VOTE_WORDING[reviewer.vote]}`}
    >
      <Avatar name={reviewer.displayName} />
      <i className={`ix-vote-badge__dot ix-vote-badge__dot--${reviewer.vote}`} aria-hidden>
        {VOTE_GLYPH[reviewer.vote]}
      </i>
    </span>
  )
}

/** The reviewer votes as one sentence, so a row can be read without counting badges. */
function VoteStatus({ pr }: { pr: PullRequest }) {
  const rollup = voteRollup(pr)
  const { label, mod } =
    rollup.kind === 'rejected'
      ? { label: 'Rejected', mod: 'rejected' }
      : rollup.kind === 'waitingForAuthor'
        ? { label: 'Waiting for author', mod: 'waiting' }
        : rollup.kind === 'approved'
          ? { label: 'Approved', mod: 'approved' }
          : rollup.kind === 'partial'
            ? { label: `${rollup.approved} of ${rollup.total} approved`, mod: 'partial' }
            : { label: 'No votes yet', mod: 'none' }
  return (
    <span className={`ix-votestat ix-votestat--${mod}`} data-testid="pr-row-vote-status">
      {label}
    </span>
  )
}

/**
 * One pull request as a table row: what it asks of me, which pull request it is, where its votes
 * have got to, and when it last moved.
 *
 * Dated by its last activity rather than by when it was opened, because a review queue is read by
 * what moved most recently. The clock comes from the board, so every row ages together and keeps
 * ageing while the board stays open.
 */
export function PrRow({ pr, now }: { pr: PullRequest; now: number }) {
  const verb = VERBS[queueVerb(pr).kind]
  const mine = pr.role === 'author'
  const key = prKey(pr.repositoryId, pr.prId)
  const reviewing = usePrInboxStore((s) => s.liveReviews[key] !== undefined)
  const remainingDrafts = usePrInboxStore((s) => s.unfinishedReviews[key] ?? 0)
  const open = (): void => void usePrInboxStore.getState().openDetail(pr.repositoryId, pr.prId)
  const signals =
    reviewing || remainingDrafts > 0 || pr.newChangesSinceMyReview || pr.activeThreadCount > 0
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="pr-row"
      className={`ix-prtable__row${mine ? ' ix-prtable__row--mine' : ''}`}
      // The row's own name, so a screen reader announces the pull request rather than reading out
      // the six cells in it as loose text.
      aria-label={`${verb.label}: ${pr.title}, ${pr.repositoryName} pull request ${pr.prId}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open()
        }
      }}
    >
      <span className="ix-prtable__cell">
        <span
          className={`ix-verb ix-verb--${verb.mod}`}
          title={verb.hint}
          data-testid="pr-row-verb"
        >
          {verb.label}
        </span>
      </span>
      <span className="ix-prtable__pr">
        <Avatar name={pr.authorName} ring={mine} />
        <span className="ix-prtable__main">
          <span className="ix-prtable__title" title={pr.title}>
            {pr.title}
          </span>
          <span className="ix-prtable__meta">
            {pr.authorName} · {pr.repositoryName} · !{pr.prId}
            {mine && (
              <>
                {' · '}
                <span className="ix-prtable__mine">mine</span>
              </>
            )}
          </span>
          {signals && (
            <span className="ix-prtable__chips">
              {remainingDrafts > 0 && (
                <span
                  className="ix-chip ix-chip--review"
                  data-testid="pr-row-unfinished-review"
                  title={`${remainingDrafts} drafted review comment${remainingDrafts === 1 ? '' : 's'} wait for you to publish or discard`}
                >
                  {remainingDrafts} {remainingDrafts === 1 ? 'draft' : 'drafts'}
                </span>
              )}
              {reviewing && (
                <span className="ix-chip ix-chip--review" data-testid="pr-row-reviewing">
                  ● reviewing
                </span>
              )}
              {pr.newChangesSinceMyReview && (
                <span className="ix-chip ix-chip--accent" data-testid="pr-row-new-changes">
                  ● new changes
                </span>
              )}
              {pr.activeThreadCount > 0 && (
                <span className="ix-chip" data-testid="pr-row-unresolved-chip">
                  {pr.activeThreadCount} unresolved
                </span>
              )}
            </span>
          )}
        </span>
      </span>
      <span className="ix-prtable__cell">
        <VoteStatus pr={pr} />
      </span>
      <span className="ix-prtable__votes">
        {pr.reviewers.map((r) => (
          <VoteBadge key={r.id} reviewer={r} />
        ))}
      </span>
      <span
        className={`ix-unres${pr.activeThreadCount === 0 ? ' ix-unres--zero' : ''}`}
        data-testid="pr-row-unresolved"
        title={
          pr.activeThreadCount === 0
            ? 'No unresolved comment threads'
            : `${pr.activeThreadCount} unresolved comment thread${pr.activeThreadCount === 1 ? '' : 's'}`
        }
      >
        <IconComment width={12} height={12} aria-hidden />
        {pr.activeThreadCount === 0 ? '–' : pr.activeThreadCount}
      </span>
      <span className="ix-prtable__age">{relativeAge(pr.lastActivityAt, now)}</span>
    </div>
  )
}
