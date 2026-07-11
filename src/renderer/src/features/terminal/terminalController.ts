import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { Preset } from '@common/domain'
import { debounce } from '@common/debounce'
import { makeSessionId } from '@common/ipc'
import { createDataRouter } from './dataRouter'
import * as ipc from './ipc'
import { XTERM_FONT_FAMILY, XTERM_FONT_SIZE, XTERM_SCROLLBACK, xtermTheme } from './theme'

// A font-size change restyles xterm instantly, but the follow-up refit + PTY winsize resize is
// coalesced: dragging the settings slider must not fire a refit/resize per step across every open
// terminal. The trailing call lands the final cols/rows once the size settles.
const FONT_SIZE_REFIT_DELAY_MS = 120

// Backpressure watermarks (bytes outstanding in xterm's write buffer). Crossing HIGH pauses the
// child pty; dropping under LOW resumes it. Keeps a firehose from hanging the renderer.
const HIGH_WATER = 200_000
const LOW_WATER = 50_000

interface View {
  term: Terminal
  fit: FitAddon
  mount: HTMLDivElement
  observer: ResizeObserver
  opened: boolean
  outstanding: number
  paused: boolean
  disposed: boolean
}

// Live xterm instances, kept alive across tab/layout switches (never rebuilt) so scrollback and
// cursor survive. Keyed by sessionId. This lives OUTSIDE React's render tree by design.
const views = new Map<string, View>()
const router = createDataRouter()

// The font size every terminal uses - the settings-driven override once set, the theme default
// until then. New terminals are created with it; setTerminalFontSize restyles the live ones.
let currentFontSize = XTERM_FONT_SIZE

/**
 * Apply a new font size to every live terminal immediately (the visible restyle is the live
 * preview), and to every terminal created from now on. The heavier refit - recomputing cols/rows
 * and pushing the PTY winsize - is debounced so a slider drag settles into a single resize per
 * terminal instead of one per step.
 */
export function setTerminalFontSize(px: number): void {
  currentFontSize = px
  for (const [, view] of views) {
    if (view.disposed) continue
    view.term.options.fontSize = px
  }
  refitForFontSize()
}

const refitForFontSize = debounce(() => {
  for (const [sessionId, view] of views) {
    if (view.disposed || !view.opened) continue
    try {
      view.fit.fit()
    } catch {
      continue
    }
    ipc.resize(sessionId, view.term.cols, view.term.rows)
  }
}, FONT_SIZE_REFIT_DELAY_MS)

// Exactly one listener per channel for the renderer's lifetime; the router demuxes by sessionId.
let wired = false
function wireOnce(): void {
  if (wired) return
  wired = true
  ipc.onData(({ sessionId, data }) => router.route({ sessionId, data }))
  ipc.onExit(({ sessionId }) => {
    const view = views.get(sessionId)
    if (view && !view.disposed) view.term.write('\r\n\x1b[2m[process exited]\x1b[0m\r\n')
  })
}

/**
 * Get or create the live terminal for a session. Registers the data sink and spawns the PTY in
 * that order (register-before-spawn) so the very first bytes - the shell prompt / Claude banner -
 * are never dropped. Safe to call repeatedly; a live session is returned as-is.
 */
export function ensureSession(
  sessionId: string,
  preset: Preset,
  cwd: string,
  resumeSessionId?: string | null
): View {
  wireOnce()
  const existing = views.get(sessionId)
  if (existing) return existing

  const term = new Terminal({
    theme: xtermTheme,
    fontFamily: XTERM_FONT_FAMILY,
    fontSize: currentFontSize,
    scrollback: XTERM_SCROLLBACK,
    cursorBlink: true,
    allowProposedApi: true
  })
  const fit = new FitAddon()
  term.loadAddon(fit)

  const mount = document.createElement('div')
  mount.className = 'ix-pane__mount'

  const view: View = {
    term,
    fit,
    mount,
    opened: false,
    outstanding: 0,
    paused: false,
    disposed: false,
    observer: new ResizeObserver(() => {
      if (!view.opened || view.disposed) return
      try {
        fit.fit()
      } catch {
        return
      }
      ipc.resize(sessionId, term.cols, term.rows)
    })
  }
  views.set(sessionId, view)

  // Register the sink BEFORE spawning; xterm buffers writes until open().
  router.register(sessionId, (data) => {
    view.outstanding += data.length
    if (!view.paused && view.outstanding > HIGH_WATER) {
      view.paused = true
      ipc.pause(sessionId)
    }
    view.term.write(data, () => {
      view.outstanding -= data.length
      if (view.paused && view.outstanding < LOW_WATER) {
        view.paused = false
        ipc.resume(sessionId)
      }
    })
  })

  term.onData((data) => ipc.write(sessionId, data))

  void ipc.spawn(sessionId, preset, cwd, term.cols, term.rows, resumeSessionId)
  return view
}

/** Attach a session's terminal into a visible pane host (imperative DOM move; never remounts). */
export function attachSession(sessionId: string, host: HTMLElement): void {
  const view = views.get(sessionId)
  if (!view || view.disposed) return
  host.appendChild(view.mount)
  if (!view.opened) {
    view.term.open(view.mount)
    view.opened = true
    view.observer.observe(view.mount)
  }
  view.fit.fit()
  requestAnimationFrame(() => {
    if (view.disposed) return
    try {
      view.fit.fit()
      ipc.resize(sessionId, view.term.cols, view.term.rows)
      view.term.focus()
    } catch {
      /* container not laid out yet */
    }
  })
}

/** Detach a session from its pane without destroying it (keeps scrollback alive). */
export function detachSession(sessionId: string): void {
  views.get(sessionId)?.mount.remove()
}

/** Fully tear down a session: dispose xterm, stop observing, and kill the PTY. */
export function disposeSession(sessionId: string): void {
  const view = views.get(sessionId)
  if (!view) return
  view.disposed = true
  router.dispose(sessionId)
  view.observer.disconnect()
  view.mount.remove()
  view.term.dispose()
  views.delete(sessionId)
  ipc.kill(sessionId)
}

/** Dispose every session belonging to a workspace (used when a workspace is deleted). */
export function disposeWorkspaceSessions(workspaceId: string): void {
  const prefix = `${workspaceId}:`
  for (const sessionId of [...views.keys()]) {
    if (sessionId.startsWith(prefix)) disposeSession(sessionId)
  }
}

export { makeSessionId }
