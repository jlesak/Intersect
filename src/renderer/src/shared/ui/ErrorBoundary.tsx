import { Component, type ErrorInfo, type ReactNode } from 'react'
import { rendererLogger } from '../logging/logger'

/**
 * The message every caught renderer crash is logged under. Stable on purpose: it is the one string
 * to group the log by when a user reports a blank surface, and the record carries the component
 * stack that names the feature at fault.
 */
export const RENDERER_CRASH_LOG_MESSAGE = 'error boundary caught a failure'

/**
 * How far the failure reaches, and what the surface may offer as a way on.
 *
 * `window` is the last resort around the whole tree: nothing outside it survived, so rebuilding
 * the renderer is all that is left to offer. `region` contains the failure to one content area,
 * whether that area is the shell's main slot or a pane nested well inside one, leaving everything
 * around it alive so the user can navigate elsewhere.
 *
 * A region boundary can be mounted anywhere and from the inside can see none of what surrounds it,
 * so `recovery` is the caller's to supply: one sentence naming the navigation still live beside
 * this particular boundary. Leaving it out falls back to a line that holds at any mount point.
 */
type ErrorBoundaryProps =
  | { scope: 'window'; children: ReactNode }
  | { scope: 'region'; recovery?: string; children: ReactNode }

interface ErrorBoundaryState {
  /**
   * Whether a failure was caught, tracked separately from the value: a child may throw anything at
   * all, including `null` or `undefined`, and the caught flag must never depend on it being truthy.
   */
  hasError: boolean
  error: unknown
}

/**
 * The one line quoted to the user, or empty when the thrown value carries nothing worth showing.
 * Anything can be thrown, so an Error's message is only the most likely case.
 */
function crashReason(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return ''
}

/**
 * Catches a render, lifecycle or constructor failure in its subtree and shows a recoverable
 * failure surface instead of letting React unmount the tree into a blank window. Retrying
 * re-mounts the subtree from scratch, which is enough whenever the cause was transient state.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Keep the component stack attached: without it a minified production error names no feature
    // at all, and the scope says how much of the window the failure took with it.
    rendererLogger().child('renderer').error(RENDERER_CRASH_LOG_MESSAGE, {
      data: { scope: this.props.scope, componentStack: info.componentStack },
      err: error
    })
  }

  private readonly retry = (): void => {
    this.setState({ hasError: false, error: null })
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children
    const reason = crashReason(this.state.error)
    const props = this.props
    return props.scope === 'window' ? (
      <WindowCrash reason={reason} onRetry={this.retry} />
    ) : (
      <RegionCrash reason={reason} recovery={props.recovery} onRetry={this.retry} />
    )
  }
}

/**
 * The whole-window failure surface: the app shell itself is gone, so all this can offer is a retry
 * and a reload. Both re-render from the state that was already loaded, so neither is promised as a
 * cure - a failure caused by that state comes straight back.
 */
function WindowCrash({ reason, onRetry }: { reason: string; onRetry: () => void }) {
  return (
    <div className="ix-crash ix-crash--window" role="alertdialog" aria-modal="true">
      <div className="ix-crash__card">
        <h1>Intersect could not render</h1>
        <p>
          An unexpected error took down the interface. Nothing on disk was touched and running
          terminals keep running.
        </p>
        <p>
          Reloading or retrying rebuilds the window from the same saved state, so it helps only if
          the failure was transient. If it comes straight back, that state is the cause.
        </p>
        {reason && <p className="ix-crash__reason">{reason}</p>}
        <div className="ix-crash__actions">
          <button type="button" className="ix-btn ix-btn--primary" onClick={() => location.reload()}>
            Reload
          </button>
          <button type="button" className="ix-btn" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The recovery line a region boundary falls back on when its caller named nothing. It has to hold
 * wherever a boundary is mounted, so it points at no navigation of its own: a caller who forgets
 * the prop then costs the user some vagueness, and can never send them somewhere that is not there.
 */
const DEFAULT_REGION_RECOVERY =
  'The failure stopped at this view, so everything around it is still working. Retry it, or come back to it later.'

/**
 * The contained failure surface for one region. It fills the slot it was mounted into and centres
 * the card there, so it reads the same whether it stands in for the shell's whole main area or for
 * a single pane nested inside one. Everything around it stays usable, and the recovery line says
 * which piece of that surviving navigation to reach for.
 */
function RegionCrash({
  reason,
  recovery = DEFAULT_REGION_RECOVERY,
  onRetry
}: {
  reason: string
  recovery?: string
  onRetry: () => void
}) {
  return (
    <div className="ix-crash ix-crash--region" role="alert">
      <div className="ix-crash__card">
        <h1>This view could not render</h1>
        <p>{recovery}</p>
        {reason && <p className="ix-crash__reason">{reason}</p>}
        <div className="ix-crash__actions">
          <button type="button" className="ix-btn ix-btn--primary" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    </div>
  )
}
