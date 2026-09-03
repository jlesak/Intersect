import { lazy, Suspense, useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { PrChangeFile } from '@common/domain'
import { isThreadUnresolved } from '@common/prBoard'
import {
  isDraftStale,
  selectDrafts,
  selectPrWebUrl,
  selectSelectedPr,
  selectSelectedReviewSessionId,
  usePrInboxStore
} from '../store'
import { DraftCard } from './DraftCard'
import { escapeShouldGoBack } from './escapeNav'
import { FileTree } from './FileTree'
import { OverviewTab } from './OverviewTab'
import { PrVoteButtons } from './PrVoteButtons'
import { ReviewTerminal } from './ReviewTerminal'

// The diff viewer carries Monaco, by a wide margin the heaviest thing the renderer can load, and
// this is its only render site. Reaching it lazily keeps the editor in a chunk of its own, fetched
// when a reviewer first opens a diff. Everything else that imports this feature - the sidebar
// registration, the dashboard, My Work, the projects panes - only ever wanted the PR store, and
// now that is all they get.
const DiffViewer = lazy(() => import('./DiffViewer').then((m) => ({ default: m.DiffViewer })))

const shortRef = (ref: string): string => ref.replace(/^refs\/heads\//, '')
const canonicalPath = (path: string): string => `/${path.trim().replace(/^\/+/, '')}`

function DraftRecoveryList({
  title,
  drafts,
  sourceCommitId
}: {
  title: string
  drafts: ReturnType<typeof selectDrafts>
  sourceCommitId: string
}) {
  if (drafts.length === 0) return null
  return (
    <div className="ix-pr-drafts ix-pr-drafts--recovery" data-testid="pr-detached-drafts">
      <span className="ix-eyebrow">{title}</span>
      {drafts.map((draft) => (
        <DraftCard
          key={draft.id}
          draft={draft}
          stale={isDraftStale(draft, sourceCommitId)}
        />
      ))}
    </div>
  )
}

/** Why the outbound links are dead: the address of the Azure DevOps organisation is not known. */
const NO_WEB_LINK =
  'Set the Azure DevOps organisation URL in Settings to link out to this pull request.'

/**
 * How much there is to read, answered before the reviewer opens anything. Null while no changed
 * files are in hand: an empty list is also what "not fetched yet" looks like, and "0 files" would
 * be a claim about the pull request rather than about what is known of it.
 */
function changeSize(changes: PrChangeFile[]): { files: string; added: number; removed: number } | null {
  if (changes.length === 0) return null
  return {
    files: `${changes.length} ${changes.length === 1 ? 'file' : 'files'}`,
    added: changes.reduce((sum, c) => sum + c.added, 0),
    removed: changes.reduce((sum, c) => sum + c.removed, 0)
  }
}

/** The changed-files view: file tree and the active file's diff, including its inline draft comments. */
function ChangesView() {
  const changes = usePrInboxStore(useShallow((s) => s.changes))
  const changesError = usePrInboxStore((s) => s.changesError)
  const threads = usePrInboxStore(useShallow((s) => s.threads))
  const activeFilePath = usePrInboxStore((s) => s.activeFilePath)
  const fileDiff = usePrInboxStore((s) => s.fileDiff)
  const diffLoading = usePrInboxStore((s) => s.diffLoading)
  const pendingReveal = usePrInboxStore((s) => s.pendingReveal)
  const drafts = usePrInboxStore(useShallow(selectDrafts))
  const pr = usePrInboxStore(selectSelectedPr)

  if (!pr) return null

  if (changesError && changes.length === 0) {
    return (
      <div className="ix-pr-detail ix-pr-detail--empty">
        <div className="ix-empty">
          <p className="ix-empty__title">Diff unavailable</p>
          <p className="ix-faint">{changesError}</p>
          <DraftRecoveryList
            title="Drafts still available"
            drafts={drafts}
            sourceCommitId={pr.sourceCommitId}
          />
        </div>
      </div>
    )
  }

  const changedPaths = new Set(changes.map((change) => canonicalPath(change.path)))
  const detachedDrafts = drafts.filter((draft) => !changedPaths.has(canonicalPath(draft.filePath)))

  return (
    <div className="ix-pr-detail">
      <div className="ix-pr-files">
        <FileTree
          changes={changes}
          threads={threads}
          drafts={drafts}
          activeFilePath={activeFilePath}
          onOpen={(path) => void usePrInboxStore.getState().openFile(path)}
        />
      </div>
      <div className="ix-pr-content">
        <div className="ix-pr-diff-wrap">
          <Suspense fallback={<div className="ix-pr-diff__placeholder">Loading diff…</div>}>
            <DiffViewer
              diff={fileDiff}
              loading={diffLoading}
              drafts={drafts}
              threads={threads}
              pendingReveal={pendingReveal}
              onRevealDone={() => usePrInboxStore.getState().clearReveal()}
              currentSourceCommitId={pr.sourceCommitId}
            />
          </Suspense>
        </div>
        <DraftRecoveryList
          title="Drafts whose file is no longer in this diff"
          drafts={detachedDrafts}
          sourceCommitId={pr.sourceCommitId}
        />
      </div>
    </div>
  )
}

/**
 * ADO-like PR detail: breadcrumb header, vote actions, Overview/Files tabs. While a review runs the
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
  const draftsStatus = usePrInboxStore((s) => s.draftsStatus)
  const draftsError = usePrInboxStore((s) => s.draftsError)
  const remainingDraftCount = usePrInboxStore((s) =>
    s.selectedKey ? (s.unfinishedReviews[s.selectedKey] ?? 0) : 0
  )
  const reviewSessionId = usePrInboxStore(selectSelectedReviewSessionId)
  const reviewView = usePrInboxStore((s) =>
    reviewSessionId ? (s.reviewViews[reviewSessionId] ?? 'terminal') : 'terminal'
  )
  const webUrl = usePrInboxStore(selectPrWebUrl)
  const size = useMemo(() => changeSize(changes), [changes])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const state = usePrInboxStore.getState()
      const running = selectSelectedReviewSessionId(state) !== undefined
      if (escapeShouldGoBack(running, e.target)) state.goBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!pr) return null
  const running = reviewSessionId !== undefined
  const hasUnfinishedReview = remainingDraftCount > 0 || drafts.length > 0
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
        {size && (
          <div className="ix-pr-header__size" data-testid="pr-size">
            {`${size.files} · `}
            <span className="ix-lines-added">{`+${size.added}`}</span>{' '}
            <span className="ix-lines-removed">{`-${size.removed}`}</span>
          </div>
        )}
        <div className="ix-row" style={{ gap: 8, marginLeft: 'auto' }}>
          <button
            type="button"
            className="ix-btn ix-btn--ghost"
            data-testid="pr-open-external"
            disabled={!webUrl}
            title={webUrl ? undefined : NO_WEB_LINK}
            onClick={() => usePrInboxStore.getState().openInBrowser()}
          >
            Open in Azure DevOps
          </button>
          <button
            type="button"
            className="ix-btn ix-btn--ghost"
            data-testid="pr-copy-link"
            disabled={!webUrl}
            title={webUrl ? undefined : NO_WEB_LINK}
            onClick={() => void usePrInboxStore.getState().copyLink()}
          >
            Copy PR link
          </button>
          <PrVoteButtons pr={pr} />
          {!running ? (
            draftsStatus === 'loading' || draftsStatus === 'idle' ? (
              <button type="button" className="ix-btn ix-btn--primary" disabled data-testid="pr-drafts-loading-action">
                Loading drafts…
              </button>
            ) : draftsStatus === 'error' ? (
              <button
                type="button"
                className="ix-btn ix-btn--primary"
                data-testid="pr-drafts-retry-action"
                onClick={() => void usePrInboxStore.getState().loadDrafts()}
              >
                Retry drafts
              </button>
            ) : hasUnfinishedReview ? (
              <>
                <button
                  type="button"
                  className="ix-btn ix-btn--primary"
                  data-testid="pr-continue-review"
                  onClick={() => void usePrInboxStore.getState().continueReview()}
                >
                  Continue review · {remainingDraftCount || drafts.length}
                </button>
                <button
                  type="button"
                  className="ix-btn ix-btn--ghost"
                  data-testid="pr-run-additional-review"
                  title={`Adds drafts to the ${remainingDraftCount || drafts.length} already waiting.`}
                  onClick={() => void usePrInboxStore.getState().startReview()}
                >
                  Run another Claude review
                </button>
              </>
            ) : (
              <button
                type="button"
                className="ix-btn ix-btn--primary"
                onClick={() => void usePrInboxStore.getState().startReview()}
              >
                Review with Claude Code
              </button>
            )
          ) : (
            reviewView === 'terminal' && (
              <button
                type="button"
                className="ix-btn ix-btn--ghost"
                onClick={() => void usePrInboxStore.getState().endReview(reviewSessionId)}
              >
                End review
              </button>
            )
          )}
        </div>
      </div>

      {draftsStatus === 'loading' && (
        <div className="ix-mw-loading ix-board-stale" data-testid="pr-drafts-loading">
          Loading remaining draft comments…
        </div>
      )}
      {draftsStatus === 'error' && (
        <div className="ix-mw-loading ix-mw-stale ix-board-stale" data-testid="pr-drafts-error">
          Draft comments could not be loaded: {draftsError}
          <button type="button" className="ix-btn ix-btn--ghost" onClick={() => void usePrInboxStore.getState().loadDrafts()}>
            Retry
          </button>
        </div>
      )}

      {running ? (
        <>
          <div className="ix-ptabs">
            <button
              type="button"
              className={`ix-ptab${reviewView === 'terminal' ? ' ix-ptab--active' : ''}`}
              data-testid="review-tab-terminal"
              onClick={() => usePrInboxStore.getState().setReviewView(reviewSessionId, 'terminal')}
            >
              Terminal
            </button>
            <button
              type="button"
              className={`ix-ptab${reviewView === 'changes' ? ' ix-ptab--active' : ''}`}
              data-testid="review-tab-changes"
              onClick={() => usePrInboxStore.getState().setReviewView(reviewSessionId, 'changes')}
            >
              Changes
              {drafts.length > 0 && <span className="ix-board-col__count">{drafts.length}</span>}
            </button>
          </div>
          {reviewView === 'terminal' ? (
            // Keyed by the session, so moving between pull requests never reuses one session's
            // terminal for another's PTY.
            <ReviewTerminal key={reviewSessionId} sessionId={reviewSessionId} />
          ) : (
            <ChangesView />
          )}
        </>
      ) : (
        <>
          <div className="ix-ptabs">
            {(['overview', 'files'] as const).map((tab) => (
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
