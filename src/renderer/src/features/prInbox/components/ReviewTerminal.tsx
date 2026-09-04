import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import { useEffect, useRef } from 'react'
import { onReviewOutput, readReviewOutput } from '../reviewOutput'
import { usePrInboxStore } from '../store'

// The review terminal is deliberately isolated from the terminal slice: its own xterm instance
// bound to the dedicated `prInbox:review*` channels. The theme mirrors the terminal slice's
// slate palette (copied, not imported, so this slice stays self-contained).
const REVIEW_THEME: ITheme = {
  background: '#171d28',
  foreground: '#edf1f7',
  cursor: '#4cc9e8',
  cursorAccent: '#171d28',
  selectionBackground: '#244858',
  black: '#1d2532',
  red: '#e06a6a',
  green: '#8fce9b',
  yellow: '#f0c674',
  blue: '#7aa2e3',
  magenta: '#c39ac9',
  cyan: '#8bd4d0',
  white: '#c4cad4',
  brightBlack: '#7d89a0',
  brightRed: '#f08a8a',
  brightGreen: '#a8e0b3',
  brightYellow: '#f4d68a',
  brightBlue: '#9cbcf0',
  brightMagenta: '#d6b6db',
  brightCyan: '#a6e2df',
  brightWhite: '#f4f7fb'
}

const FONT_FAMILY = "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace"

/**
 * A single xterm bound to one live review session's PTY over the dedicated review channels.
 *
 * Several reviews can run at once, so everything here is addressed by `sessionId`: the buffer it
 * replays, the input it sends, and the size it reports. Mount this keyed by the session id, so
 * switching pull requests builds a new terminal rather than reusing one bound elsewhere.
 */
export function ReviewTerminal({ sessionId }: { sessionId: string }) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      theme: REVIEW_THEME,
      fontFamily: FONT_FAMILY,
      fontSize: 12.5,
      scrollback: 5000,
      cursorBlink: true,
      allowProposedApi: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()

    // Replay this session's buffered history so a remount (e.g. after a section switch) restores
    // the scrollback, then render only what is appended after that point. The cursor counts every
    // character the session ever produced, not the buffer's length: the buffer keeps a bounded
    // tail, and a length cursor would rewind on each trim and replay the tail again.
    const replayed = readReviewOutput(sessionId)
    term.write(replayed.text)
    let written = replayed.written
    const unsubscribe = onReviewOutput(sessionId, (data, total) => {
      // A chunk that arrived between the read above and this subscription is covered by `written`.
      if (total <= written) return
      term.write(data)
      written = total
    })

    const inputSub = term.onData((data) => usePrInboxStore.getState().reviewInput(sessionId, data))
    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        return
      }
      usePrInboxStore.getState().reviewResize(sessionId, term.cols, term.rows)
    })
    observer.observe(host)
    usePrInboxStore.getState().reviewResize(sessionId, term.cols, term.rows)

    return () => {
      unsubscribe()
      inputSub.dispose()
      observer.disconnect()
      term.dispose()
    }
  }, [sessionId])

  return <div className="ix-pr-review__term" ref={hostRef} />
}
