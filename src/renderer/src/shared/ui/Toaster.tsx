import { createPortal } from 'react-dom'
import { useToastStore } from './toast'

/** Renders transient error toasts. Click to dismiss; each auto-dismisses after a few seconds. */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)
  if (toasts.length === 0) return null
  return createPortal(
    <div className="jv-toaster">
      {toasts.map((t) => (
        <button key={t.id} type="button" className="jv-toast" onClick={() => dismiss(t.id)}>
          {t.message}
        </button>
      ))}
    </div>,
    document.body
  )
}
