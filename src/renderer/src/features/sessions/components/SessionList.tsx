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

  /**
   * Move to a row, clamped to the ends of the list. Clamping here rather than at each caller is
   * what guarantees a row always holds the list's single Tab stop: a pointer off either end would
   * leave the whole list unreachable by Tab.
   */
  const point = (next: number): void => {
    const target = Math.max(0, Math.min(next, sessions.length - 1))
    setPointedAt(target)
    listRef.current?.querySelectorAll<HTMLElement>('.ix-session-row')[target]?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const from = originOf(e.target)
    if (from < 0 || from >= sessions.length) return
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        point(from + 1)
        break
      case 'ArrowUp':
        e.preventDefault()
        point(from - 1)
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
        // Either way the session opens, because its transcript header is where a resume reports
        // that it is still working.
        void useSessionsStore.getState().select(sessions[from].id)
        if (e.metaKey || e.ctrlKey) useSessionsStore.getState().requestResume(sessions[from])
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
