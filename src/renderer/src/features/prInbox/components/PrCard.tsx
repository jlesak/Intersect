import type { PrReviewer, PullRequest } from '@common/domain'
import { boardReason } from '@common/prBoard'
import { prKey, usePrInboxStore } from '../store'

/** Compact relative age (e.g. "3d", "2h", "just now") from an epoch-ms timestamp. */
function relativeAge(createdAt: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - createdAt) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('') || '?'

function VoteChip({ reviewer }: { reviewer: PrReviewer }) {
  return (
    <span className={`ix-pr-vote ix-pr-vote--${reviewer.vote}`} title={reviewer.displayName}>
      {initials(reviewer.displayName)}
    </span>
  )
}

/** One PR on the board: title, origin, why it sits in its column, and the reviewers' votes. */
export function PrCard({ pr, urgent }: { pr: PullRequest; urgent: boolean }) {
  const reason = boardReason(pr)
  const reviewing = usePrInboxStore((s) => s.reviewPrKey === prKey(pr.repositoryId, pr.prId))
  const open = (): void => void usePrInboxStore.getState().openDetail(pr.repositoryId, pr.prId)
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="pr-card"
      className={`ix-board-card${urgent ? ' ix-board-card--urgent' : ''}`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open()
        }
      }}
    >
      <div className="ix-board-card__title">{pr.title}</div>
      <div className="ix-board-card__meta">
        {pr.authorName} · {pr.repositoryName} · {relativeAge(pr.createdAt)}
      </div>
      <div className="ix-board-card__row">
        <span className="ix-chip">{pr.role === 'author' ? 'Author' : 'Reviewer'}</span>
        {reviewing && (
          <span className="ix-chip ix-chip--review" data-testid="pr-card-reviewing">
            ● reviewing
          </span>
        )}
        {reason && <span className={`ix-chip${urgent ? ' ix-chip--accent' : ''}`}>{reason}</span>}
        {pr.reviewers.length > 0 && (
          <span className="ix-board-card__votes">
            {pr.reviewers.map((r) => (
              <VoteChip key={r.id} reviewer={r} />
            ))}
          </span>
        )}
      </div>
    </div>
  )
}
