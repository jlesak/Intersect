import { useEffect, useRef, useState } from 'react'
import { IconClose } from '@renderer/shared/ui/icons'
import { useFindStore } from '../findStore'
import {
  clearSessionSearch,
  findInSession,
  focusSession,
  onSessionSearchResults
} from '../terminalController'

/** Nothing has been searched for yet, or the query no longer matches anything. */
const NO_MATCHES = { index: -1, count: 0 }

/**
 * How the match tally reads to the user. Past its highlight limit the terminal stops tracking
 * which match the caret stands on, and the honest answer there is the total on its own - a
 * placeholder in its place would read as breakage.
 */
export function matchLabel(index: number, count: number): string {
  if (count === 0) return '0/0'
  if (index < 0) return `${count}`
  return `${index + 1}/${count}`
}

/**
 * Find-in-scrollback for one terminal: an overlay in its pane, searching that pane's buffer and
 * no other. Typing searches as it goes, Enter and Shift+Enter walk the matches in either
 * direction, and Escape ends the search and gives the keyboard back to the shell.
 */
export function FindBar({ sessionId }: { sessionId: string }) {
  const query = useFindStore((s) => s.query[sessionId] ?? '')
  const focusToken = useFindStore((s) => s.focusToken[sessionId] ?? 0)
  const inputRef = useRef<HTMLInputElement>(null)
  const [results, setResults] = useState(NO_MATCHES)

  // Every request for this bar - the one that opened it and every later one - takes the caret
  // back to the query and selects it, so the next thing typed replaces the last search.
  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [focusToken])

  useEffect(
    () =>
      onSessionSearchResults(sessionId, (event) =>
        setResults({ index: event.resultIndex, count: event.resultCount })
      ),
    [sessionId]
  )

  const close = (): void => {
    clearSessionSearch(sessionId)
    useFindStore.getState().closeFind(sessionId)
    focusSession(sessionId)
  }

  const search = (next: string): void => {
    useFindStore.getState().setQuery(sessionId, next)
    // An emptied query runs no search, so the terminal reports no tally for it either.
    if (next === '') setResults(NO_MATCHES)
    findInSession(sessionId, next, 'next', true)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Enter') return
    event.preventDefault()
    findInSession(sessionId, query, event.shiftKey ? 'previous' : 'next')
  }

  return (
    <div className="ix-find" data-session-id={sessionId}>
      <input
        ref={inputRef}
        className="ix-find__input"
        type="text"
        aria-label="Find in terminal"
        placeholder="Find in scrollback"
        value={query}
        onChange={(e) => search(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="ix-find__count">{matchLabel(results.index, results.count)}</span>
      <button type="button" className="ix-find__btn" aria-label="Close find" onClick={close}>
        <IconClose />
      </button>
    </div>
  )
}
