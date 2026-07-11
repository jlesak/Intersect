import { useEffect, useRef, useState } from 'react'

interface CommentComposerProps {
  label: string
  onSubmit(body: string): Promise<void> | void
  onCancel(): void
  /**
   * Seeds the input on mount. Callers that render this composer inside a Monaco view zone (where a
   * remount would otherwise wipe local state) pass the persisted draft here.
   */
  initialBody?: string
  /** Called on every keystroke so the caller can persist the draft across remounts. */
  onBodyChange?(text: string): void
}

/** Inline comment box (diff line or PR-level): Ctrl+Enter submits, Esc cancels. */
export function CommentComposer({
  label,
  onSubmit,
  onCancel,
  initialBody = '',
  onBodyChange
}: CommentComposerProps) {
  const [body, setBody] = useState(initialBody)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => ref.current?.focus(), [])

  const changeBody = (text: string): void => {
    setBody(text)
    onBodyChange?.(text)
  }

  const submit = async (): Promise<void> => {
    const text = body.trim()
    if (!text || busy) return
    setBusy(true)
    try {
      await onSubmit(text)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ix-composer" data-testid="pr-composer">
      <span className="ix-eyebrow">{label}</span>
      <textarea
        ref={ref}
        className="ix-composer__input"
        rows={2}
        value={body}
        disabled={busy}
        data-testid="pr-composer-input"
        onChange={(e) => changeBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            void submit()
          }
          if (e.key === 'Escape') {
            // Close only the composer, not the whole detail (window-level Esc goes back).
            e.stopPropagation()
            onCancel()
          }
        }}
      />
      <div className="ix-composer__actions">
        <button type="button" className="ix-btn ix-btn--ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="ix-btn ix-btn--primary"
          data-testid="pr-composer-submit"
          disabled={!body.trim() || busy}
          onClick={() => void submit()}
        >
          Comment
        </button>
      </div>
    </div>
  )
}
