import { useRef, useState, type KeyboardEvent } from 'react'
import type { NoteEntry } from '@common/domain'
import { IconPencil, IconTrash } from '@renderer/shared/ui/icons'
import { formatNoteTime } from '../format'
import { Highlighted } from './Highlighted'

/**
 * One entry: its capture time and body, editable in place. A double-click or the pencil opens the
 * editor; Enter or leaving it saves, Shift+Enter starts a new line, Escape cancels. Saving an empty
 * text keeps the old one. A save that fails keeps the editor open with the draft, so nothing typed
 * is lost.
 */
export function NoteEntryRow({
  entry,
  terms,
  onSave,
  onDelete
}: {
  entry: NoteEntry
  terms: readonly string[]
  onSave(body: string): Promise<boolean>
  onDelete(): void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.body)
  // Enter saves and then unmounts the editor, which can blur it: one save, not two.
  const saving = useRef(false)

  function open(): void {
    setDraft(entry.body)
    setEditing(true)
  }

  async function commit(): Promise<void> {
    if (saving.current) return
    if (draft.trim() === '' || draft === entry.body) {
      setEditing(false)
      return
    }
    saving.current = true
    try {
      if (await onSave(draft)) setEditing(false)
    } finally {
      saving.current = false
    }
  }

  function onEditorKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Escape') {
      // The editor owns this Escape; nothing behind it should act on it too.
      e.preventDefault()
      e.stopPropagation()
      setEditing(false)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void commit()
    }
  }

  return (
    <div
      className={`ix-note${editing ? ' ix-note--editing' : ''}`}
      role="listitem"
      onDoubleClick={(e) => {
        if (editing) return
        // A double-press on one of the row's own buttons belongs to that button.
        if ((e.target as HTMLElement).closest('button') !== null) return
        open()
      }}
    >
      <span className="ix-note__time">{formatNoteTime(entry.createdAt)}</span>
      {editing ? (
        <textarea
          className="ix-input ix-note__editor"
          aria-label="Edit note"
          autoFocus
          rows={Math.min(8, Math.max(2, draft.split('\n').length))}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onEditorKeyDown}
          onBlur={() => void commit()}
        />
      ) : (
        <span className="ix-note__body">
          <Highlighted text={entry.body} terms={terms} />
        </span>
      )}
      {!editing && (
        <span className="ix-note__actions">
          <button type="button" className="ix-iconbtn" title="Edit" onClick={open}>
            <IconPencil width={12} height={12} />
          </button>
          <button type="button" className="ix-iconbtn" title="Delete" onClick={onDelete}>
            <IconTrash width={12} height={12} />
          </button>
        </span>
      )}
    </div>
  )
}
