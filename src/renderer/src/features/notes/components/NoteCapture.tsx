import { useEffect, useRef, useState } from 'react'
import { useNotesStore } from '../store'

/**
 * The multi-line box under today's entries. Cmd+Enter or Add writes the text as one entry. The box
 * empties only once the entry is written; a failed save leaves the text where it was.
 *
 * Each new entry lands above the box and pushes it down, so after an add the box is brought back
 * fully into view: writing one note after another never has to stop to scroll.
 */
export function NoteCapture() {
  const [text, setText] = useState('')
  const busy = useRef(false)
  const boxRef = useRef<HTMLDivElement>(null)
  // Counts written entries. The scroll waits for the render that follows, which is the one that
  // has drawn the new entry above the box.
  const [added, setAdded] = useState(0)

  useEffect(() => {
    if (added > 0) boxRef.current?.scrollIntoView({ block: 'nearest' })
  }, [added])

  async function submit(): Promise<void> {
    if (busy.current || text.trim() === '') return
    const submitted = text
    busy.current = true
    try {
      if (await useNotesStore.getState().add(submitted)) {
        // Whatever was typed while the save was on its way stays.
        setText((current) => (current === submitted ? '' : current))
        setAdded((n) => n + 1)
      }
    } finally {
      busy.current = false
    }
  }

  return (
    <div className="ix-notes__capture" ref={boxRef}>
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
