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

  test('diacritics are matched exactly', () => {
    expect(marked('café', 'cafe')).toEqual([])
    expect(marked('cafe', 'café')).toEqual([])
    expect(marked('café', 'café')).toEqual(['café'])
  })

  test('a letter whose lowercase changes length is compared as written, keeping offsets aligned', () => {
    // 'İ' lowercases to two code units. Folding it would shift every later offset by one.
    expect(marked('İstanbul and Ankara', 'İstan ank')).toEqual(['İstan', 'Ank'])
    expect(marked('İstanbul', 'istanbul')).toEqual([])
    expect(marked('x İ Ankara', 'ank')).toEqual(['Ank'])
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
