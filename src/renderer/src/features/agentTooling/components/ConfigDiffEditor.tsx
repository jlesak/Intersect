import * as monaco from 'monaco-editor'
import { useEffect, useRef } from 'react'
import '@renderer/monaco-workers'

/**
 * A read-only, side-by-side JSON diff of the current file bytes against the proposed bytes, shown
 * inside the save-confirmation dialog. Heavy (it pulls in Monaco), so it is always reached through
 * a lazy import - it never loads until a preview is actually open. Both sides are plain `json`
 * models disposed with the editor.
 */
export function ConfigDiffEditor({ current, proposed }: { current: string; proposed: string }) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const editor = monaco.editor.createDiffEditor(host, {
      renderSideBySide: true,
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      theme: 'vs-dark',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 12
    })
    const original = monaco.editor.createModel(current, 'json')
    const modified = monaco.editor.createModel(proposed, 'json')
    editor.setModel({ original, modified })
    return () => {
      editor.dispose()
      original.dispose()
      modified.dispose()
    }
  }, [current, proposed])

  return <div className="ix-at-diff__host" ref={hostRef} />
}
