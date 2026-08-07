import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { formatAccelerator, shortcutActionFor } from '@common/shortcuts'
import { getCaptures, matchCapture } from '@renderer/shared/registries/captureRegistry'
import {
  getAllCommands,
  getCommand,
  getProvidedCommands,
  isCommandEnabled,
  type Command
} from '@renderer/shared/registries/commandRegistry'
import { filterCommands } from '../fuzzy'
import { paletteSections } from '../sections'
import { useCommandPaletteStore } from '../store'

/** The registry namespace a command belongs to (the id prefix before the first dot). */
function namespaceOf(command: Command): string {
  const dot = command.id.indexOf('.')
  return dot === -1 ? command.id : command.id.slice(0, dot)
}

/**
 * A keyboard-driven overlay for running any registered command: filters commands as you type and
 * runs the selected one on Enter. Opening it is the native menu's job, so the overlay only reads
 * its own visibility and never listens for the key itself.
 */
export function CommandPalette() {
  const open = useCommandPaletteStore((s) => s.open)
  const close = useCommandPaletteStore((s) => s.close)
  const recentIds = useCommandPaletteStore((s) => s.recentIds)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Snapshot the registry when the palette opens; command registration happens once at startup, so
  // the set is stable while it is open.
  const [commands, setCommands] = useState<Command[]>([])
  // A query claimed by a capture prefix stops being a search: the palette is now a one-line form
  // for that slice, and listing commands underneath would only invite Enter to run the wrong one.
  const capturing = useMemo(() => matchCapture(query), [query])
  const capturePreview = capturing?.capture.preview(capturing.rest) ?? null

  // Targets that only exist because of what is loaded right now - one per workspace, pull request
  // or past session - are rebuilt per query rather than snapshotted, so a provider can decline to
  // answer an empty one.
  const results = useMemo(
    () => (capturing ? [] : filterCommands(query, [...commands, ...getProvidedCommands(query)])),
    [capturing, query, commands]
  )
  const sections = useMemo(
    () => paletteSections(results, query, recentIds),
    [results, query, recentIds]
  )

  // The rendered order, flattened. Selection is an index into this, so what the arrow keys walk and
  // what the eye reads can never come apart.
  const rows = useMemo(() => sections.flatMap((section) => section.commands), [sections])

  // Which rows can actually run right now, resolved once per render so a predicate that reads a
  // store is not called again for every keystroke of navigation.
  const runnable = useMemo(() => rows.map((command) => isCommandEnabled(command)), [rows])

  // Where each section starts in `rows`, so a rendered button can name its own flat index without
  // the render pass having to count as it goes.
  const sectionStarts = useMemo(() => {
    let start = 0
    return sections.map((section) => {
      const at = start
      start += section.commands.length
      return at
    })
  }, [sections])

  /** The nearest runnable row from `from` walking in `step`, or the current one when there is none. */
  function nextRunnable(from: number, step: -1 | 1): number {
    for (let i = from; i >= 0 && i < rows.length; i += step) {
      if (runnable[i]) return i
    }
    return selected
  }

  useEffect(() => {
    if (!open) return
    // Positional commands - "Tab 4" and its siblings - are noise nobody would type, so they stay
    // out of the list while keeping their accelerators.
    setCommands(getAllCommands().filter((c) => shortcutActionFor(c.id)?.hidden !== true))
    setQuery('')
    inputRef.current?.focus()
  }, [open])

  // Keep the query change from stranding the selection past the end of the filtered list, and from
  // landing it on a command that cannot run.
  useEffect(() => {
    setSelected(runnable.findIndex(Boolean))
  }, [runnable])

  // Keep the highlighted row visible as the selection moves by keyboard.
  useEffect(() => {
    listRef.current
      ?.querySelector('.ix-palette__item--active')
      ?.scrollIntoView({ block: 'nearest' })
  }, [selected, rows])

  function run(index: number): void {
    const command = rows[index]
    if (!command || !runnable[index]) return
    close()
    // Only registered commands are remembered. A state-derived target's id names one workspace or
    // one past session, so remembering it would fill the recents with history rather than habits -
    // and with entries that stop resolving the moment that target is gone.
    if (getCommand(command.id)) void useCommandPaletteStore.getState().recordUse(command.id)
    void command.handler()
  }

  /** Perform the capture the query names, if it has been given enough to act on. */
  function runCapture(): void {
    if (!capturing || capturePreview === null) return
    close()
    void capturing.capture.run(capturing.rest)
  }

  function onInputKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Escape') {
      close()
    } else if (capturing) {
      if (e.key === 'Enter') {
        e.preventDefault()
        runCapture()
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected(nextRunnable(selected + 1, 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected(nextRunnable(selected - 1, -1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(selected)
    }
  }

  if (!open) return null

  return createPortal(
    <div className="ix-palette-overlay" onMouseDown={() => close()}>
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

        {capturing ? (
          <div className="ix-palette__capture">
            {capturePreview === null ? (
              <span className="ix-palette__capture-hint">{capturing.capture.hint}</span>
            ) : (
              <button
                type="button"
                className="ix-palette__item ix-palette__item--active"
                onClick={runCapture}
              >
                <span className="ix-palette__title">{capturePreview}</span>
                <span className="ix-palette__ns">{capturing.capture.prefix}</span>
              </button>
            )}
          </div>
        ) : rows.length === 0 ? (
          <div className="ix-palette__empty">No commands match "{query.trim()}"</div>
        ) : (
          <div ref={listRef} id="ix-palette-list" className="ix-palette__list" role="listbox">
            {sections.map((section, sectionIndex) => (
              <div className="ix-palette__section" key={section.heading ?? ''}>
                {section.heading && (
                  <div className="ix-palette__heading" role="presentation">
                    {section.heading}
                  </div>
                )}
                {section.commands.map((command, positionInSection) => {
                  const i = sectionStarts[sectionIndex] + positionInSection
                  const action = shortcutActionFor(command.id)
                  const enabled = runnable[i]
                  const classes = ['ix-palette__item']
                  if (i === selected) classes.push('ix-palette__item--active')
                  if (!enabled) classes.push('ix-palette__item--disabled')
                  return (
                    <button
                      key={command.id}
                      type="button"
                      role="option"
                      aria-selected={i === selected}
                      aria-disabled={!enabled}
                      disabled={!enabled}
                      className={classes.join(' ')}
                      onMouseEnter={() => enabled && setSelected(i)}
                      onClick={() => run(i)}
                    >
                      <span className="ix-palette__title">{command.title}</span>
                      <span className="ix-palette__ns">{namespaceOf(command)}</span>
                      {action && (
                        <kbd className="ix-kbd">{formatAccelerator(action.accelerator)}</kbd>
                      )}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        )}

        <div className="ix-palette__legend">
          <span className="ix-palette__prefixes">
            {getCaptures()
              .map((capture) => capture.prefix)
              .join('  ')}
          </span>
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
