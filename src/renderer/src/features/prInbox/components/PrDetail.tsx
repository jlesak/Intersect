import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { isThreadUnresolved } from '@common/prBoard'
import { prKey, selectDrafts, selectSelectedPr, usePrInboxStore } from '../store'
import { DiffViewer } from './DiffViewer'
import { DraftCard } from './DraftCard'
import { escapeShouldGoBack } from './escapeNav'
import { FileTree } from './FileTree'
import { OverviewTab } from './OverviewTab'
import { PrVoteButtons } from './PrVoteButtons'
import { ReviewTerminal } from './ReviewTerminal'

const shortRef = (ref: string): string => ref.replace(/^refs\/heads\//, '')

/** The changed-files view: file tree, the active file's diff, and this PR's draft comments. */
function ChangesView() {
  const changes = usePrInboxStore(useShallow((s) => s.changes))
  const changesError = usePrInboxStore((s) => s.changesError)
  const threads = usePrInboxStore(useShallow((s) => s.threads))
  const activeFilePath = usePrInboxStore((s) => s.activeFilePath)
  const fileDiff = usePrInboxStore((s) => s.fileDiff)
  const diffLoading = usePrInboxStore((s) => s.diffLoading)
  const pendingReveal = usePrInboxStore((s) => s.pendingReveal)
  const drafts = usePrInboxStore(useShallow(selectDrafts))

  if (changesError && changes.length === 0) {
    return (
      <div className="ix-pr-detail ix-pr-detail--empty">
        <div className="ix-empty">
          <p className="ix-empty__title">Diff unavailable</p>
          <p className="ix-faint">{changesError}</p>
        </div>
      </div>
    )
  }

  return (
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
  )
}

/**
 * ADO-like PR detail: breadcrumb header, vote actions, Files/Overview tabs. While a review runs the
 * tabs become a Terminal/Changes toggle - the session keeps running in the background so the user
 * can read the drafted comments and switch back to keep prompting. Esc goes back (except mid-review
 * or inside a keyboard-owning widget).
 */
export function PrDetail() {
  const pr = usePrInboxStore(selectSelectedPr)
  const activeTab = usePrInboxStore((s) => s.activeTab)
  const changes = usePrInboxStore(useShallow((s) => s.changes))
  const threads = usePrInboxStore(useShallow((s) => s.threads))
  const drafts = usePrInboxStore(useShallow(selectDrafts))
  const reviewStatus = usePrInboxStore((s) => s.review.status)
  const reviewPrKey = usePrInboxStore((s) => s.reviewPrKey)
  const reviewView = usePrInboxStore((s) => s.reviewView)

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
  const running = reviewStatus === 'running' && reviewPrKey === prKey(pr.repositoryId, pr.prId)
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
          {!running ? (
            <button
              type="button"
              className="ix-btn ix-btn--primary"
              onClick={() => void usePrInboxStore.getState().startReview()}
            >
              Review with Claude Code
            </button>
          ) : (
            reviewView === 'terminal' && (
              <button
                type="button"
                className="ix-btn ix-btn--ghost"
                onClick={() => void usePrInboxStore.getState().endReview()}
              >
                End review
              </button>
            )
          )}
        </div>
      </div>

      {running ? (
        <>
          <div className="ix-ptabs">
            <button
              type="button"
              className={`ix-ptab${reviewView === 'terminal' ? ' ix-ptab--active' : ''}`}
              data-testid="review-tab-terminal"
              onClick={() => usePrInboxStore.getState().setReviewView('terminal')}
            >
              Terminal
            </button>
            <button
              type="button"
              className={`ix-ptab${reviewView === 'changes' ? ' ix-ptab--active' : ''}`}
              data-testid="review-tab-changes"
              onClick={() => usePrInboxStore.getState().setReviewView('changes')}
            >
              Changes
              {drafts.length > 0 && <span className="ix-board-col__count">{drafts.length}</span>}
            </button>
          </div>
          {reviewView === 'terminal' ? <ReviewTerminal /> : <ChangesView />}
        </>
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

          {activeTab === 'files' ? <ChangesView /> : <OverviewTab />}
        </>
      )}
    </div>
  )
}
