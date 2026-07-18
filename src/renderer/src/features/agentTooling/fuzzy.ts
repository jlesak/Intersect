/**
 * Case-insensitive subsequence scorer, generalized from the command palette's matcher: a higher
 * score is a better match (contiguous runs, word-boundary starts, and earlier matches score
 * higher), and null means the query is not a subsequence of the text at all.
 */
export function scoreMatch(query: string, text: string): number | null {
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
 * Filter and rank items against a query by matching the query as a subsequence of each item's
 * searchable text (the best-scoring field wins). An empty query returns every item unchanged, in
 * its original order; ties keep original order too.
 */
export function fuzzyFilter<T>(query: string, items: T[], textOf: (item: T) => string[]): T[] {
  const trimmed = query.trim()
  if (trimmed === '') return [...items]
  return items
    .map((item) => {
      const scores = textOf(item)
        .map((text) => scoreMatch(trimmed, text))
        .filter((s): s is number => s !== null)
      return { item, score: scores.length ? Math.max(...scores) : null }
    })
    .filter((entry): entry is { item: T; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item)
}
