import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** A modal dialog: overlay + centered panel, dismissed on Escape or overlay click. */
export function Dialog({
  title,
  children,
  actions,
  onClose
}: {
  title: string
  children: ReactNode
  actions: ReactNode
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return createPortal(
    <div className="jv-overlay" onMouseDown={onClose}>
      <div className="jv-dialog" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="jv-dialog__title">{title}</h2>
        <div className="jv-dialog__body">{children}</div>
        <div className="jv-dialog__actions">{actions}</div>
      </div>
    </div>,
    document.body
  )
}
