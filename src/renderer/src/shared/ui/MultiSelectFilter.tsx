import { useState } from 'react'
import { type FilterOption, type Selection, toggleSelection } from '../selection'

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
  if (options.length === 0) return null

  const values = options.map((option) => option.value)
  const chosen = selection === null ? options.length : selection.length
  const isChecked = (value: string): boolean => selection === null || selection.includes(value)

  return (
    <div className="ix-msel">
      <button
        type="button"
        className="ix-msel__btn"
        aria-expanded={open}
        data-testid={testId}
        onClick={() => setOpen((o) => !o)}
      >
        {label}{' '}
        <span className="ix-msel__count">
          {chosen}/{options.length}
        </span>
      </button>
      {open && (
        <>
          <div className="ix-msel__backdrop" onMouseDown={() => setOpen(false)} />
          <div className="ix-msel__pop" role="menu">
            <div className="ix-msel__head">
              <span className="ix-eyebrow">{label}</span>
              <div className="ix-msel__actions">
                <button
                  type="button"
                  className="ix-btn ix-btn--ghost"
                  onClick={() => onChange(null)}
                >
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
                    onChange={() => onChange(toggleSelection(selection, option.value, values))}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
