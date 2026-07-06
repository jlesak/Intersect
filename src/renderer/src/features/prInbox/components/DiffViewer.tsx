import * as monaco from 'monaco-editor'
import { useEffect, useRef } from 'react'
import type { DraftComment, FileDiff } from '@common/domain'

interface DiffViewerProps {
  diff: FileDiff | null
  loading: boolean
  drafts: DraftComment[]
  onAddDraft: (line: number, body: string) => void
}

/**
 * Side-by-side, read-only Monaco diff of one changed file. Draft comments anchored to the right
 * (modified) side are pinned as a glyph-margin marker plus an inline view zone under their line.
 * Binary / oversized files never reach Monaco - a placeholder stands in for them.
 */
export function DiffViewer({ diff, loading, drafts, onAddDraft }: DiffViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)

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
    return () => {
      editor.dispose()
      editorRef.current = null
    }
  }, [renderable])

  // Swap in fresh models whenever the file changes (keyed on the diff's path).
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !diff) return
    const original = monaco.editor.createModel(diff.original, diff.language)
    const modified = monaco.editor.createModel(diff.modified, diff.language)
    editor.setModel({ original, modified })
    return () => {
      original.dispose()
      modified.dispose()
    }
  }, [diff?.path, diff?.original, diff?.modified, diff?.language])

  // Pin right-side drafts to their lines as glyph decorations + inline view zones.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !diff) return
    const modified = editor.getModifiedEditor()
    const relevant = drafts.filter((d) => d.filePath === diff.path && d.side === 'right')

    const decorations = modified.createDecorationsCollection(
      relevant.map((d) => ({
        range: new monaco.Range(d.line, 1, d.line, 1),
        options: {
          isWholeLine: true,
          glyphMarginClassName: 'ix-pr-diff__glyph',
          glyphMarginHoverMessage: { value: d.body }
        }
      }))
    )

    const zoneIds: string[] = []
    modified.changeViewZones((accessor) => {
      for (const d of relevant) {
        const dom = document.createElement('div')
        dom.className = 'ix-pr-diff__zone'
        dom.textContent = `${d.source === 'claude' ? 'Claude' : 'You'}: ${d.body}`
        zoneIds.push(accessor.addZone({ afterLineNumber: d.line, heightInLines: 2, domNode: dom }))
      }
    })

    return () => {
      decorations.clear()
      modified.changeViewZones((accessor) => {
        for (const id of zoneIds) accessor.removeZone(id)
      })
    }
  }, [diff, drafts])

  const commentOnCursor = (): void => {
    const editor = editorRef.current
    const line = editor?.getModifiedEditor().getPosition()?.lineNumber
    if (!line) return
    const body = window.prompt(`Comment on line ${line}`)?.trim()
    if (body) onAddDraft(line, body)
  }

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
        <button type="button" className="ix-btn ix-btn--ghost" onClick={commentOnCursor}>
          Comment on cursor line
        </button>
      </div>
      <div className="ix-pr-diff__host" ref={hostRef} />
    </div>
  )
}
