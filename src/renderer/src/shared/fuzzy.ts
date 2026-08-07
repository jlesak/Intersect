/**
 * The app-wide fuzzy matcher. Every surface that lets the user narrow a long list by typing -
 * the command palette, the session history, the boards - ranks with this, so a query behaves the
 * same wherever it is typed.
 */

/**
 * Scores how well `query` matches `text` as a case-insensitive subsequence. Returns null when the
 * query is not a subsequence of the text at all. A higher score is a better match: contiguous
 * runs, matches that begin at a word boundary, and matches that start earlier all score higher.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let qi = 0
  let score = 0
  let prevMatch = -2
  let firstMatch = -1

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue
    if (firstMatch === -1) firstMatch = ti
    if (ti === prevMatch + 1) score += 10
    const prevChar = ti > 0 ? t[ti - 1] : ' '
    if (!/[a-z0-9]/.test(prevChar)) score += 8
    prevMatch = ti
    qi++
  }

  if (qi < q.length) return null
  score += Math.max(0, 20 - firstMatch)
  return score
}

/**
 * What a hit costs for each field it sits past the first. Small enough that a genuinely better
 * match in a later field still wins, large enough to break a tie in favour of the field the
 * caller listed first - which is the one the user was most likely aiming at.
 */
const LATER_FIELD_PENALTY = 5

/**
 * The best score any of an item's fields gives the query, or null when none of them match.
 * Fields are read in the caller's priority order: the same hit is worth slightly less the further
 * down the list it was found.
 */
function bestFieldScore(query: string, texts: readonly string[]): number | null {
  let best: number | null = null
  for (let i = 0; i < texts.length; i++) {
    const raw = fuzzyScore(query, texts[i])
    if (raw === null) continue
    const adjusted = raw - i * LATER_FIELD_PENALTY
    if (best === null || adjusted > best) best = adjusted
  }
  return best
}

/**
 * Filters and ranks items against a search query, matching each item against the strings
 * `textOf` returns for it in priority order. An empty or whitespace-only query returns every item
 * unchanged, in the order given. Otherwise only items at least one of whose fields contains the
 * query as a subsequence survive, sorted best match first; ties keep the caller's order.
 */
export function fuzzyFilter<T>(
  query: string,
  items: readonly T[],
  textOf: (item: T) => readonly string[]
): T[] {
  const trimmed = query.trim()
  if (trimmed === '') return [...items]

  return items
    .map((item, index) => ({ item, index, score: bestFieldScore(trimmed, textOf(item)) }))
    .filter((entry): entry is { item: T; index: number; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item)
}
