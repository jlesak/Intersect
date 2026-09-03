import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { PullRequest } from '@common/domain'
import { boardColumn, compareQueue } from '@common/prBoard'
import { formatRelativeTime } from '@renderer/features/myWork'
import { MultiSelectFilter } from '@renderer/shared/ui/MultiSelectFilter'
import { useNow } from '@renderer/shared/ui/useNow'
import { NO_PR_FILTER, type PrBoardFilter, filterPrs, prFilterOptions } from '../boardFilter'
import { selectPrList, usePrInboxStore } from '../store'
import { PrRow } from './PrRow'

/**
 * The three questions the table is asked, as tabs.
 *
 * "To review" is other people's work waiting on my vote, which is the only pile that grows while I
 * ignore it. "Mine" is everything I authored, whatever state it is in - a place I can go to rather
 * than a marker I have to spot. "All active" is the fallback for anything the first two exclude,
 * such as a pull request I already voted on.
 */
const TABS = [
  {
    key: 'review',
    label: 'To review',
    holds: (pr: PullRequest) => pr.role === 'reviewer' && boardColumn(pr) === 'action'
  },
  { key: 'mine', label: 'Mine', holds: (pr: PullRequest) => pr.role === 'author' },
  { key: 'all', label: 'All active', holds: () => true }
] as const

type TabKey = (typeof TABS)[number]['key']

/** The one panel the three tabs switch, named so each tab can point at it. */
const PANEL_ID = 'pr-board-panel'

/** The table's column headings, in order. */
const HEADINGS = [
  'My action',
  'Pull request',
  'Vote status',
  'Reviewers',
  'Unresolved',
  'Updated'
] as const

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

/** The PR Review landing view: every synced PR as a row in one dense status table. */
export function PrBoard() {
  const prs = usePrInboxStore(useShallow(selectPrList))
  // Both of these are questions about the board in front of you rather than properties of the
  // synced data, and both should be gone by the time you come back to it.
  const [tab, setTab] = useState<TabKey>('review')
  const [filter, setFilter] = useState<PrBoardFilter>(NO_PR_FILTER)
  // The tab decides which pull requests exist for this reading of the board, and the filter narrows
  // within it. The counts on the tabs themselves ignore the filter: they say how much work each
  // pile holds, and a count that moved as you typed could not be used to choose a pile.
  const inTab = useMemo(() => {
    const holds = TABS.find((t) => t.key === tab)!.holds
    return prs.filter(holds)
  }, [prs, tab])
  // Offered from the tab rather than from the whole board, so the chip never offers a repository
  // that could only ever empty the table.
  const options = useMemo(() => prFilterOptions(inTab), [inTab])
  const shown = useMemo(() => filterPrs(inTab, filter).sort(compareQueue), [inTab, filter])
  const counts = useMemo(
    () => Object.fromEntries(TABS.map((t) => [t.key, prs.filter(t.holds).length])),
    [prs]
  )
  const syncing = usePrInboxStore((s) => s.syncing)
  const syncedAt = usePrInboxStore((s) => s.syncedAt)
  const syncError = usePrInboxStore((s) => s.syncError)
  const unfinishedStatus = usePrInboxStore((s) => s.unfinishedReviewsStatus)
  const unfinishedError = usePrInboxStore((s) => s.unfinishedReviewsError)
  // Freshness and every row's age are only true at the moment they are rendered, so the board
  // keeps its own clock rather than freezing at whatever the time was when it mounted.
  const now = useNow(60_000)
  // "Nothing to review" is a statement about the synced board, so it survives a tab or a filter
  // that happens to match nothing - those cases have their own, quite different, things to say.
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
      {unfinishedStatus === 'loading' && (
        <div className="ix-mw-loading ix-board-stale" data-testid="pr-draft-reviews-loading">
          Loading unfinished reviews…
        </div>
      )}
      {unfinishedStatus === 'error' && (
        <div className="ix-mw-loading ix-mw-stale ix-board-stale" data-testid="pr-draft-reviews-error">
          Could not load unfinished reviews: {unfinishedError}
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
              aria-label="Filter pull requests"
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
            {shown.length !== inTab.length && (
              <span className="ix-boardfilter__count" data-testid="pr-filter-count">
                {shown.length} of {inTab.length}
              </span>
            )}
          </div>
          <div className="ix-prtabs" role="tablist" aria-label="Pull request lists">
            {TABS.map((t) => (
              <button
                key={t.key}
                id={`pr-tab-${t.key}`}
                type="button"
                role="tab"
                className="ix-prtabs__tab"
                aria-selected={tab === t.key}
                aria-controls={PANEL_ID}
                data-testid={`pr-tab-${t.key}`}
                onClick={() => setTab(t.key)}
              >
                {t.label}
                <span className="ix-prtabs__count">{counts[t.key]}</span>
              </button>
            ))}
          </div>
          <div
            id={PANEL_ID}
            role="tabpanel"
            aria-labelledby={`pr-tab-${tab}`}
            className="ix-prpanel"
          >
            {/* A table of headings over nothing looks like a board that failed to load rather than
                one that found nothing, so the reason is stated in the table's place. */}
            {shown.length === 0 ? (
              <div className="ix-boardfilter__none">
                {inTab.length === 0
                  ? 'Nothing in this list right now.'
                  : 'No pull requests match this filter.'}
              </div>
            ) : (
              <div className="ix-prtable" data-testid="pr-table">
                <div className="ix-prtable__grid">
                  <div className="ix-prtable__head">
                    {HEADINGS.map((heading) => (
                      <span key={heading} className="ix-eyebrow">
                        {heading}
                      </span>
                    ))}
                  </div>
                  {shown.map((pr) => (
                    <PrRow key={`${pr.repositoryId}:${pr.prId}`} pr={pr} now={now} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
