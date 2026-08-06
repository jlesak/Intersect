import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { PullRequest } from '@common/domain'
import { formatRelativeTime } from '@renderer/features/myWork'
import { useNow } from '@renderer/shared/ui/useNow'
import { groupBoardColumns, selectPrList, usePrInboxStore } from '../store'
import { PrCard } from './PrCard'

const COLUMNS: Array<{ key: 'action' | 'waiting' | 'approved'; label: string }> = [
  { key: 'action', label: 'Needs my action' },
  { key: 'waiting', label: 'Waiting on others' },
  { key: 'approved', label: 'Approved' }
]

/**
 * How stale the board has to be before its freshness stops being a quiet fact and starts being a
 * warning.
 *
 * Deliberately far longer than the interval that triggers an automatic refresh: while the window is
 * in use the board is refreshed on every return to it and this chip stays quiet. The tint therefore
 * appears exactly when something is actually wrong - the window has been ignored for a quarter of an
 * hour, or automatic refreshing is not happening at all because Azure DevOps is not connected or
 * every attempt is failing.
 */
const STALE_WARN_MS = 15 * 60 * 1000

/**
 * How current the board is. A board that has never synced says so rather than showing an age
 * computed from nothing, and stays untinted: on a machine with no Azure DevOps connection that is
 * the permanent, expected state, and a permanent warning is furniture nobody reads.
 */
function SyncChip({ syncedAt, now }: { syncedAt: number | null; now: number }) {
  const warn = syncedAt !== null && now - syncedAt >= STALE_WARN_MS
  return (
    <span
      className={`ix-chip ix-board-head__age${warn ? ' ix-chip--warn' : ''}`}
      data-testid="pr-sync-age"
    >
      {syncedAt === null ? 'never synced' : `Synced ${formatRelativeTime(syncedAt, now)}`}
    </span>
  )
}

/** The PR Review landing view: every synced PR as a card in one of three action columns. */
export function PrBoard() {
  const prs = usePrInboxStore(useShallow(selectPrList))
  const cols = useMemo(() => groupBoardColumns(prs), [prs])
  const syncing = usePrInboxStore((s) => s.syncing)
  const syncedAt = usePrInboxStore((s) => s.syncedAt)
  const syncError = usePrInboxStore((s) => s.syncError)
  // Freshness and every card's age are only true at the moment they are rendered, so the board
  // keeps its own clock rather than freezing at whatever the time was when it mounted.
  const now = useNow(60_000)
  const empty = COLUMNS.every((c) => cols[c.key].length === 0)

  return (
    <div className="ix-main">
      <div className="ix-board-head">
        <span className="ix-eyebrow">Pull requests</span>
        <SyncChip syncedAt={syncedAt} now={now} />
        <button
          type="button"
          className="ix-btn"
          disabled={syncing}
          data-testid="pr-sync"
          onClick={() => void usePrInboxStore.getState().sync()}
        >
          {syncing && <span className="ix-spinner" aria-hidden />}
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
      </div>
      {/* A refresh that failed still leaves a board worth acting on, so the failure is stated above
          the cached data and never in place of it. */}
      {syncError !== null && (
        <div className="ix-mw-loading ix-mw-stale ix-board-stale" data-testid="pr-sync-error">
          Could not refresh: {syncError}
        </div>
      )}
      {empty ? (
        <div className="ix-empty">
          <span className="ix-eyebrow">No pull requests</span>
          <div className="ix-empty__title">Nothing to review</div>
          <p className="ix-empty__hint">Sync to load your pull requests from Azure DevOps.</p>
        </div>
      ) : (
        <div className="ix-board" data-testid="pr-board">
          {COLUMNS.map((col) => (
            <div key={col.key} className="ix-board-col" data-testid={`pr-col-${col.key}`}>
              <div className="ix-board-col__head">
                <span className={`ix-eyebrow ix-board-col__label--${col.key}`}>{col.label}</span>
                <span className="ix-board-col__count">{cols[col.key].length}</span>
              </div>
              {cols[col.key].map((pr: PullRequest) => (
                <PrCard
                  key={`${pr.repositoryId}:${pr.prId}`}
                  pr={pr}
                  urgent={col.key === 'action'}
                  now={now}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
