import { rendererLogger } from '../logging/logger'
import { createStore } from '../store/createStore'

export interface Toast {
  id: number
  message: string
}

interface ToastState {
  toasts: Toast[]
  push(message: string): void
  dismiss(id: number): void
}

let seq = 0

export const useToastStore = createStore<ToastState>()((set) => ({
  toasts: [],
  push(message) {
    const id = ++seq
    set((s) => ({ toasts: [...s.toasts, { id, message }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 5000)
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  }
}))

/** Surface a failed operation to the user (and the log) instead of letting it vanish. */
export function reportError(message: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error)
  rendererLogger().child('renderer').error(message, { err: error })
  useToastStore.getState().push(detail ? `${message}: ${detail}` : message)
}
