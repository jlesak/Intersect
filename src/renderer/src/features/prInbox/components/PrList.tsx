import { useShallow } from 'zustand/react/shallow'
import type { PrReviewer, PullRequest, PrVote } from '@common/domain'
import { prKey, selectPrList, usePrInboxStore } from '../store'

const VOTE_LABEL: Record<PrVote, string> = {
  approved: 'Approved',
  approvedWithSuggestions: 'Approved with suggestions',
  waiting: 'Waiting for author',
  rejected: 'Rejected',
  noVote: 'No vote'
}

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
  const months = Math.floor(days / 30)
  return `${months}mo ago`
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
    <span
      className={`jv-pr-vote jv-pr-vote--${reviewer.vote}`}
      title={`${reviewer.displayName} - ${VOTE_LABEL[reviewer.vote]}`}
    >
      {initials(reviewer.displayName)}
    </span>
  )
}

function PrRow({ pr, active }: { pr: PullRequest; active: boolean }) {
  const select = (): void => void usePrInboxStore.getState().select(pr.repositoryId, pr.prId)
  return (
    <div
      role="button"
      tabIndex={0}
      className={`jv-pr-row${active ? ' jv-pr-row--active' : ''}`}
      onMouseDown={select}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          select()
        }
      }}
    >
      <span className="jv-pr-row__title">{pr.title}</span>
      <span className="jv-pr-row__meta">
        {pr.authorName} · {relativeAge(pr.createdAt)}
      </span>
      {pr.reviewers.length > 0 && (
        <div className="jv-pr-votes">
          {pr.reviewers.map((r) => (
            <VoteChip key={r.id} reviewer={r} />
          ))}
        </div>
      )}
    </div>
  )
}

/** The sidebar body: a manual Sync control plus the PRs grouped by my role. */
export function PrList() {
  const prs = usePrInboxStore(useShallow(selectPrList))
  const syncing = usePrInboxStore((s) => s.syncing)
  const selectedKey = usePrInboxStore((s) => s.selectedKey)

  const authored = prs.filter((p) => p.role === 'author')
  const reviewing = prs.filter((p) => p.role === 'reviewer')

  const group = (label: string, items: PullRequest[]) =>
    items.length > 0 && (
      <div className="jv-pr-group">
        <span className="jv-eyebrow">{label}</span>
        {items.map((pr) => (
          <PrRow
            key={prKey(pr.repositoryId, pr.prId)}
            pr={pr}
            active={selectedKey === prKey(pr.repositoryId, pr.prId)}
          />
        ))}
      </div>
    )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="jv-sidebar__section">
        <button
          type="button"
          className="jv-btn"
          disabled={syncing}
          onClick={() => void usePrInboxStore.getState().sync()}
        >
          {syncing && <span className="jv-spinner" aria-hidden />}
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
      </div>

      <div className="jv-sidebar__list">
        {prs.length === 0 ? (
          <div style={{ padding: '2px 10px', color: 'var(--text-faint)' }}>
            Sync to load your pull requests.
          </div>
        ) : (
          <>
            {group('Authored', authored)}
            {group('Reviewing', reviewing)}
          </>
        )}
      </div>
    </div>
  )
}
