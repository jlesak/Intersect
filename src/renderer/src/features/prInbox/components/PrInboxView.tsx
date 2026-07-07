import { useShallow } from 'zustand/react/shallow'
import type { PrThread } from '@common/domain'
import { selectDrafts, selectSelectedPr, usePrInboxStore } from '../store'
import { DiffViewer } from './DiffViewer'
import { DraftCard } from './DraftCard'
import { PrVoteButtons } from './PrVoteButtons'
import { ReviewTerminal } from './ReviewTerminal'

const shortRef = (ref: string): string => ref.replace(/^refs\/heads\//, '')

function ThreadRow({ thread }: { thread: PrThread }) {
  const first = thread.comments[0]
  return (
    <div className="ix-pr-thread">
      <span className="ix-faint">
        {thread.filePath ? `${thread.filePath}${thread.line ? `:${thread.line}` : ''}` : 'PR-level'} ·{' '}
        {thread.status}
      </span>
      {first && (
        <p className="ix-pr-thread__body">
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
      <div className="ix-main">
        <div className="ix-empty">
          <span className="ix-eyebrow">No pull request</span>
          <div className="ix-empty__title">Nothing selected</div>
          <p className="ix-empty__hint">Pick a pull request from the sidebar to review its changes.</p>
        </div>
      </div>
    )
  }

  const running = reviewStatus === 'running'

  return (
    <div className="ix-main">
      <div className="ix-pr-header">
        <div className="ix-pr-header__title">{pr.title}</div>
        <div className="ix-pr-header__refs">
          <span className="ix-faint">{pr.authorName}</span>
          <span className="ix-pr-ref">{shortRef(pr.sourceRefName)}</span>
          <span className="ix-faint">→</span>
          <span className="ix-pr-ref">{shortRef(pr.targetRefName)}</span>
          <span className="ix-faint">{pr.url}</span>
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

      <div className="ix-pr-detail">
        <div className="ix-pr-files">
          <span className="ix-eyebrow">Changed files</span>
          {changes.length === 0 && <span className="ix-faint">No changes.</span>}
          {changes.map((c) => (
            <button
              key={c.path}
              type="button"
              className={`ix-pr-file${c.path === activeFilePath ? ' ix-pr-file--active' : ''}`}
              onClick={() => void usePrInboxStore.getState().openFile(c.path)}
              title={c.path}
            >
              <span className={`ix-pr-file__type ix-pr-file__type--${c.changeType}`}>
                {c.changeType[0].toUpperCase()}
              </span>
              <span className="ix-pr-file__path">{c.path}</span>
            </button>
          ))}
        </div>

        <div className="ix-pr-content">
          {running ? (
            <ReviewTerminal />
          ) : (
            <>
              <div className="ix-pr-diff-wrap">
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
                <div className="ix-pr-threads">
                  <span className="ix-eyebrow">Existing threads</span>
                  {threads.map((t) => (
                    <ThreadRow key={t.threadId} thread={t} />
                  ))}
                </div>
              )}

              <div className="ix-pr-drafts">
                <span className="ix-eyebrow">Draft comments</span>
                {drafts.length === 0 ? (
                  <span className="ix-faint">
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
