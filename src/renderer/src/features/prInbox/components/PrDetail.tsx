import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { isThreadUnresolved } from '@common/prBoard'
import { selectDrafts, selectSelectedPr, usePrInboxStore } from '../store'
import { DiffViewer } from './DiffViewer'
import { DraftCard } from './DraftCard'
import { escapeShouldGoBack } from './escapeNav'
import { FileTree } from './FileTree'
import { OverviewTab } from './OverviewTab'
import { PrVoteButtons } from './PrVoteButtons'
import { ReviewTerminal } from './ReviewTerminal'

const shortRef = (ref: string): string => ref.replace(/^refs\/heads\//, '')

/** ADO-like PR detail: breadcrumb header, vote actions, Files/Overview tabs. Esc goes back. */
export function PrDetail() {
  const pr = usePrInboxStore(selectSelectedPr)
  const activeTab = usePrInboxStore((s) => s.activeTab)
  const changes = usePrInboxStore(useShallow((s) => s.changes))
  const threads = usePrInboxStore(useShallow((s) => s.threads))
  const activeFilePath = usePrInboxStore((s) => s.activeFilePath)
  const fileDiff = usePrInboxStore((s) => s.fileDiff)
  const diffLoading = usePrInboxStore((s) => s.diffLoading)
  const pendingReveal = usePrInboxStore((s) => s.pendingReveal)
  const drafts = usePrInboxStore(useShallow(selectDrafts))
  const reviewStatus = usePrInboxStore((s) => s.review.status)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const running = usePrInboxStore.getState().review.status === 'running'
      if (escapeShouldGoBack(running, e.target)) usePrInboxStore.getState().goBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!pr) return null
  const running = reviewStatus === 'running'
  const commentCount = threads.filter((t) => !t.isSystem && isThreadUnresolved(t)).length

  return (
    <div className="ix-main">
      <div className="ix-pr-header">
        <button
          type="button"
          className="ix-btn ix-btn--ghost"
          data-testid="pr-back"
          onClick={() => usePrInboxStore.getState().goBack()}
        >
          ← Pull requests
        </button>
        <div className="ix-pr-header__title">{pr.title}</div>
        <div className="ix-pr-header__refs">
          <span className="ix-faint">{pr.authorName}</span>
          <span className="ix-pr-ref">{shortRef(pr.sourceRefName)}</span>
          <span className="ix-faint">→</span>
          <span className="ix-pr-ref">{shortRef(pr.targetRefName)}</span>
        </div>
        <div className="ix-row" style={{ gap: 8, marginLeft: 'auto' }}>
          <PrVoteButtons pr={pr} />
          <button
            type="button"
            className="ix-btn ix-btn--primary"
            disabled={running}
            onClick={() => void usePrInboxStore.getState().startReview()}
          >
            Review with Claude Code
          </button>
          {running && (
            <button
              type="button"
              className="ix-btn ix-btn--danger"
              onClick={() => void usePrInboxStore.getState().endReview()}
            >
              End review
            </button>
          )}
        </div>
      </div>

      {running ? (
        <ReviewTerminal />
      ) : (
        <>
          <div className="ix-ptabs">
            {(['files', 'overview'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                className={`ix-ptab${activeTab === tab ? ' ix-ptab--active' : ''}`}
                data-testid={`pr-tab-${tab}`}
                onClick={() => usePrInboxStore.getState().setTab(tab)}
              >
                {tab === 'files' ? 'Files' : 'Overview'}
                <span className="ix-board-col__count">
                  {tab === 'files' ? changes.length : commentCount}
                </span>
              </button>
            ))}
          </div>

          {activeTab === 'files' ? (
            <div className="ix-pr-detail">
              <div className="ix-pr-files">
                <FileTree
                  changes={changes}
                  threads={threads}
                  activeFilePath={activeFilePath}
                  onOpen={(path) => void usePrInboxStore.getState().openFile(path)}
                />
              </div>
              <div className="ix-pr-content">
                <div className="ix-pr-diff-wrap">
                  <DiffViewer
                    diff={fileDiff}
                    loading={diffLoading}
                    drafts={drafts}
                    threads={threads}
                    pendingReveal={pendingReveal}
                    onRevealDone={() => usePrInboxStore.getState().clearReveal()}
                  />
                </div>
                <div className="ix-pr-drafts">
                  <span className="ix-eyebrow">Draft comments</span>
                  {drafts.length === 0 ? (
                    <span className="ix-faint">No drafts yet. Run a Claude review to get some.</span>
                  ) : (
                    drafts.map((d) => <DraftCard key={d.id} draft={d} />)
                  )}
                </div>
              </div>
            </div>
          ) : (
            <OverviewTab />
          )}
        </>
      )}
    </div>
  )
}
