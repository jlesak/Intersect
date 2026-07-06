import { useShallow } from 'zustand/react/shallow'
import type { PrThread } from '@common/domain'
import { selectDrafts, selectSelectedPr, usePrInboxStore } from '../store'
import { DiffViewer } from './DiffViewer'
import { DraftCard } from './DraftCard'
import { ReviewTerminal } from './ReviewTerminal'

const shortRef = (ref: string): string => ref.replace(/^refs\/heads\//, '')

function ThreadRow({ thread }: { thread: PrThread }) {
  const first = thread.comments[0]
  return (
    <div className="jv-pr-thread">
      <span className="jv-faint">
        {thread.filePath ? `${thread.filePath}${thread.line ? `:${thread.line}` : ''}` : 'PR-level'} ·{' '}
        {thread.status}
      </span>
      {first && (
        <p className="jv-pr-thread__body">
          <strong>{first.authorName}: </strong>
          {first.body}
        </p>
      )}
    </div>
  )
}

/** Master-detail for the selected PR: changed files, its diff, existing threads, and draft review. */
export function PrInboxView() {
  const pr = usePrInboxStore(selectSelectedPr)
  const changes = usePrInboxStore(useShallow((s) => s.changes))
  const activeFilePath = usePrInboxStore((s) => s.activeFilePath)
  const fileDiff = usePrInboxStore((s) => s.fileDiff)
  const diffLoading = usePrInboxStore((s) => s.diffLoading)
  const threads = usePrInboxStore(useShallow((s) => s.threads))
  const drafts = usePrInboxStore(useShallow(selectDrafts))
  const reviewStatus = usePrInboxStore((s) => s.review.status)

  if (!pr) {
    return (
      <div className="jv-main">
        <div className="jv-empty">
          <span className="jv-eyebrow">No pull request</span>
          <div className="jv-empty__title">Nothing selected</div>
          <p className="jv-empty__hint">Pick a pull request from the sidebar to review its changes.</p>
        </div>
      </div>
    )
  }

  const running = reviewStatus === 'running'

  return (
    <div className="jv-main">
      <div className="jv-pr-header">
        <div className="jv-pr-header__title">{pr.title}</div>
        <div className="jv-pr-header__refs">
          <span className="jv-faint">{pr.authorName}</span>
          <span className="jv-pr-ref">{shortRef(pr.sourceRefName)}</span>
          <span className="jv-faint">→</span>
          <span className="jv-pr-ref">{shortRef(pr.targetRefName)}</span>
          <span className="jv-faint">{pr.url}</span>
        </div>
        <div className="jv-row" style={{ gap: 8, marginLeft: 'auto' }}>
          <button
            type="button"
            className="jv-btn jv-btn--primary"
            disabled={running}
            onClick={() => void usePrInboxStore.getState().startReview()}
          >
            Review with Claude Code
          </button>
          {running && (
            <button
              type="button"
              className="jv-btn jv-btn--danger"
              onClick={() => void usePrInboxStore.getState().endReview()}
            >
              End review
            </button>
          )}
        </div>
      </div>

      <div className="jv-pr-detail">
        <div className="jv-pr-files">
          <span className="jv-eyebrow">Changed files</span>
          {changes.length === 0 && <span className="jv-faint">No changes.</span>}
          {changes.map((c) => (
            <button
              key={c.path}
              type="button"
              className={`jv-pr-file${c.path === activeFilePath ? ' jv-pr-file--active' : ''}`}
              onClick={() => void usePrInboxStore.getState().openFile(c.path)}
              title={c.path}
            >
              <span className={`jv-pr-file__type jv-pr-file__type--${c.changeType}`}>
                {c.changeType[0].toUpperCase()}
              </span>
              <span className="jv-pr-file__path">{c.path}</span>
            </button>
          ))}
        </div>

        <div className="jv-pr-content">
          {running ? (
            <ReviewTerminal />
          ) : (
            <>
              <div className="jv-pr-diff-wrap">
                <DiffViewer
                  diff={fileDiff}
                  loading={diffLoading}
                  drafts={drafts}
                  onAddDraft={(line, body) =>
                    void usePrInboxStore.getState().addManualDraft({
                      prId: pr.prId,
                      repositoryId: pr.repositoryId,
                      filePath: activeFilePath ?? '',
                      line,
                      side: 'right',
                      body
                    })
                  }
                />
              </div>

              {threads.length > 0 && (
                <div className="jv-pr-threads">
                  <span className="jv-eyebrow">Existing threads</span>
                  {threads.map((t) => (
                    <ThreadRow key={t.threadId} thread={t} />
                  ))}
                </div>
              )}

              <div className="jv-pr-drafts">
                <span className="jv-eyebrow">Draft comments</span>
                {drafts.length === 0 ? (
                  <span className="jv-faint">
                    No drafts yet. Comment on a line or run a Claude review.
                  </span>
                ) : (
                  drafts.map((d) => <DraftCard key={d.id} draft={d} />)
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
