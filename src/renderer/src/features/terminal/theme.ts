import type { ITheme } from '@xterm/xterm'

/** Graphite terminal theme aligned with the app palette; amber cursor as the signal. */
export const xtermTheme: ITheme = {
  background: '#0d1017',
  foreground: '#d7dbe3',
  cursor: '#f0a860',
  cursorAccent: '#0d1017',
  selectionBackground: '#2c3746',
  black: '#1a212b',
  red: '#e06a6a',
  green: '#8fce9b',
  yellow: '#f0c674',
  blue: '#7aa2e3',
  magenta: '#c39ac9',
  cyan: '#8bd4d0',
  white: '#c4cad4',
  brightBlack: '#5c6675',
  brightRed: '#f08a8a',
  brightGreen: '#a8e0b3',
  brightYellow: '#f4d68a',
  brightBlue: '#9cbcf0',
  brightMagenta: '#d6b6db',
  brightCyan: '#a6e2df',
  brightWhite: '#e8ebf1'
}

export const XTERM_FONT_FAMILY =
  "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace"
export const XTERM_FONT_SIZE = 12.5
export const XTERM_SCROLLBACK = 5000
