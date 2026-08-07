import { type KeyboardEvent, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { selectFiltered, useSessionsStore } from '../store'
import { SessionRow } from './SessionRow'

/** The filtered, descending-by-activity list of sessions in the main area's left column. */
export function SessionList() {
  const sessions = useSessionsStore(useShallow(selectFiltered))
  const query = useSessionsStore((s) => s.query)
  const selectedId = useSessionsStore((s) => s.selectedId)
  const status = useSessionsStore((s) => s.status)
  const listRef = useRef<HTMLDivElement>(null)
  const [pointedAt, setPointedAt] = useState(0)

  // Narrowing the filters can leave the pointer past the end of the shorter list.
  const at = Math.min(pointedAt, Math.max(0, sessions.length - 1))

  /**
   * Which row a key came from, read off the focused element rather than from component state: the
   * browser's focus is the pointer, so a burst of keypresses can never act on a stale position.
   */
  const originOf = (target: EventTarget): number => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>('.ix-session-row')
    if (!rows) return -1
    return [...rows].indexOf(target as HTMLElement)
  }

  const point = (next: number): void => {
    setPointedAt(next)
    listRef.current?.querySelectorAll<HTMLElement>('.ix-session-row')[next]?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const from = originOf(e.target)
    if (from < 0 || from >= sessions.length) return
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        point(Math.min(from + 1, sessions.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        point(Math.max(from - 1, 0))
        break
      case 'Home':
        e.preventDefault()
        point(0)
        break
      case 'End':
        e.preventDefault()
        point(sessions.length - 1)
        break
      case 'Enter':
        e.preventDefault()
        // The modifier picks the session up and carries it into a terminal; plain Enter reads it.
        if (e.metaKey || e.ctrlKey) useSessionsStore.getState().requestResume(sessions[from])
        else void useSessionsStore.getState().select(sessions[from].id)
        break
      case ' ':
        e.preventDefault()
        void useSessionsStore.getState().select(sessions[from].id)
        break
    }
  }

  if (status === 'loading' && sessions.length === 0) {
    return (
      <div className="ix-sessions-list ix-sessions-list--empty">
        <span className="ix-faint">Loading sessions…</span>
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className="ix-sessions-list ix-sessions-list--empty">
        <span className="ix-faint">No sessions match the current filters.</span>
      </div>
    )
  }

  return (
    <div className="ix-sessions-list" ref={listRef} onKeyDown={onKeyDown}>
      {sessions.map((s, i) => (
        <SessionRow
          key={s.id}
          session={s}
          active={s.id === selectedId}
          query={query}
          focused={i === at}
          onFocus={() => setPointedAt(i)}
        />
      ))}
    </div>
  )
}
