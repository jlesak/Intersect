import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  getAllCommands,
  type Command
} from '@renderer/shared/registries/commandRegistry'
import { filterCommands } from '../fuzzy'

/** The registry namespace a command belongs to (the id prefix before the first dot). */
function namespaceOf(command: Command): string {
  const dot = command.id.indexOf('.')
  return dot === -1 ? command.id : command.id.slice(0, dot)
}

/**
 * A keyboard-driven overlay for running any registered command. Opens on Cmd+K, filters commands
 * as you type, and runs the selected one on Enter. It is a pure consumer of the command registry:
 * it registers nothing of its own and mounts globally, like the toaster.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Snapshot the registry when the palette opens; command registration happens once at startup, so
  // the set is stable while it is open.
  const [commands, setCommands] = useState<Command[]>([])
  const results = useMemo(() => filterCommands(query, commands), [query, commands])

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((wasOpen) => !wasOpen)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open) return
    setCommands(getAllCommands())
    setQuery('')
    setSelected(0)
    inputRef.current?.focus()
  }, [open])

  // Keep the query change from stranding the selection past the end of the filtered list.
  useEffect(() => {
    setSelected(0)
  }, [query])

  // Keep the highlighted row visible as the selection moves by keyboard.
  useEffect(() => {
    listRef.current
      ?.querySelector('.ix-palette__item--active')
      ?.scrollIntoView({ block: 'nearest' })
  }, [selected, results])

  function run(command: Command | undefined): void {
    if (!command) return
    setOpen(false)
    void command.handler()
  }

  function onInputKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Escape') {
      setOpen(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(results[selected])
    }
  }

  if (!open) return null

  return createPortal(
    <div className="ix-palette-overlay" onMouseDown={() => setOpen(false)}>
      <div
        className="ix-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="ix-palette__search">
          <span className="ix-palette__caret" aria-hidden="true">
            ›
          </span>
          <input
            ref={inputRef}
            className="ix-palette__input"
            type="text"
            placeholder="Run a command"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            role="combobox"
            aria-expanded="true"
            aria-controls="ix-palette-list"
            aria-autocomplete="list"
          />
        </div>

        {results.length === 0 ? (
          <div className="ix-palette__empty">No commands match "{query.trim()}"</div>
        ) : (
          <div ref={listRef} id="ix-palette-list" className="ix-palette__list" role="listbox">
            {results.map((command, i) => (
              <button
                key={command.id}
                type="button"
                role="option"
                aria-selected={i === selected}
                className={
                  i === selected ? 'ix-palette__item ix-palette__item--active' : 'ix-palette__item'
                }
                onMouseEnter={() => setSelected(i)}
                onClick={() => run(command)}
              >
                <span className="ix-palette__title">{command.title}</span>
                <span className="ix-palette__ns">{namespaceOf(command)}</span>
              </button>
            ))}
          </div>
        )}

        <div className="ix-palette__legend">
          <span>
            <kbd className="ix-kbd">↑</kbd>
            <kbd className="ix-kbd">↓</kbd> navigate
          </span>
          <span>
            <kbd className="ix-kbd">↵</kbd> run
          </span>
          <span>
            <kbd className="ix-kbd">esc</kbd> close
          </span>
        </div>
      </div>
    </div>,
    document.body
  )
}
