import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import { useEffect, useRef } from 'react'
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

/** A single xterm bound to the live review session's PTY over the dedicated review channels. */
export function ReviewTerminal() {
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

    // Replay the buffered history so a remount (e.g. after a section switch) restores the full
    // scrollback, then track only the delta appended after this point.
    let offset = usePrInboxStore.getState().reviewOutput.length
    term.write(usePrInboxStore.getState().reviewOutput)
    const unsubscribe = usePrInboxStore.subscribe((state) => {
      if (state.reviewOutput.length < offset) {
        // The buffer was reset (new session); replay from the start.
        offset = 0
      }
      if (state.reviewOutput.length > offset) {
        term.write(state.reviewOutput.slice(offset))
        offset = state.reviewOutput.length
      }
    })

    const inputSub = term.onData((data) => usePrInboxStore.getState().reviewInput(data))
    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        return
      }
      usePrInboxStore.getState().reviewResize(term.cols, term.rows)
    })
    observer.observe(host)
    usePrInboxStore.getState().reviewResize(term.cols, term.rows)

    return () => {
      unsubscribe()
      inputSub.dispose()
      observer.disconnect()
      term.dispose()
    }
  }, [])

  return <div className="ix-pr-review__term" ref={hostRef} />
}
