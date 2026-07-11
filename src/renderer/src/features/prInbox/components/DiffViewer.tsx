import * as monaco from 'monaco-editor'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DraftComment, FileDiff, PrThread } from '@common/domain'
import { usePrInboxStore } from '../store'
import { CommentComposer } from './CommentComposer'
import { useMonacoZones, type ZoneSpec } from './monacoZones'
import { ThreadCard } from './ThreadCard'

interface DiffViewerProps {
  diff: FileDiff | null
  loading: boolean
  drafts: DraftComment[]
  threads: PrThread[]
  /** File + line the diff should scroll to once up (set by Overview's file:line chip). */
  pendingReveal: { path: string; line: number | null } | null
  onRevealDone(): void
}

/**
 * Side-by-side, read-only Monaco diff of one changed file. Existing ADO threads render inline
 * under their lines (full conversation, reply, resolve), drafts as pinned notes, and a click on
 * a line number opens an inline comment composer. All inline content lives in Monaco view zones
 * hosting React portals. Binary / oversized files never reach Monaco.
 */
export function DiffViewer({
  diff,
  loading,
  drafts,
  threads,
  pendingReveal,
  onRevealDone
}: DiffViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const [modifiedEditor, setModifiedEditor] = useState<monaco.editor.ICodeEditor | null>(null)
  const [composerLine, setComposerLine] = useState<number | null>(null)

  const renderable = !!diff && !diff.binary && !diff.tooLarge

  // The diff editor lives as long as we have something renderable; rebuilt only when that flips.
  useEffect(() => {
    const host = hostRef.current
    if (!renderable || !host) return
    const editor = monaco.editor.createDiffEditor(host, {
      renderSideBySide: true,
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      theme: 'vs-dark',
      minimap: { enabled: false },
      glyphMargin: true
    })
    editorRef.current = editor
    setModifiedEditor(editor.getModifiedEditor())
    return () => {
      editor.dispose()
      editorRef.current = null
      setModifiedEditor(null)
    }
  }, [renderable])

  // Swap in fresh models whenever the file changes (keyed on the diff's path).
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !diff) return
    const original = monaco.editor.createModel(diff.original, diff.language)
    const modified = monaco.editor.createModel(diff.modified, diff.language)
    editor.setModel({ original, modified })
    setComposerLine(null)
    return () => {
      original.dispose()
      modified.dispose()
    }
  }, [diff?.path, diff?.original, diff?.modified, diff?.language])

  // A click on a line number (or the glyph margin) opens the inline comment composer there.
  useEffect(() => {
    if (!modifiedEditor) return
    const sub = modifiedEditor.onMouseDown((e) => {
      const t = e.target.type
      if (
        t === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS ||
        t === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN
      ) {
        const line = e.target.position?.lineNumber
        if (line) setComposerLine(line)
      }
    })
    return () => sub.dispose()
  }, [modifiedEditor])

  // Scroll to the line the Overview chip pointed at, once the right file is up.
  useEffect(() => {
    if (!modifiedEditor || !diff || !pendingReveal) return
    if (pendingReveal.path !== diff.path) return
    if (pendingReveal.line) modifiedEditor.revealLineInCenter(pendingReveal.line)
    onRevealDone()
  }, [modifiedEditor, diff, pendingReveal])

  const zoneSpecs = useMemo<ZoneSpec[]>(() => {
    if (!diff) return []
    const store = usePrInboxStore.getState
    const specs: ZoneSpec[] = []
    for (const t of threads) {
      if (t.isSystem || t.filePath !== diff.path || !t.line) continue
      specs.push({
        key: `thread-${t.threadId}`,
        afterLine: t.line,
        node: (
          <ThreadCard
            thread={t}
            onReply={(body) => store().replyToThread(t.threadId, body)}
            onSetStatus={(status) => store().setThreadStatus(t.threadId, status)}
          />
        )
      })
    }
    for (const d of drafts) {
      if (d.filePath !== diff.path || d.side !== 'right') continue
      specs.push({
        key: `draft-${d.id}`,
        afterLine: d.line,
        node: (
          <div className="ix-zone-draft">
            <span className="ix-chip">{d.source === 'claude' ? 'Claude draft' : 'Draft'}</span>
            <p className="ix-thread__body">{d.body}</p>
          </div>
        )
      })
    }
    if (composerLine) {
      specs.push({
        key: 'composer',
        afterLine: composerLine,
        node: (
          <CommentComposer
            label={`New comment · line ${composerLine}`}
            onSubmit={async (body) => {
              await store().addComment(diff.path, composerLine, body)
              setComposerLine(null)
            }}
            onCancel={() => setComposerLine(null)}
          />
        )
      })
    }
    return specs
  }, [diff, threads, drafts, composerLine])

  const portals = useMonacoZones(modifiedEditor, zoneSpecs)

  if (loading) {
    return <div className="ix-pr-diff__placeholder">Loading diff…</div>
  }
  if (!diff) {
    return <div className="ix-pr-diff__placeholder">Select a file to view its diff.</div>
  }
  if (diff.binary) {
    return <div className="ix-pr-diff__placeholder">Binary file not shown.</div>
  }
  if (diff.tooLarge) {
    return <div className="ix-pr-diff__placeholder">File too large to display.</div>
  }

  return (
    <div className="ix-pr-diff">
      <div className="ix-pr-diff__toolbar">
        <span className="ix-eyebrow">{diff.path}</span>
        <span className="ix-faint" style={{ fontSize: 11 }}>
          Click a line number to comment
        </span>
      </div>
      <div className="ix-pr-diff__host" ref={hostRef} />
      {portals}
    </div>
  )
}
