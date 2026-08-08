import { describe, expect, test } from 'vitest'
import { fuzzyFilter, fuzzyMatch, fuzzyScore } from './fuzzy'

describe('fuzzyMatch', () => {
  test('reports where each query character landed', () => {
    expect(fuzzyMatch('nsh', 'New Shell Tab')?.indices).toEqual([0, 4, 5])
  })

  test('reports the same score fuzzyScore does', () => {
    expect(fuzzyMatch('nsh', 'New Shell Tab')?.score).toBe(fuzzyScore('nsh', 'New Shell Tab'))
  })

  test('a non-subsequence has no match at all', () => {
    expect(fuzzyMatch('zzz', 'New Shell Tab')).toBeNull()
  })

  test('the empty query matches with no highlighted characters', () => {
    expect(fuzzyMatch('', 'anything')?.indices).toEqual([])
  })

  test('each query character consumes its own position, left to right', () => {
    // The second "a" must come after the "n" it follows, not reuse the one before it.
    expect(fuzzyMatch('ana', 'banana')?.indices).toEqual([1, 2, 3])
  })

  test('a stray earlier character does not drag the match off the word the user typed', () => {
    // The leading "o" of "Lock" is available, but spending it there scatters the rest.
    expect(fuzzyMatch('owner', 'Lock owner')?.indices).toEqual([5, 6, 7, 8, 9])
  })

  test('the whole-word placement only wins when it actually scores better', () => {
    // "ab" is contiguous at the end, but the scattered match starts at the very beginning and at
    // two word boundaries, which is the stronger read of the text.
    expect(fuzzyMatch('ab', 'a b ab')?.indices).toEqual([0, 2])
  })
})

describe('fuzzyScore', () => {
  test('scores a case-insensitive subsequence and rejects a non-subsequence', () => {
    expect(fuzzyScore('nsh', 'New Shell Tab')).not.toBeNull()
    expect(fuzzyScore('NSH', 'New Shell Tab')).not.toBeNull()
    expect(fuzzyScore('zzz', 'New Shell Tab')).toBeNull()
  })

  test('a query longer than the text can never match', () => {
    expect(fuzzyScore('newshelltabextra', 'New Shell Tab')).toBeNull()
  })

  test('a contiguous run scores above the same characters scattered', () => {
    const contiguous = fuzzyScore('layo', 'Layout: Single')!
    const scattered = fuzzyScore('layo', 'Layer Cake Tool')!
    expect(contiguous).toBeGreaterThan(scattered)
  })

  test('an earlier match scores above a later one', () => {
    expect(fuzzyScore('tab', 'Tab New')!).toBeGreaterThan(fuzzyScore('tab', 'New Tab')!)
  })

  test('the empty query matches anything with the same score', () => {
    expect(fuzzyScore('', 'anything')).toBe(fuzzyScore('', 'other'))
  })
})

interface Row {
  title: string
  aliases: string[]
}

const rows: Row[] = [
  { title: 'Add Workspace', aliases: ['folder', 'project'] },
  { title: 'New Shell Tab', aliases: ['bash', 'zsh', 'terminal'] },
  { title: 'Layout: 2×2 Grid', aliases: ['split'] }
]

const fields = (row: Row): string[] => [row.title, ...row.aliases]
const titles = (result: Row[]): string[] => result.map((r) => r.title)

describe('fuzzyFilter', () => {
  test('an empty query returns every item in the given order', () => {
    expect(fuzzyFilter('', rows, fields)).toEqual(rows)
  })

  test('a whitespace-only query is treated as empty', () => {
    expect(fuzzyFilter('   ', rows, fields)).toEqual(rows)
  })

  test('matches on a secondary field, not only the first', () => {
    expect(titles(fuzzyFilter('bash', rows, fields))).toEqual(['New Shell Tab'])
    expect(titles(fuzzyFilter('split', rows, fields))).toEqual(['Layout: 2×2 Grid'])
  })

  test('drops items no field matches', () => {
    expect(fuzzyFilter('qqq', rows, fields)).toEqual([])
  })

  test('an equally good hit in an earlier field outranks one in a later field', () => {
    // "term" starts both, so the two hits are identical in contiguity and position; only which
    // field carried them differs.
    const items = [
      { title: 'Nothing At All', aliases: ['terminal'] },
      { title: 'Terminal Bell', aliases: ['nothing'] }
    ]
    expect(titles(fuzzyFilter('term', items, fields))).toEqual(['Terminal Bell', 'Nothing At All'])
  })

  test('a strong hit in a later field still outranks a weak hit in the first', () => {
    const items = [
      { title: 'Layer Cake Tool', aliases: [] },
      { title: 'Nothing At All', aliases: ['Layout'] }
    ]
    // "layo" is contiguous from position 0 in the alias, and scattered in the first title.
    expect(titles(fuzzyFilter('layo', items, fields))).toEqual([
      'Nothing At All',
      'Layer Cake Tool'
    ])
  })

  test('ties keep the caller order', () => {
    const items = [
      { title: 'Same Name', aliases: [] },
      { title: 'Same Name', aliases: [] }
    ]
    const result = fuzzyFilter('same', items, fields)
    expect(result[0]).toBe(items[0])
    expect(result[1]).toBe(items[1])
  })

  test('does not mutate the input array', () => {
    const input = [...rows]
    fuzzyFilter('new', input, fields)
    expect(input).toEqual(rows)
  })

  test('ignores an empty field rather than counting it as a match', () => {
    const items = [{ title: '', aliases: [''] }]
    expect(fuzzyFilter('a', items, fields)).toEqual([])
  })
})
