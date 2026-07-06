import { Fragment, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { PullRequest } from '@common/domain'
import { selectPrList, usePrInboxStore } from '@renderer/features/prInbox'
import { approvalCount, groupPrs, initials, type PrGroups } from '../prGroups'
import { formatRelativeTime, useMyWorkStore } from '../store'

const GROUPS: Array<{ key: keyof PrGroups; label: string }> = [
  { key: 'myPrs', label: 'My PRs waiting to merge' },
  { key: 'waitingOnMe', label: 'Waiting on my review' },
  { key: 'updatedSinceReview', label: 'New changes since my review' }
]

/** The status pill: my PRs count their approvals; the review groups carry a fixed verdict. */
function statusPill(group: keyof PrGroups, pr: PullRequest): { label: string; variant: string } {
  if (group === 'myPrs') {
    const n = approvalCount(pr)
    return { label: `${n} approval${n === 1 ? '' : 's'}`, variant: 'progress' }
  }
  if (group === 'waitingOnMe') return { label: 'Waiting', variant: 'todo' }
  return { label: 'Updated', variant: 'review' }
}

/** One radar row. Clicking records the open intent; the app layer switches to the PR Inbox. */
function PrRow({ pr, group }: { pr: PullRequest; group: keyof PrGroups }) {
  const pill = statusPill(group, pr)
  return (
    <button
      type="button"
      className="ix-mw-row"
      title={pr.title}
      onClick={() => useMyWorkStore.getState().openPr(pr.repositoryId, pr.prId)}
    >
      <span className="ix-mw-avatar">{initials(pr.authorName)}</span>
      <span className="ix-mw-main">
        <span className="ix-mw-title">{pr.title}</span>
        <span className="ix-mw-sub">
          {pr.repositoryName} · #{pr.prId} · {pr.authorName}
        </span>
      </span>
      <span className={`ix-mw-status ix-mw-status--${pill.variant}`}>{pill.label}</span>
      <span />
      <span className="ix-mw-time">{formatRelativeTime(pr.createdAt)}</span>
    </button>
  )
}

/**
 * The My Work section's PR half: the cached PR Inbox list filtered into the three attention
 * subgroups. Empty subgroups are hidden entirely; only when nothing at all needs attention does a
 * neutral empty message show. Sync failures are the prInbox slice's to report (it toasts), so this
 * card only ever renders what is cached.
 */
export function PrRadar() {
  const prs = usePrInboxStore(useShallow(selectPrList))
  const status = usePrInboxStore((s) => s.status)
  const syncing = usePrInboxStore((s) => s.syncing)

  const groups = useMemo(() => groupPrs(prs), [prs])
  const total = GROUPS.reduce((n, g) => n + groups[g.key].length, 0)
  const loading = (status === 'idle' || status === 'loading' || syncing) && prs.length === 0

  return (
    <section className="ix-mw-section">
      <div className="ix-mw-section__head">
        <span className="ix-eyebrow">Pull requests</span>
        {total > 0 && <span className="ix-mw-section__count">{total}</span>}
        <div className="ix-mw-section__spacer" />
        <span className="ix-mw-section__meta">Azure DevOps</span>
      </div>
      {loading ? (
        <div className="ix-mw-pr-loading">
          <span className="ix-spinner" aria-hidden />
          Syncing pull requests from Azure DevOps…
        </div>
      ) : total === 0 ? (
        <div className="ix-mw-card">
          <div className="ix-mw-pr-empty">No pull requests need your attention.</div>
        </div>
      ) : (
        <div className="ix-mw-card">
          {GROUPS.map(({ key, label }) =>
            groups[key].length === 0 ? null : (
              <Fragment key={key}>
                <div className="ix-mw-subgroup__label">{label}</div>
                {groups[key].map((pr) => (
                  <PrRow key={`${pr.repositoryId}:${pr.prId}`} pr={pr} group={key} />
                ))}
              </Fragment>
            )
          )}
        </div>
      )}
    </section>
  )
}
