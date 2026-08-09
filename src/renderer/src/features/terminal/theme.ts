import type { ISearchOptions } from '@xterm/addon-search'
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

/**
 * How a search paints its findings. Every match is marked quietly enough to stay readable as
 * terminal output; the one the user is standing on takes the cyan signal, so stepping through
 * matches is visible without reading the count.
 */
export const XTERM_SEARCH_DECORATIONS: NonNullable<ISearchOptions['decorations']> = {
  matchBackground: '#3d4b61',
  matchBorder: '#4a5a72',
  matchOverviewRuler: '#7d89a0',
  activeMatchBackground: '#4cc9e8',
  activeMatchBorder: '#72d6ef',
  activeMatchColorOverviewRuler: '#4cc9e8'
}

export const XTERM_FONT_FAMILY =
  "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace"
export const XTERM_FONT_SIZE = 12.5
export const XTERM_SCROLLBACK = 5000
