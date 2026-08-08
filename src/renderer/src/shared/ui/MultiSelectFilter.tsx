import { useEffect, useRef, useState } from 'react'
import {
  type FilterOption,
  type Selection,
  reconcileSelection,
  toggleSelection
} from '../selection'

/**
 * A chip filter over a set of values: a button that opens a checkbox popover, with All and None to
 * get back to either extreme in one click.
 *
 * Shows nothing at all when there is nothing to choose between. The values come from the data on
 * screen rather than from a fixed list, so a field the remote system never fills leaves no dead
 * control behind - which is exactly what a Jira board whose epic link was never configured does.
 */
export function MultiSelectFilter({
  label,
  options,
  selection,
  onChange,
  testId
}: {
  label: string
  options: readonly FilterOption[]
  selection: Selection
  onChange: (next: string[] | null) => void
  testId?: string
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const root = useRef<HTMLDivElement>(null)

  // Dismissed by listening for a press elsewhere rather than by covering the page with a shield.
  // A shield swallows the press that dismisses it, which costs the user a whole click every time
  // they move from one chip to the next - and two chips side by side is the ordinary case.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      if (root.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  if (options.length === 0) return null

  // Read against what is actually on offer, so the count on the button and the ticks in the list
  // are two views of one thing and can never disagree about a value that has since vanished.
  const values = options.map((option) => option.value)
  const chosen = reconcileSelection(selection, values)
  const chosenCount = chosen === null ? options.length : chosen.length
  const isChecked = (value: string): boolean => chosen === null || chosen.includes(value)

  return (
    <div
      className="ix-msel"
      ref={root}
      onKeyDown={(e) => {
        // Escape belongs to the popover while it is open, and to whatever is behind it otherwise.
        if (e.key !== 'Escape' || !open) return
        e.stopPropagation()
        setOpen(false)
        trigger.current?.focus()
      }}
      onBlur={(e) => {
        // Focus moving to something outside takes the popover with it, so tabbing past the last
        // checkbox cannot walk on into a page hidden behind it.
        //
        // Focus going nowhere in particular is left alone. Pressing a checkbox's label drops focus
        // before the label hands it to the checkbox, and closing on that would make every option
        // in the list unclickable. A press elsewhere is already handled on its own.
        if (e.relatedTarget === null) return
        if (e.currentTarget.contains(e.relatedTarget)) return
        setOpen(false)
      }}
    >
      <button
        type="button"
        className="ix-msel__btn"
        ref={trigger}
        aria-expanded={open}
        data-testid={testId}
        onClick={() => setOpen((o) => !o)}
      >
        {label}{' '}
        <span className="ix-msel__count">
          {chosenCount}/{options.length}
        </span>
      </button>
      {open && (
        <div className="ix-msel__pop" role="group" aria-label={label}>
          <div className="ix-msel__head">
            <span className="ix-eyebrow">{label}</span>
            <div className="ix-msel__actions">
              <button type="button" className="ix-btn ix-btn--ghost" onClick={() => onChange(null)}>
                All
              </button>
              <button type="button" className="ix-btn ix-btn--ghost" onClick={() => onChange([])}>
                None
              </button>
            </div>
          </div>
          <div className="ix-msel__list">
            {options.map((option) => (
              <label key={option.value} className="ix-msel__item">
                <input
                  type="checkbox"
                  checked={isChecked(option.value)}
                  onChange={() => onChange(toggleSelection(chosen, option.value, values))}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
