import { useEffect, useRef, type ReactNode } from 'react'
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

/** A context menu anchored at a viewport point, dismissed on outside click or Escape. */
export function ContextMenu({
  x,
  y,
  entries,
  onClose
}: {
  x: number
  y: number
  entries: MenuEntry[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
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
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      className="jv-menu"
      style={{ left: Math.min(x, window.innerWidth - 200), top: Math.min(y, window.innerHeight - 260) }}
      role="menu"
    >
      {entries.map((entry, i) =>
        isSeparator(entry) ? (
          <div key={`sep-${i}`} className="jv-menu__sep" />
        ) : (
          <button
            key={entry.label}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            className={`jv-menu__item${entry.danger ? ' jv-menu__item--danger' : ''}`}
            onClick={() => {
              entry.onClick()
              onClose()
            }}
          >
            {entry.icon}
            {entry.label}
          </button>
        )
      )}
    </div>,
    document.body
  )
}
