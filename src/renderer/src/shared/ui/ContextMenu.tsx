import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  label: string
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}

export interface MenuSeparator {
  separator: true
}

export type MenuEntry = MenuItem | MenuSeparator

const isSeparator = (e: MenuEntry): e is MenuSeparator => 'separator' in e

/** How close to the window edge a menu is allowed to sit. */
const EDGE_GAP = 6

/**
 * A context menu anchored at a viewport point, dismissed on outside click or Escape.
 *
 * A menu raised by a button passes that button as `anchor`, which exempts it from the
 * outside-click dismissal. Without that the button could only ever open the menu: the press would
 * close it before the button's own click was delivered, and the click would open it straight back.
 */
export function ContextMenu({
  x,
  y,
  entries,
  onClose,
  anchor
}: {
  x: number
  y: number
  entries: MenuEntry[]
  onClose: () => void
  anchor?: HTMLElement | null
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState({ left: x, top: y })

  // Keep the whole menu on screen by measuring it rather than by guessing its size: it is as tall
  // as the list it was given, which for the tab list is as long as the user has tabs.
  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const fit = (wanted: number, size: number, room: number): number =>
      Math.max(EDGE_GAP, Math.min(wanted, room - size - EDGE_GAP))
    setAt({
      left: fit(x, menu.offsetWidth, window.innerWidth),
      top: fit(y, menu.offsetHeight, window.innerHeight)
    })
  }, [x, y, entries.length])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (!ref.current || ref.current.contains(target)) return
      if (anchor?.contains(target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose, anchor])

  return createPortal(
    <div
      ref={ref}
      className="ix-menu"
      style={{ left: at.left, top: at.top }}
      role="menu"
    >
      {entries.map((entry, i) =>
        isSeparator(entry) ? (
          <div key={`sep-${i}`} className="ix-menu__sep" />
        ) : (
          <button
            // Positional: two entries can legitimately carry the same label - two shell tabs
            // both start out called "Shell" - and a label key would collide between them.
            key={`item-${i}`}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            className={`ix-menu__item${entry.danger ? ' ix-menu__item--danger' : ''}`}
            onClick={() => {
              entry.onClick()
              onClose()
            }}
          >
            {entry.icon}
            <span className="ix-menu__label">{entry.label}</span>
          </button>
        )
      )}
    </div>,
    document.body
  )
}
