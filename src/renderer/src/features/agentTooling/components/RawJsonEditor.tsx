import * as monaco from 'monaco-editor'
import { useEffect, useRef, useState } from 'react'
import '@renderer/monaco-workers'

export interface RawJsonEditorProps {
  /** The text the buffer starts from: the file on disk, or the unsaved edit being restored. */
  seed: string
  /** The current on-disk text, which decides whether there is anything to save or to keep. */
  baseline: string
  busy: boolean
  /** Every keystroke, so the edit lives outside this component and outlives its unmount. */
  onChange: (content: string) => void
  onPreview: (content: string) => void
  onReload: () => void
}

/**
 * An editable Monaco JSON editor for the guarded raw-editing path. It hands the current text to
 * the save pipeline only when the user asks to preview, so nothing is written without going
 * through the same validate -> preview -> confirm -> save path as the structured editors.
 * Lazy-loaded, so opening the Raw tab is what pulls in Monaco - never the rest of the pane.
 *
 * The buffer is seeded once per editor instance and reported outwards as it changes. Feeding the
 * text back in as a value would rebuild the editor on every character and take the cursor,
 * selection, undo history and scroll position with it.
 */
export function RawJsonEditor({
  seed,
  baseline,
  busy,
  onChange,
  onPreview,
  onReload
}: RawJsonEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const [dirty, setDirty] = useState(seed !== baseline)
  // The change handler reads both through refs, so a re-render never rebuilds the buffer.
  const latest = useRef({ baseline, onChange })

  useEffect(() => {
    latest.current = { baseline, onChange }
  })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const editor = monaco.editor.create(host, {
      value: seed,
      language: 'json',
      readOnly: false,
      automaticLayout: true,
      theme: 'vs-dark',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 12
    })
    editorRef.current = editor
    const sub = editor.onDidChangeModelContent(() => {
      const text = editor.getValue()
      setDirty(text !== latest.current.baseline)
      latest.current.onChange(text)
    })
    return () => {
      sub.dispose()
      editor.dispose()
      editorRef.current = null
    }
    // A fresh seed is a fresh target file or a reload, and both mean a new buffer.
  }, [seed])

  return (
    <div className="ix-at-raw">
      <div className="ix-at-raw__toolbar">
        <button type="button" className="ix-btn ix-btn--ghost" onClick={onReload} disabled={busy}>
          Reload from disk
        </button>
        <button
          type="button"
          className="ix-btn ix-btn--primary"
          disabled={busy || !dirty}
          onClick={() => {
            const value = editorRef.current?.getValue()
            if (value !== undefined) onPreview(value)
          }}
        >
          Preview changes…
        </button>
      </div>
      <div className="ix-at-raw__host" ref={hostRef} />
    </div>
  )
}
