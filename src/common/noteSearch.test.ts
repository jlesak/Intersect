import { describe, expect, test } from 'vitest'
import { matchRanges, noteSearchTerms } from './noteSearch'

/** The highlighted slices of a body, which is what the user sees marked. */
const marked = (body: string, query: string): string[] =>
  matchRanges(body, noteSearchTerms(query)).map(([start, end]) => body.slice(start, end))

describe('noteSearchTerms', () => {
  test('splits the input into words', () => {
    expect(noteSearchTerms('call  Bob\tabout\nthe cache')).toEqual([
      'call',
      'Bob',
      'about',
      'the',
      'cache'
    ])
  })

  test('input with no words means no text filter', () => {
    expect(noteSearchTerms('')).toEqual([])
    expect(noteSearchTerms('   ')).toEqual([])
    expect(noteSearchTerms('"*-:()^+')).toEqual([])
  })

  test('every FTS5 operator character separates words, so none can reach the query', () => {
    expect(noteSearchTerms('"cache"* -foo title:bar (baz) ^qux +x')).toEqual([
      'cache',
      'foo',
      'title',
      'bar',
      'baz',
      'qux',
      'x'
    ])
    for (const term of noteSearchTerms('a"b*c-d:e(f)g^h+i')) expect(term).toMatch(/^\p{L}+$/u)
  })

  test('keeps letters, digits and combining marks together, as the index tokenizer does', () => {
    expect(noteSearchTerms('řešení x²y abc123')).toEqual(['řešení', 'x²y', 'abc123'])
    // Apostrophes and underscores split words in the index too.
    expect(noteSearchTerms("it's snake_case")).toEqual(['it', 's', 'snake', 'case'])
  })

  test('a combining mark with no precomposed form stays inside its word, as in the index', () => {
    // NFC cannot compose q + U+0301, so the mark stays a separate code point; the index still
    // treats "q́uota" as one token, so the search must not split it into "q" and "uota".
    expect(noteSearchTerms('plan q́uota')).toEqual(['plan', 'q́uota'])
  })

  test('normalizes to NFC, the form every stored body has', () => {
    expect(noteSearchTerms('café')).toEqual(['café'])
  })
})

describe('matchRanges', () => {
  test('marks the matched prefix of a word', () => {
    expect(marked('Call Bob about the cache', 'cach')).toEqual(['cach'])
    expect(matchRanges('the cache', ['cach'])).toEqual([[4, 8]])
  })

  test('matches only at the start of a word', () => {
    expect(marked('the cache', 'ache')).toEqual([])
  })

  test('ignores case on both sides', () => {
    expect(marked('CACHE and Cache', 'cAcH')).toEqual(['CACH', 'Cach'])
    expect(marked('ŘEŠENÍ', 'řeš')).toEqual(['ŘEŠ'])
  })

  test('marks every word that any term starts', () => {
    expect(marked('Bob said the cache is broken, Bob', 'bob cache')).toEqual([
      'Bob',
      'cache',
      'Bob'
    ])
  })

  test('marks the longest prefix when several terms start the same word', () => {
    expect(marked('the cache', 'ca cach')).toEqual(['cach'])
  })

  test('finds words after punctuation and line breaks', () => {
    expect(marked('(cache)\nfoo-cache x"cache"', 'cache')).toEqual(['cache', 'cache', 'cache'])
  })

  test('no terms means no marks', () => {
    expect(matchRanges('the cache', [])).toEqual([])
  })

  test('a term longer than the word does not match it', () => {
    expect(marked('cache', 'caches')).toEqual([])
  })

  test('diacritics are ignored in both directions, and the mark covers the stored accents', () => {
    expect(marked('café', 'cafe')).toEqual(['café'])
    expect(marked('cafe', 'café')).toEqual(['cafe'])
    expect(marked('café', 'café')).toEqual(['café'])
    expect(marked('Příliš žluťoučký kůň', 'pril')).toEqual(['Příl'])
    expect(marked('Příliš žluťoučký kůň', 'PRILIS')).toEqual(['Příliš'])
    expect(marked('Příliš žluťoučký kůň', 'přílíš')).toEqual(['Příliš'])
    expect(marked('Příliš žluťoučký kůň', 'zlut')).toEqual(['žluť'])
    expect(marked('prilis zlutoucky', 'příl')).toEqual(['pril'])
  })

  test('word-start matching is unchanged by folding', () => {
    expect(marked('příliš', 'rilis')).toEqual([])
    expect(marked('příliš', 'ilis')).toEqual([])
  })

  test('only diacritics fold: a different letter stays different', () => {
    // A stroke or a ligature is a letter of its own, not an accent, and the index keeps it apart.
    expect(marked('Łódź', 'lodz')).toEqual([])
  })

  test('text mixing precomposed and decomposed accents is marked at the right offsets', () => {
    // "í" and "š" are decomposed (i + U+0301, s + U+030C); "ř" is precomposed.
    const body = 'x Pri\u0301lis\u030C \u0159eka cafe\u0301 end'
    expect(marked(body, 'pril')).toEqual(['Pri\u0301l'])
    // The accent that follows the last matched letter belongs to it.
    expect(marked(body, 'pri')).toEqual(['Pri\u0301'])
    expect(marked(body, 'prilis')).toEqual(['Pri\u0301lis\u030C'])
    expect(marked(body, 'reka')).toEqual(['\u0159eka'])
    expect(marked(body, 'cafe')).toEqual(['cafe\u0301'])
    expect(marked(body, 'café')).toEqual(['cafe\u0301'])
    expect(marked('caf\u00e9 and cafe\u0301', 'cafe')).toEqual(['caf\u00e9', 'cafe\u0301'])
    expect(matchRanges('ab cafe\u0301', ['cafe'])).toEqual([[3, 8]])
  })

  test('a stray combining mark does not shift later ranges and is no term', () => {
    expect(marked('\u0301abc def', 'def')).toEqual(['def'])
    expect(marked('abc', '\u0301')).toEqual([])
    expect(matchRanges('abc', ['\u0301'])).toEqual([])
  })

  test('a letter that lowercases to several code units keeps offsets aligned', () => {
    // 'İ' lowercases to i + U+0307; the index folds it to a plain i.
    expect(marked('İstanbul and Ankara', 'istan ank')).toEqual(['İstan', 'Ank'])
    expect(marked('x İ Ankara', 'ank')).toEqual(['Ank'])
  })

  test('letters outside the Latin script keep their accents, as the index keeps them', () => {
    expect(marked('й и', 'и')).toEqual(['и'])
    expect(marked('άλφα', 'αλφα')).toEqual([])
  })

  test('a word with a combining mark is matched from its start only', () => {
    expect(marked('plan q́uota', 'q́uo')).toEqual(['q́uo'])
    // "uota" begins after the mark, inside the word: the index does not match it, so nor do marks.
    expect(marked('plan q́uota', 'uota')).toEqual([])
  })

  test('astral letters keep their offsets', () => {
    expect(marked('𝐀bc 𝐀xy', '𝐀x')).toEqual(['𝐀x'])
  })
})
