import { useRef, useState } from 'react'
import { useNotesStore } from '../store'

/**
 * The multi-line box under today's entries. Cmd+Enter or Add writes the text as one entry. The box
 * empties only once the entry is written; a failed save leaves the text where it was.
 */
export function NoteCapture() {
  const [text, setText] = useState('')
  const busy = useRef(false)

  async function submit(): Promise<void> {
    if (busy.current || text.trim() === '') return
    const submitted = text
    busy.current = true
    try {
      if (await useNotesStore.getState().add(submitted)) {
        // Whatever was typed while the save was on its way stays.
        setText((current) => (current === submitted ? '' : current))
      }
    } finally {
      busy.current = false
    }
  }

  return (
    <div className="ix-notes__capture">
      <textarea
        className="ix-input ix-notes__capture-input"
        aria-label="New note"
        placeholder="Write a note… (⌘Enter to add)"
        rows={3}
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return
          e.preventDefault()
          void submit()
        }}
      />
      <button
        type="button"
        className="ix-btn ix-btn--primary ix-notes__add"
        onClick={() => void submit()}
      >
        Add
      </button>
    </div>
  )
}
