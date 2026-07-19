import * as monaco from 'monaco-editor'
import { useEffect, useRef, useState } from 'react'
import '@renderer/monaco-workers'

/**
 * An editable Monaco JSON editor for the guarded raw-editing path. It owns its buffer and hands
 * the current text back only when the user asks to preview, so nothing is written without going
 * through the same validate -> preview -> confirm -> save pipeline as the structured editors.
 * Lazy-loaded, so opening the Raw tab is what pulls in Monaco - never the rest of the pane.
 */
export function RawJsonEditor({
  initialContent,
  busy,
  onPreview,
  onReload
}: {
  initialContent: string
  busy: boolean
  onPreview: (content: string) => void
  onReload: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const editor = monaco.editor.create(host, {
      value: initialContent,
      language: 'json',
      readOnly: false,
      automaticLayout: true,
      theme: 'vs-dark',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 12
    })
    editorRef.current = editor
    const sub = editor.onDidChangeModelContent(() => setDirty(editor.getValue() !== initialContent))
    return () => {
      sub.dispose()
      editor.dispose()
      editorRef.current = null
    }
    // A fresh initialContent (after reload or a successful save) rebuilds the buffer.
  }, [initialContent])

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
