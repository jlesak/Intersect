import type { Command } from '@renderer/shared/registries/commandRegistry'

/**
 * Scores how well `query` matches `title` as a case-insensitive subsequence. Returns null when
 * the query is not a subsequence of the title at all. A higher score is a better match: contiguous
 * runs, matches that begin at a word boundary, and matches that start earlier all score higher.
 */
function scoreMatch(query: string, title: string): number | null {
  const q = query.toLowerCase()
  const t = title.toLowerCase()
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
 * Filters and ranks commands against a search query. An empty or whitespace-only query returns
 * every command unchanged, in the order given. Otherwise only commands whose title contains the
 * query as a subsequence survive, sorted best match first (ties keep their original order).
 */
export function filterCommands(query: string, commands: Command[]): Command[] {
  const trimmed = query.trim()
  if (trimmed === '') return [...commands]

  return commands
    .map((command) => ({ command, score: scoreMatch(trimmed, command.title) }))
    .filter((entry): entry is { command: Command; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.command)
}
