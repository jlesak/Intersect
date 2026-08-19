import { useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { ContextMenu, type MenuEntry } from './ContextMenu'
import { IconMore, IconPlay } from './icons'

export interface RowAction {
  /** The button's visible text, which is also the name a screen reader announces. */
  label: string
  onClick(): void
}

/**
 * The action bar of a work-item row: the row's primary action as a filled button, an optional
 * link out to where the item lives, and an optional overflow menu for everything else. It is
 * revealed by hovering or focusing the row, so what the row can do is advertised on the row
 * instead of waiting behind a right-click.
 *
 * Every press stops inside the bar, so a button never also activates the row it sits in. That
 * covers the overflow menu too: it is portalled out of the row in the DOM and stays a child of
 * the bar in the React tree, which is the tree React bubbles synthetic events along.
 *
 * While the menu stands the bar marks itself open, because the pointer has left the row for a
 * menu that lives elsewhere and the reveal has to survive that.
 */
export function RowActions({
  primary,
  external,
  overflow,
  overflowLabel = 'More actions'
}: {
  primary: RowAction
  /** Opens the item where it lives (its Jira issue, its pull request) in the browser. */
  external?: RowAction
  /** Everything else the row offers. An empty list raises no overflow button at all. */
  overflow?: MenuEntry[]
  /** The overflow trigger's accessible name, for a surface where "More actions" is ambiguous. */
  overflowLabel?: string
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const entries = overflow ?? []

  const contain = (e: MouseEvent | KeyboardEvent): void => e.stopPropagation()

  return (
    <span
      className={`ix-rowactions${menuAt ? ' ix-rowactions--open' : ''}`}
      onClick={contain}
      onKeyDown={contain}
    >
      <button
        type="button"
        className="ix-rowactions__btn ix-rowactions__btn--primary"
        onClick={primary.onClick}
      >
        <IconPlay width={10} height={10} aria-hidden />
        <span className="ix-rowactions__label">{primary.label}</span>
      </button>
      {external && (
        <button
          type="button"
          className="ix-rowactions__btn ix-rowactions__btn--ghost"
          onClick={external.onClick}
        >
          <span className="ix-rowactions__label">{external.label}</span>
          <span className="ix-rowactions__out" aria-hidden>
            ↗
          </span>
        </button>
      )}
      {entries.length > 0 && (
        <button
          ref={triggerRef}
          type="button"
          className="ix-rowactions__btn ix-rowactions__btn--more"
          aria-label={overflowLabel}
          onClick={() => {
            if (menuAt) {
              setMenuAt(null)
              return
            }
            const r = triggerRef.current?.getBoundingClientRect()
            setMenuAt({ x: r?.left ?? 0, y: (r?.bottom ?? 0) + 4 })
          }}
        >
          <IconMore width={13} height={13} aria-hidden />
        </button>
      )}
      {menuAt && (
        <ContextMenu
          x={menuAt.x}
          y={menuAt.y}
          entries={entries}
          anchor={triggerRef.current}
          onClose={() => setMenuAt(null)}
        />
      )}
    </span>
  )
}
