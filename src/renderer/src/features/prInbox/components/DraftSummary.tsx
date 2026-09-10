import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { DraftComment, DraftSnippet } from '@common/domain'
import { isDraftStale, selectDrafts, selectSelectedPr, usePrInboxStore } from '../store'
import { DraftCard } from './DraftCard'

/** The renderer's copy of the Azure DevOps path convention, as used everywhere in this feature. */
const canonicalPath = (path: string): string => `/${path.trim().replace(/^\/+/, '')}`

export interface DraftFileGroup {
  filePath: string
  drafts: DraftComment[]
}

/**
 * The drafts gathered per file, files in the order their first comment was written and comments by
 * line within a file, so the summary reads as a walk through the review rather than as the order a
 * database happened to return.
 */
export function groupDraftsByFile(drafts: DraftComment[]): DraftFileGroup[] {
  const groups: DraftFileGroup[] = []
  for (const draft of drafts) {
    const filePath = canonicalPath(draft.filePath)
    const group = groups.find((g) => g.filePath === filePath)
    if (group) group.drafts.push(draft)
    else groups.push({ filePath, drafts: [draft] })
  }
  for (const group of groups) group.drafts.sort((a, b) => a.line - b.line)
  return groups
}

/** The anchored line with its context, numbered as in the file and with the anchor marked. */
function Snippet({ snippet }: { snippet: DraftSnippet }) {
  return (
    <div className="ix-draft-snippet" data-testid="pr-draft-snippet">
      {snippet.lines.map((text, index) => {
        const line = snippet.startLine + index
        const anchored = line === snippet.anchorLine
        return (
          <div
            key={line}
            className={`ix-draft-snippet__line${anchored ? ' ix-draft-snippet__line--anchor' : ''}`}
          >
            <span className="ix-draft-snippet__no">{line}</span>
            <code className="ix-draft-snippet__code">{text === '' ? ' ' : text}</code>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Every comment this review proposes, on one page: the code each one is about, the comment itself,
 * and the same approve / edit / discard decisions the diff offers, with a jump into the file for the
 * ones that need the surrounding code to judge.
 *
 * This exists because the drafts are otherwise only reachable one file at a time, from inside the
 * diff of the file they happen to anchor to - a shape that can show a reviewer each finding but
 * never the review.
 */
export function DraftSummary() {
  const pr = usePrInboxStore(selectSelectedPr)
  const drafts = usePrInboxStore(useShallow(selectDrafts))
  const snippets = usePrInboxStore(useShallow((s) => s.draftSnippets))
  const snippetsStatus = usePrInboxStore((s) => s.draftSnippetsStatus)

  // A draft with no snippet in hand is what asks for the fetch, so a comment the running review just
  // recorded picks up its code too. `null` is an answer and stays one; only an absent key is a gap.
  const missingSnippets = drafts.some((draft) => !(draft.id in snippets))
  useEffect(() => {
    if (missingSnippets && snippetsStatus !== 'loading' && snippetsStatus !== 'error') {
      void usePrInboxStore.getState().loadDraftSnippets()
    }
  }, [missingSnippets, snippetsStatus])

  const groups = useMemo(() => groupDraftsByFile(drafts), [drafts])

  if (!pr) return null

  return (
    <div className="ix-draft-summary" data-testid="pr-draft-summary">
      <div className="ix-overview__head">
        <span className="ix-eyebrow">Proposed comments</span>
        <span className="ix-faint">
          {drafts.length === 0
            ? 'Nothing waiting'
            : `${drafts.length} ${drafts.length === 1 ? 'comment' : 'comments'} in ${groups.length} ${
                groups.length === 1 ? 'file' : 'files'
              }, none published yet`}
        </span>
      </div>

      {snippetsStatus === 'error' && (
        <div className="ix-mw-loading ix-mw-stale" data-testid="pr-draft-snippets-error">
          The code beside these comments could not be read.
          <button
            type="button"
            className="ix-btn ix-btn--ghost"
            onClick={() => void usePrInboxStore.getState().loadDraftSnippets()}
          >
            Retry
          </button>
        </div>
      )}

      {drafts.length === 0 ? (
        <div className="ix-empty">
          <span className="ix-eyebrow">No proposed comments</span>
          <div className="ix-empty__title">Nothing to approve</div>
          <p className="ix-empty__hint">
            Comments drafted by a Claude review, or written on the diff, wait here until you approve
            or discard them.
          </p>
        </div>
      ) : (
        groups.map((group) => (
          <section className="ix-draft-group" key={group.filePath} data-testid="pr-draft-group">
            <button
              type="button"
              className="ix-draft-group__file"
              data-testid="pr-draft-group-open"
              title="Open this file in Changes"
              onClick={() =>
                usePrInboxStore.getState().revealInDiff(group.filePath, group.drafts[0].line)
              }
            >
              <span className="ix-draft-group__path">{group.filePath}</span>
              <span className="ix-board-col__count">{group.drafts.length}</span>
            </button>
            {group.drafts.map((draft) => (
              <DraftCard
                key={draft.id}
                draft={draft}
                stale={isDraftStale(draft, pr.sourceCommitId)}
                onOpen={() => usePrInboxStore.getState().revealInDiff(group.filePath, draft.line)}
                snippet={
                  draft.id in snippets ? (
                    snippets[draft.id] ? (
                      <Snippet snippet={snippets[draft.id]!} />
                    ) : (
                      <p className="ix-faint ix-draft-snippet--missing" data-testid="pr-draft-snippet-missing">
                        The code at this line could not be read.
                      </p>
                    )
                  ) : null
                }
              />
            ))}
          </section>
        ))
      )}
    </div>
  )
}
