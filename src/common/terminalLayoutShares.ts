import type { Layout } from './domain'

/**
 * Pane-share model for the resizable terminal layouts. Shares are percentages of the stage
 * that always sum to exactly 100, with no pane below the 10% minimum, so a persisted value
 * can be fed straight into the panel library as a default layout.
 *
 * The grid's ratio model is deliberately simple: one column split shared by both rows
 * (a single full-height divider), plus an independent row split inside each column half.
 * `columns` divides the stage into left/right, `leftRows` splits the left half between the
 * top-left and bottom-left panes, and `rightRows` splits the right half between the
 * top-right and bottom-right panes.
 */
export type PairShares = [number, number]

export interface GridShares {
  columns: PairShares
  leftRows: PairShares
  rightRows: PairShares
}

export type LayoutShares = PairShares | GridShares

/** The layouts that carry a persisted ratio; `single` has exactly one pane and none. */
export const RESIZABLE_LAYOUTS = ['columns', 'rows', 'grid'] as const
export type ResizableLayout = (typeof RESIZABLE_LAYOUTS)[number]

/** All persisted shares of one project key, absent layouts falling back to equal shares. */
export interface TerminalLayoutSharesMap {
  columns?: PairShares
  rows?: PairShares
  grid?: GridShares
}

export function isResizableLayout(layout: Layout | string): layout is ResizableLayout {
  return (RESIZABLE_LAYOUTS as readonly string[]).includes(layout)
}

/** The smallest share any pane may hold, as a percentage of its group. */
export const MIN_SHARE = 10

const EQUAL_PAIR: PairShares = [50, 50]

const round4 = (n: number): number => Number(n.toFixed(4))

/** The neutral default: every pane in the layout gets an equal cut. */
export function equalShares(layout: 'columns' | 'rows'): PairShares
export function equalShares(layout: 'grid'): GridShares
export function equalShares(layout: ResizableLayout): LayoutShares
export function equalShares(layout: ResizableLayout): LayoutShares {
  if (layout === 'grid') {
    return { columns: [...EQUAL_PAIR], leftRows: [...EQUAL_PAIR], rightRows: [...EQUAL_PAIR] }
  }
  return [...EQUAL_PAIR]
}

/**
 * The valid form of one two-pane split: both entries finite and positive, scaled to sum
 * exactly 100 (the second share absorbs the rounding remainder), and clamped so neither
 * pane falls under the 10% minimum. Anything absent, corrupt, or incompatible collapses
 * to equal shares.
 */
function normalizePair(value: unknown): PairShares {
  if (!Array.isArray(value) || value.length !== 2) return [...EQUAL_PAIR]
  const [a, b] = value as unknown[]
  if (typeof a !== 'number' || typeof b !== 'number') return [...EQUAL_PAIR]
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return [...EQUAL_PAIR]
  let first = (a / (a + b)) * 100
  if (first < MIN_SHARE) first = MIN_SHARE
  if (first > 100 - MIN_SHARE) first = 100 - MIN_SHARE
  first = round4(first)
  return [first, round4(100 - first)]
}

/**
 * The valid form of any persisted or incoming shares value for the layout. Every read and
 * every write goes through this, so corrupt rows, foreign shapes (a pair stored under grid
 * or vice versa), and out-of-range numbers degrade to a safe layout instead of failing.
 */
export function normalizeShares(layout: 'columns' | 'rows', value: unknown): PairShares
export function normalizeShares(layout: 'grid', value: unknown): GridShares
export function normalizeShares(layout: ResizableLayout, value: unknown): LayoutShares
export function normalizeShares(layout: ResizableLayout, value: unknown): LayoutShares {
  if (layout === 'grid') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return equalShares('grid')
    }
    const record = value as Record<string, unknown>
    return {
      columns: normalizePair(record.columns),
      leftRows: normalizePair(record.leftRows),
      rightRows: normalizePair(record.rightRows)
    }
  }
  return normalizePair(value)
}

/**
 * Whether two share values describe the same split within the given percentage tolerance.
 * Used to drop echo updates (the panel library re-reports the layout it was mounted with)
 * so they never schedule a redundant persistence write.
 */
export function sharesEqual(a: LayoutShares, b: LayoutShares, epsilon = 0.01): boolean {
  const pairEqual = (x: PairShares, y: PairShares): boolean =>
    Math.abs(x[0] - y[0]) <= epsilon && Math.abs(x[1] - y[1]) <= epsilon
  if (Array.isArray(a) && Array.isArray(b)) return pairEqual(a, b)
  if (!Array.isArray(a) && !Array.isArray(b)) {
    return (
      pairEqual(a.columns, b.columns) &&
      pairEqual(a.leftRows, b.leftRows) &&
      pairEqual(a.rightRows, b.rightRows)
    )
  }
  return false
}
