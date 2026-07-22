import type { ITheme } from '@xterm/xterm'

/** Slate terminal theme aligned with the app palette; cyan cursor as the signal. */
export const xtermTheme: ITheme = {
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

export const XTERM_FONT_FAMILY =
  "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace"
export const XTERM_FONT_SIZE = 12.5
export const XTERM_SCROLLBACK = 5000
