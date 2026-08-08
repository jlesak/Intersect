import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { PullRequest } from '@common/domain'
import { formatRelativeTime } from '@renderer/features/myWork'
import { MultiSelectFilter } from '@renderer/shared/ui/MultiSelectFilter'
import { useNow } from '@renderer/shared/ui/useNow'
import { NO_PR_FILTER, type PrBoardFilter, filterPrs, prFilterOptions } from '../boardFilter'
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
  // Kept here rather than in the store: a narrowing is a question about the board in front of you,
  // not a property of the synced data, and it should be gone by the time you come back to it.
  const [filter, setFilter] = useState<PrBoardFilter>(NO_PR_FILTER)
  const options = useMemo(() => prFilterOptions(prs), [prs])
  const shown = useMemo(() => filterPrs(prs, filter), [prs, filter])
  const cols = useMemo(() => groupBoardColumns(shown), [shown])
  const syncing = usePrInboxStore((s) => s.syncing)
  const syncedAt = usePrInboxStore((s) => s.syncedAt)
  const syncError = usePrInboxStore((s) => s.syncError)
  // Freshness and every card's age are only true at the moment they are rendered, so the board
  // keeps its own clock rather than freezing at whatever the time was when it mounted.
  const now = useNow(60_000)
  // "Nothing to review" is a statement about the synced board, so it survives a filter that
  // happens to match nothing - that case has its own, quite different, thing to say.
  const empty = prs.length === 0

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
        <>
          <div className="ix-boardfilter ix-boardfilter--pr">
            <input
              className="ix-input ix-boardfilter__search"
              type="search"
              placeholder="Filter by title, number, repository or author…"
              data-testid="pr-filter"
              value={filter.query}
              onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
            />
            <MultiSelectFilter
              label="Repository"
              testId="pr-filter-repo"
              options={options.repos}
              selection={filter.repos}
              onChange={(repos) => setFilter((f) => ({ ...f, repos }))}
            />
            {shown.length !== prs.length && (
              <span className="ix-boardfilter__count" data-testid="pr-filter-count">
                {shown.length} of {prs.length}
              </span>
            )}
          </div>
          {/* All three columns collapse when nothing survives, and a row of unlabelled strips looks
              like a board that failed to load rather than one that found nothing. */}
          {shown.length === 0 && (
            <div className="ix-boardfilter__none">No pull requests match this filter.</div>
          )}
          <div className="ix-board" data-testid="pr-board">
            {COLUMNS.map((col) => (
              <div
                key={col.key}
                className={`ix-board-col${cols[col.key].length === 0 ? ' ix-board-col--collapsed' : ''}`}
                data-testid={`pr-col-${col.key}`}
              >
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
        </>
      )}
    </div>
  )
}
