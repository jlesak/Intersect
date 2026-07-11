import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { PullRequest } from '@common/domain'
import { groupBoardColumns, selectPrList, usePrInboxStore } from '../store'
import { PrCard } from './PrCard'

const COLUMNS: Array<{ key: 'action' | 'waiting' | 'approved'; label: string }> = [
  { key: 'action', label: 'Needs my action' },
  { key: 'waiting', label: 'Waiting on others' },
  { key: 'approved', label: 'Approved' }
]

/** The PR Review landing view: every synced PR as a card in one of three action columns. */
export function PrBoard() {
  const prs = usePrInboxStore(useShallow(selectPrList))
  const cols = useMemo(() => groupBoardColumns(prs), [prs])
  const syncing = usePrInboxStore((s) => s.syncing)
  const empty = COLUMNS.every((c) => cols[c.key].length === 0)

  return (
    <div className="ix-main">
      <div className="ix-board-head">
        <span className="ix-eyebrow">Pull requests</span>
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
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
