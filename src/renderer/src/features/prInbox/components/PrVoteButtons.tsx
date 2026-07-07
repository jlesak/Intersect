import { useState } from 'react'
import type { PrVote, PullRequest } from '@common/domain'
import { usePrInboxStore } from '../store'

/** The votes castable from Intersect (Reject and a No-vote reset are deliberately absent). */
const ACTIVE_CLASS: Partial<Record<PrVote, string>> = {
  approved: 'ix-pr-vote-btn--active-approved',
  approvedWithSuggestions: 'ix-pr-vote-btn--active-suggestions',
  waiting: 'ix-pr-vote-btn--active-waiting'
}

/**
 * The segmented reviewer vote control in the PR detail header. Shown only when my reviewer
 * identity is resolvable on the PR (I have a vote or a reviewer entry); a click sends the vote to
 * Azure DevOps immediately, no confirmation, and the active button mirrors my standing vote.
 */
export function PrVoteButtons({ pr }: { pr: PullRequest }) {
  const [voting, setVoting] = useState(false)
  if (pr.myVote === null && pr.myReviewerId === null) return null

  const cast = async (vote: PrVote): Promise<void> => {
    // Re-sending the standing vote would be a pointless round-trip; match the ADO web no-op.
    if (voting || pr.myVote === vote) return
    setVoting(true)
    try {
      await usePrInboxStore.getState().castVote(vote)
    } finally {
      setVoting(false)
    }
  }

  const cls = (vote: PrVote): string =>
    `ix-pr-vote-btn${pr.myVote === vote ? ` ${ACTIVE_CLASS[vote]}` : ''}`

  return (
    <div className={`ix-pr-vote-group${voting ? ' ix-pr-vote-group--voting' : ''}`}>
      <button
        type="button"
        className={cls('approved')}
        disabled={voting}
        onClick={() => void cast('approved')}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 8.5l3.5 3.5L13 4.5" />
        </svg>
        Approve
      </button>
      <button
        type="button"
        className={cls('approvedWithSuggestions')}
        disabled={voting}
        title="Approve with suggestions"
        onClick={() => void cast('approvedWithSuggestions')}
      >
        Approve+
      </button>
      <button
        type="button"
        className={cls('waiting')}
        disabled={voting}
        onClick={() => void cast('waiting')}
      >
        Wait for author
      </button>
    </div>
  )
}
