/**
 * Search words for the daily notes, shared by the core (which turns them into an FTS5 query) and
 * the renderer (which marks them in the bodies the query returned).
 *
 * FTS5 alone decides which entries match, and it ignores case and diacritics on both sides. This
 * module only has to agree with its `unicode61 remove_diacritics 2` tokenizer closely enough that
 * the words it hands over are words the index knows, and that the marks land on the words that
 * made an entry match. Where the two still disagree - a handful of symbols SQLite's older Unicode
 * tables classify differently - the only effect is a missing or an extra mark.
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

/** The combining diacritical marks, which the index drops (`remove_diacritics 2`). */
const COMBINING = /[\u0300-\u036f]/gu
const LATIN = /^\p{Script=Latin}/u

/**
 * One code point as the index compares it: lowercase, and for a Latin letter without its accents
 * (`ř` is `r`, `é` is `e`, and `e` + U+0301 is `e` too). A combining mark folds to nothing, so a
 * decomposed accent costs no letter. Letters of other scripts keep their marks, and a stroke or
 * ligature (`ł`, `ø`, `æ`) is a letter of its own; the index treats both that way.
 */
function foldCodePoint(cp: string): string {
  const lower = cp.toLowerCase()
  if (!LATIN.test(lower)) return /^[\u0300-\u036f]$/u.test(lower) ? '' : lower
  return lower.normalize('NFD').replace(COMBINING, '').normalize('NFC')
}

/** One folded letter and the end offset, counted from the start of its word, of the text it covers. */
interface Unit {
  letter: string
  end: number
}

/**
 * A word as a list of folded letters, each remembering where it ends in the original. Folding can
 * turn one code point into none (a combining mark) or into a different number of units, so the
 * offsets are kept per letter instead of recomputed. A mark belongs to the letter before it and
 * extends that letter's range, which keeps a highlight aligned on text that mixes precomposed and
 * decomposed accents.
 */
function foldWord(word: string): Unit[] {
  const units: Unit[] = []
  let offset = 0
  for (const cp of word) {
    offset += cp.length
    const folded = foldCodePoint(cp)
    if (folded === '') {
      // A mark with no letter before it is dropped by the index as well.
      if (units.length > 0) units[units.length - 1].end = offset
      continue
    }
    for (const letter of folded) units.push({ letter, end: offset })
  }
  return units
}

/**
 * The `[start, end)` code-unit ranges of `body` to mark for these terms: for every word in the
 * body that some term starts (ignoring case and diacritics), the longest such prefix, with the
 * accents that follow its last letter. Ranges come in body order and never overlap.
 */
export function matchRanges(body: string, terms: readonly string[]): Array<[number, number]> {
  const folded = terms
    .map((term) => foldWord(term).map((u) => u.letter))
    .filter((term) => term.length > 0)
  if (folded.length === 0) return []
  const ranges: Array<[number, number]> = []
  for (const match of body.matchAll(WORD)) {
    const word = foldWord(match[0])
    let longest = 0
    for (const term of folded) {
      if (term.length > word.length) continue
      if (!term.every((letter, i) => letter === word[i].letter)) continue
      longest = Math.max(longest, word[term.length - 1].end)
    }
    if (longest > 0) ranges.push([match.index, match.index + longest])
  }
  return ranges
}
