/**
 * Search words for the daily notes, shared by the core (which turns them into an FTS5 query) and
 * the renderer (which marks them in the bodies the query returned).
 *
 * FTS5 alone decides which entries match. This module only has to agree with its `unicode61`
 * tokenizer closely enough that the words it hands over are words the index knows, and that the
 * marks land on the words that made an entry match. Where the two still disagree - a handful of
 * symbols SQLite's older Unicode tables classify differently - the only effect is a missing mark.
 */

/**
 * One word: a run of letters, digits, combining marks and private-use characters, which is what
 * `unicode61` keeps inside a token. Combining marks count so a decomposed `é` stays one word.
 * Everything else, every FTS5 operator character included, separates words.
 */
const WORD = /[\p{L}\p{N}\p{M}\p{Co}]+/gu

/**
 * The words of a search input, NFC-normalized because every stored body is NFC and the index
 * compares tokens byte for byte. An input with no words means no text filter at all.
 */
export function noteSearchTerms(text: string): string[] {
  return text.normalize('NFC').match(WORD) ?? []
}

/**
 * Lowercase one code point only when its lowercase form is just as long. `İ` lowercases to two
 * code units, and folding it would shift every later offset; the index does not fold it either.
 */
function foldCodePoint(cp: string): string {
  const lower = cp.toLowerCase()
  return lower.length === cp.length ? lower : cp
}

const fold = (s: string): string[] => Array.from(s, foldCodePoint)

/**
 * The `[start, end)` code-unit ranges of `body` to mark for these terms: for every word in the
 * body that some term starts (case-insensitively), the longest such prefix. Ranges come in body
 * order and never overlap.
 */
export function matchRanges(body: string, terms: readonly string[]): Array<[number, number]> {
  if (terms.length === 0) return []
  const folded = terms.map(fold)
  const ranges: Array<[number, number]> = []
  for (const match of body.matchAll(WORD)) {
    const word = fold(match[0])
    let longest = 0
    for (const term of folded) {
      if (term.length > word.length) continue
      if (!term.every((cp, i) => cp === word[i])) continue
      // Folding never changes a code point's length, so the term's length is the body's.
      longest = Math.max(longest, term.join('').length)
    }
    if (longest > 0) ranges.push([match.index, match.index + longest])
  }
  return ranges
}
