import type { SessionSummary } from '@common/domain'
import { type FuzzyMatch, fuzzyMatch, fuzzyScore } from '@renderer/shared/fuzzy'

/**
 * What a hit inside a prompt costs against the same hit in the title. A session's title is the
 * label the user recognises it by, so when both match equally well the title wins - but a
 * genuinely better hit somewhere in the conversation still comes out on top.
 *
 * Deliberately a flat cost rather than one that grows with the prompt's position: a session is
 * remembered by what was said in it, and the fortieth turn is as memorable as the first.
 */
const PROMPT_PENALTY = 5

/**
 * How well a session answers a search query: the best score its title or any single one of its
 * prompts earns. Null when the query is a subsequence of none of them, which is what excludes the
 * session from the list. Because each prompt is matched on its own, a query can never be satisfied
 * by characters picked from two different turns of the conversation.
 */
export function scoreSession(query: string, session: SessionSummary): number | null {
  const q = query.trim()
  let best = fuzzyScore(q, session.title)
  for (const prompt of session.userPrompts) {
    const score = fuzzyScore(q, prompt)
    if (score === null) continue
    const adjusted = score - PROMPT_PENALTY
    if (best === null || adjusted > best) best = adjusted
  }
  return best
}

/** A prompt chosen to represent a session in the list, with the query characters it matched. */
export interface PromptMatch {
  text: string
  indices: number[]
}

/**
 * The prompt to show as a session's one-line preview: the one the query matches best, so the row
 * shows why it survived the search. Falls back to the first prompt when the query matches none of
 * them - which happens when the session was kept on its title alone. Null when there are no
 * prompts to show at all.
 *
 * The query is trimmed exactly as the filter trims it, so a half-typed `importer ` on the way to a
 * second word still highlights the word already typed instead of dropping the highlight entirely.
 */
export function bestPromptMatch(query: string, prompts: readonly string[]): PromptMatch | null {
  if (prompts.length === 0) return null
  const q = query.trim()
  if (q === '') return { text: prompts[0], indices: [] }

  let bestText = prompts[0]
  let best: FuzzyMatch | null = null
  for (const prompt of prompts) {
    const match = fuzzyMatch(q, prompt)
    if (match === null) continue
    if (best === null || match.score > best.score) {
      best = match
      bestText = prompt
    }
  }
  return { text: bestText, indices: best?.indices ?? [] }
}
