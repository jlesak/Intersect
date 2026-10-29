import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import type { NoteQuery } from '@common/domain'
import { matchRanges, noteSearchTerms } from '@common/noteSearch'
import { dayKeyOf } from '@common/week'
import { createNoteRepo, type NoteRepo } from './noteRepo'
import { makeTestDb } from './testkit'

/**
 * Pin a time zone far from UTC, so a day key computed in UTC instead of local time gives a
 * different answer and fails. Vitest runs each file in its own worker process, where a runtime
 * change of TZ takes effect and leaks into no other file.
 */
const previousTz = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'Pacific/Kiritimati'
})
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ
  else process.env.TZ = previousTz
})

/** A repo whose clock the test sets, with predictable ids. */
function makeRepo(db: DatabaseSync): { repo: NoteRepo; at(ms: number): void } {
  let clock = new Date(2026, 2, 2, 9, 0).getTime()
  let ids = 0
  const repo = createNoteRepo(db, { now: () => clock, newId: () => `n-${++ids}` })
  return {
    repo,
    at(ms) {
      clock = ms
    }
  }
}

const q = (over: Partial<NoteQuery> = {}): NoteQuery => ({
  text: '',
  from: null,
  to: null,
  before: null,
  dayLimit: null,
  ...over
})

/** The bodies a query returns, flattened in the order the user reads them. */
const bodies = (repo: NoteRepo, query: Partial<NoteQuery>): string[] =>
  repo.list(q(query)).flatMap((d) => d.entries.map((e) => e.body))

/** Capture one entry on each given local day (at noon), in the order given. */
function seedDays(env: ReturnType<typeof makeRepo>, entries: [string, string][]): void {
  for (const [day, body] of entries) {
    const [y, m, d] = day.split('-').map(Number)
    env.at(new Date(y, m - 1, d, 12).getTime())
    env.repo.create(body)
  }
}

let db: DatabaseSync
let env: ReturnType<typeof makeRepo>

beforeEach(() => {
  db = makeTestDb()
  env = makeRepo(db)
})

describe('create', () => {
  test('stamps the local day and capture time and returns the entry', () => {
    const at = new Date(2026, 2, 2, 9, 15).getTime()
    env.at(at)
    const entry = env.repo.create('Call Bob about the cache')
    expect(entry).toEqual({
      id: 'n-1',
      day: '2026-03-02',
      body: 'Call Bob about the cache',
      createdAt: at,
      updatedAt: at
    })
  })

  test('a capture just before and just after local midnight lands on different days', () => {
    // Guard the guard: a TZ that did not take would make this test pass for a UTC implementation.
    expect(new Date(2026, 2, 2, 0, 30).getTimezoneOffset()).toBe(-840)

    env.at(new Date(2026, 2, 1, 23, 59).getTime())
    expect(env.repo.create('late').day).toBe('2026-03-01')
    env.at(new Date(2026, 2, 2, 0, 30).getTime())
    expect(env.repo.create('early').day).toBe('2026-03-02')

    expect(env.repo.list(q()).map((d) => d.day)).toEqual(['2026-03-02', '2026-03-01'])
  })

  test('trims outer whitespace and keeps the line breaks inside', () => {
    expect(env.repo.create('  \n first line\n\n  second line \n').body).toBe(
      'first line\n\n  second line'
    )
  })

  test('rejects a body with nothing but whitespace', () => {
    expect(() => env.repo.create('')).toThrow(/must not be empty/i)
    expect(() => env.repo.create(' \n\t ')).toThrow(/must not be empty/i)
    expect(env.repo.list(q())).toEqual([])
  })

  test('stores the body NFC-normalized', () => {
    expect(env.repo.create('café').body).toBe('café')
  })
})

describe('update', () => {
  test('replaces the body and keeps the day and the capture time', () => {
    env.at(new Date(2026, 2, 1, 23, 59).getTime())
    const entry = env.repo.create('draft')
    const later = new Date(2026, 2, 3, 8, 0).getTime()
    env.at(later)

    const updated = env.repo.update(entry.id, '  final\ntext  ')

    expect(updated).toEqual({ ...entry, body: 'final\ntext', updatedAt: later })
    expect(env.repo.list(q())).toEqual([{ day: '2026-03-01', entries: [updated] }])
  })

  test('rejects an empty body and an unknown id, leaving the entry as it was', () => {
    const entry = env.repo.create('keep')
    expect(() => env.repo.update(entry.id, '   ')).toThrow(/must not be empty/i)
    expect(() => env.repo.update('missing', 'x')).toThrow(/not found/i)
    expect(bodies(env.repo, {})).toEqual(['keep'])
  })

  test('the new text is what search finds', () => {
    const entry = env.repo.create('lunch')
    env.repo.update(entry.id, 'cache')
    expect(bodies(env.repo, { text: 'cache' })).toEqual(['cache'])
    expect(bodies(env.repo, { text: 'lunch' })).toEqual([])
  })
})

describe('remove', () => {
  test('deletes the entry, and search no longer finds it', () => {
    const a = env.repo.create('cache one')
    env.repo.create('cache two')
    env.repo.remove(a.id)
    expect(bodies(env.repo, {})).toEqual(['cache two'])
    expect(bodies(env.repo, { text: 'one' })).toEqual([])
  })

  test('a removed entry is not found through the entry written after it', () => {
    const a = env.repo.create('secret password idea')
    env.repo.remove(a.id)
    env.repo.create('lunch with the team')
    expect(bodies(env.repo, { text: 'secret' })).toEqual([])
    expect(bodies(env.repo, { text: 'lunch' })).toEqual(['lunch with the team'])
  })

  test('a day whose last entry is removed disappears', () => {
    seedDays(env, [
      ['2026-03-01', 'only'],
      ['2026-03-02', 'other']
    ])
    env.repo.remove('n-1')
    expect(env.repo.list(q()).map((d) => d.day)).toEqual(['2026-03-02'])
  })
})

describe('list', () => {
  test('days newest first, entries in capture order, and no empty days', () => {
    seedDays(env, [
      ['2026-02-27', 'old'],
      ['2026-03-02', 'first'],
      ['2026-03-01', 'middle'],
      ['2026-03-02', 'second'],
      ['2026-03-02', 'third']
    ])
    expect(
      env.repo.list(q()).map((d) => [d.day, d.entries.map((e) => e.body)])
    ).toEqual([
      ['2026-03-02', ['first', 'second', 'third']],
      ['2026-03-01', ['middle']],
      ['2026-02-27', ['old']]
    ])
  })

  test('capture order holds even when the clock went backwards', () => {
    env.at(new Date(2026, 2, 2, 10, 0).getTime())
    env.repo.create('written first')
    env.at(new Date(2026, 2, 2, 9, 0).getTime())
    env.repo.create('written second')
    expect(bodies(env.repo, {})).toEqual(['written first', 'written second'])
  })

  test('nothing at all is an empty list', () => {
    expect(env.repo.list(q())).toEqual([])
  })
})

describe('search', () => {
  test('matches word prefixes case-insensitively, through punctuation and line breaks', () => {
    for (const body of ['CACHE', '(cache)', 'x\ncache', 'foo-cache', 'Cachet', 'lunch'])
      env.repo.create(body)
    expect(bodies(env.repo, { text: 'cach' })).toEqual([
      'CACHE',
      '(cache)',
      'x\ncache',
      'foo-cache',
      'Cachet'
    ])
  })

  test('does not match inside a word', () => {
    env.repo.create('cache')
    expect(bodies(env.repo, { text: 'ache' })).toEqual([])
  })

  test('every word must appear, in any order', () => {
    env.repo.create('Bob fixed the cache')
    env.repo.create('cache is slow')
    env.repo.create('Bob is out')
    expect(bodies(env.repo, { text: 'cache bob' })).toEqual(['Bob fixed the cache'])
    expect(bodies(env.repo, { text: 'BOB  CACH' })).toEqual(['Bob fixed the cache'])
  })

  test('shows only the matching entries of a day, and only the days that have one', () => {
    seedDays(env, [
      ['2026-03-01', 'cache one'],
      ['2026-03-01', 'lunch'],
      ['2026-02-28', 'nothing here'],
      ['2026-02-27', 'cache two']
    ])
    expect(
      env.repo.list(q({ text: 'cache' })).map((d) => [d.day, d.entries.map((e) => e.body)])
    ).toEqual([
      ['2026-03-01', ['cache one']],
      ['2026-02-27', ['cache two']]
    ])
  })

  test('a body saved decomposed is found by the composed word the search sends', () => {
    const entry = env.repo.create('cafe\u0301 notes')
    expect(entry.body).toBe('caf\u00e9 notes')
    expect(bodies(env.repo, { text: 'caf\u00e9' })).toEqual(['caf\u00e9 notes'])
    expect(bodies(env.repo, { text: 'cafe\u0301' })).toEqual(['caf\u00e9 notes'])
  })

  test('search ignores diacritics and case, and the stored text keeps its accents', () => {
    env.repo.create('Příliš žluťoučký kůň')
    for (const text of ['prilis', 'PRILIS', 'přílíš', 'zlut', 'ZLUŤ', 'kun', 'kůň', 'prilis kun']) {
      expect(bodies(env.repo, { text }), text).toEqual(['Příliš žluťoučký kůň'])
    }
    expect(env.repo.list(q()).flatMap((d) => d.entries.map((e) => e.body))).toEqual([
      'Příliš žluťoučký kůň'
    ])
  })

  test('an entry typed without accents is found by the accented word', () => {
    env.repo.create('prilis zlutoucky')
    env.repo.create('cafe')
    expect(bodies(env.repo, { text: 'příliš' })).toEqual(['prilis zlutoucky'])
    expect(bodies(env.repo, { text: 'café' })).toEqual(['cafe'])
  })

  test('cafe finds café', () => {
    env.repo.create('café au lait')
    expect(bodies(env.repo, { text: 'cafe' })).toEqual(['café au lait'])
  })

  test('word-start matching is unchanged by folding', () => {
    env.repo.create('příliš')
    expect(bodies(env.repo, { text: 'rilis' })).toEqual([])
    expect(bodies(env.repo, { text: 'ilis' })).toEqual([])
  })

  test('an edit that adds or drops the accents moves the entry between the searches', () => {
    const entry = env.repo.create('prilis')
    env.repo.update(entry.id, 'příliš')
    expect(bodies(env.repo, { text: 'prilis' })).toEqual(['příliš'])
    env.repo.update(entry.id, 'other')
    expect(bodies(env.repo, { text: 'prilis' })).toEqual([])
    expect(() =>
      db.exec(`INSERT INTO note_entry_fts(note_entry_fts) VALUES ('integrity-check')`)
    ).not.toThrow()
  })

  test('the highlighter folds every Latin letter the way the index does', () => {
    const letters: string[] = []
    for (const [from, to] of [
      [0x41, 0x24f],
      [0x1e00, 0x1eff]
    ])
      for (let cp = from; cp <= to; cp++) {
        const ch = String.fromCodePoint(cp)
        if (/\p{L}/u.test(ch)) letters.push(ch)
      }
    const insert = db.prepare(
      'INSERT INTO note_entry (id, day, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    )
    letters.forEach((ch, i) => insert.run(`l-${i}`, '2026-03-01', `x${ch}y`, i, i))

    // Letters carrying two marks, or a ligature with one: the index keeps them apart from their
    // base while the highlighter folds the marks. The worst outcome is a mark on a word the index
    // found for another reason. Listed so that any further divergence still fails.
    const known = new Set([...'ǠǡǢǣǮǯǼǽǾǿ'])
    const disagreements: string[] = []
    for (const ch of letters) {
      if (known.has(ch)) continue
      const base = ch
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .normalize('NFC')
      const indexFolds = bodies(env.repo, { text: `x${base}y` }).includes(`x${ch}y`)
      const highlightFolds = matchRanges(`x${ch}y`, [`x${base}y`]).length > 0
      if (indexFolds !== highlightFolds) disagreements.push(ch)
    }
    expect(disagreements).toEqual([])
  })

  test('input with no words does not filter', () => {
    env.repo.create('a')
    env.repo.create('b')
    expect(bodies(env.repo, { text: '  "*  ' })).toEqual(['a', 'b'])
  })

  test('FTS5 operators typed by the user never throw and are taken literally', () => {
    env.repo.create('cache warmed')
    env.repo.create('this OR that')
    env.repo.create('NEAR the door')
    env.repo.create('title: something')

    const inputs = ['cache"', '-cache', 'title:cache', 'cache*', '"', '***', '(', 'a AND', '^x']
    for (const text of inputs) expect(() => env.repo.list(q({ text }))).not.toThrow()

    expect(bodies(env.repo, { text: 'cache"' })).toEqual(['cache warmed'])
    expect(bodies(env.repo, { text: '-cache' })).toEqual(['cache warmed'])
    expect(bodies(env.repo, { text: 'cache*' })).toEqual(['cache warmed'])
    // "title:cache" is two words, not a column filter; no entry has both.
    expect(bodies(env.repo, { text: 'title:cache' })).toEqual([])
    expect(bodies(env.repo, { text: 'title:some' })).toEqual(['title: something'])
    expect(bodies(env.repo, { text: 'OR' })).toEqual(['this OR that'])
    expect(bodies(env.repo, { text: 'near' })).toEqual(['NEAR the door'])
    expect(bodies(env.repo, { text: 'this OR' })).toEqual(['this OR that'])
  })

  test('every entry the index finds is one the highlighter can mark', () => {
    const corpus = [
      "it's the vendor's cache",
      'snake_case_name and kebab-case',
      'build 2026 v1.2.3',
      'Řešení pro ŽLUŤOUČKÝ kůň',
      'x²y formula',
      'café au lait',
      'İstanbul trip',
      'ISTANBUL office',
      'emoji 🎉party',
      '中文 note',
      'Ωmega and σίγμα',
      'plan q́uota met'
    ]
    for (const body of corpus) env.repo.create(body)
    const foldForTest = (text: string): string =>
      text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC')
    const queries = [
      'it',
      's',
      'vendor',
      'case',
      'snake',
      'kebab',
      '2026',
      'v1',
      '3',
      'řeš',
      'žluť',
      'kůň',
      'x²',
      'x',
      'café',
      'cafe',
      'rešeni',
      'zlutoucky',
      'İstan',
      'istan',
      'party',
      '中',
      'ωm',
      'σί',
      'ca au',
      'q́uo'
    ]
    let hits = 0
    for (const text of queries) {
      const terms = noteSearchTerms(text)
      for (const body of bodies(env.repo, { text })) {
        hits += 1
        const ranges = matchRanges(body, terms)
        for (const term of terms) {
          const marked = ranges.some(([s, e]) => foldForTest(body.slice(s, e)).startsWith(foldForTest(term)))
          expect(marked, `"${term}" in "${body}"`).toBe(true)
        }
      }
    }
    // The corpus must actually exercise the check.
    expect(hits).toBeGreaterThan(20)
  })
})

describe('date range', () => {
  beforeEach(() => {
    seedDays(env, [
      ['2026-02-26', 'd26'],
      ['2026-02-27', 'd27 cache'],
      ['2026-02-28', 'd28'],
      ['2026-03-01', 'd01 cache'],
      ['2026-03-02', 'd02']
    ])
  })

  test('both bounds are inclusive', () => {
    expect(bodies(env.repo, { from: '2026-02-27', to: '2026-03-01' })).toEqual([
      'd01 cache',
      'd28',
      'd27 cache'
    ])
  })

  test('only "from" is open-ended into the future', () => {
    expect(bodies(env.repo, { from: '2026-03-01' })).toEqual(['d02', 'd01 cache'])
  })

  test('only "to" is open-ended into the past', () => {
    expect(bodies(env.repo, { to: '2026-02-27' })).toEqual(['d27 cache', 'd26'])
  })

  test('combines with search', () => {
    expect(bodies(env.repo, { text: 'cache', from: '2026-02-28' })).toEqual(['d01 cache'])
    expect(bodies(env.repo, { text: 'cache', to: '2026-02-28' })).toEqual(['d27 cache'])
  })

  test('rejects a bound that is not a day key', () => {
    expect(() => env.repo.list(q({ from: '2026-3-1' }))).toThrow(/invalid day/i)
    expect(() => env.repo.list(q({ to: "x' OR 1=1 --" }))).toThrow(/invalid day/i)
  })
})

describe('paging by days', () => {
  /** Entries on `n` consecutive days ending 2026-03-01; day i has i+1 entries. Newest first. */
  const seedRun = (n: number): string[] => {
    const days: string[] = []
    const entries: [string, string][] = []
    for (let i = 0; i < n; i++) {
      const day = dayKeyOf(new Date(2026, 2, 1 - i, 12).getTime())
      days.push(day)
      for (let k = 0; k <= i % 3; k++) entries.push([day, `${day}#${k}`])
    }
    seedDays(env, entries)
    return days
  }
  const dayKeys = (query: Partial<NoteQuery>): string[] =>
    env.repo.list(q(query)).map((d) => d.day)

  test('a day limit returns that many newest days, each with all its entries', () => {
    const days = seedRun(7)
    const page = env.repo.list(q({ dayLimit: 3 }))
    expect(page.map((d) => d.day)).toEqual(days.slice(0, 3))
    expect(page.map((d) => d.entries.length)).toEqual([1, 2, 3])
  })

  test('a limit above the number of days returns them all', () => {
    const days = seedRun(4)
    expect(dayKeys({ dayLimit: 30 })).toEqual(days)
  })

  test('a cursor returns only days strictly before it, so pages follow one another', () => {
    const days = seedRun(7)
    const first = dayKeys({ dayLimit: 3 })
    const second = dayKeys({ dayLimit: 3, before: first[first.length - 1] })
    const third = dayKeys({ dayLimit: 3, before: second[second.length - 1] })
    expect(second).toEqual(days.slice(3, 6))
    expect(third).toEqual(days.slice(6))
    expect(dayKeys({ dayLimit: 3, before: days[6] })).toEqual([])
  })

  test('a cursor without a limit returns everything before it', () => {
    const days = seedRun(5)
    expect(dayKeys({ before: days[1] })).toEqual(days.slice(2))
  })

  test('days are counted after the search, so a page is full of matching days only', () => {
    seedDays(env, [
      ['2026-02-20', 'cache a'],
      ['2026-02-21', 'lunch'],
      ['2026-02-22', 'cache b'],
      ['2026-02-23', 'lunch'],
      ['2026-02-24', 'cache c'],
      ['2026-02-25', 'cache d']
    ])
    expect(dayKeys({ text: 'cache', dayLimit: 3 })).toEqual(['2026-02-25', '2026-02-24', '2026-02-22'])
    expect(dayKeys({ text: 'cache', dayLimit: 3, before: '2026-02-22' })).toEqual(['2026-02-20'])
  })

  test('a day with several matches counts once and keeps only its matching entries', () => {
    seedDays(env, [
      ['2026-02-24', 'cache one'],
      ['2026-02-24', 'lunch'],
      ['2026-02-24', 'cache two'],
      ['2026-02-23', 'cache three']
    ])
    const page = env.repo.list(q({ text: 'cache', dayLimit: 1 }))
    expect(page).toHaveLength(1)
    expect(page[0].entries.map((e) => e.body)).toEqual(['cache one', 'cache two'])
  })

  test('combines with the date range', () => {
    const days = seedRun(10)
    expect(dayKeys({ from: days[6], to: days[1], dayLimit: 2 })).toEqual([days[1], days[2]])
    expect(dayKeys({ from: days[6], to: days[1], dayLimit: 2, before: days[2] })).toEqual([
      days[3],
      days[4]
    ])
  })

  test('rejects a limit that is not a positive whole number and a cursor that is not a day', () => {
    for (const dayLimit of [0, -1, 1.5, Number.NaN]) {
      expect(() => env.repo.list(q({ dayLimit }))).toThrow(/invalid day limit/i)
    }
    expect(() => env.repo.list(q({ before: '2026-3-1' }))).toThrow(/invalid day/i)
  })
})

describe('scale', () => {
  test('a search with a date range over 10,000 entries returns in under 200 ms', () => {
    const insert = db.prepare(
      'INSERT INTO note_entry (id, day, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    )
    const words = ['cache', 'deploy', 'review', 'lunch', 'Příliš', 'Alice', 'pipeline', 'budget']
    db.exec('BEGIN')
    for (let i = 0; i < 10_000; i++) {
      const key = dayKeyOf(new Date(2026, 0, 1 + Math.floor(i / 30), 12).getTime())
      const body = `${words[i % words.length]} note ${i} about ${words[(i * 7) % words.length]}`
      insert.run(`s-${i}`, key, body, i, i)
    }
    db.exec('COMMIT')

    // The folded search is the one that must stay fast: an accented word found by plain letters.
    for (const text of ['cach', 'prilis']) {
      const started = performance.now()
      const result = env.repo.list(q({ text, from: '2026-03-01', to: '2026-06-30' }))
      const elapsed = performance.now() - started

      expect(result.length, text).toBeGreaterThan(0)
      expect(elapsed, text).toBeLessThan(200)
    }
  })

  test('one page of 30 days out of 3,000 days and 10,000 entries returns in under 200 ms', () => {
    const insert = db.prepare(
      'INSERT INTO note_entry (id, day, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    )
    db.exec('BEGIN')
    for (let i = 0; i < 10_000; i++) {
      const key = dayKeyOf(new Date(2010, 0, 1 + (i % 3_000), 12).getTime())
      insert.run(`s-${i}`, key, `entry ${i} about the cache`, i, i)
    }
    db.exec('COMMIT')

    for (const text of ['', 'cach']) {
      const started = performance.now()
      const page = env.repo.list(q({ text, dayLimit: 30 }))
      const older = env.repo.list(q({ text, dayLimit: 30, before: page[page.length - 1].day }))
      const elapsed = performance.now() - started

      expect(page).toHaveLength(30)
      expect(older).toHaveLength(30)
      expect(older[0].day < page[29].day).toBe(true)
      // Each call is a page, so both together are well under twice the limit.
      expect(elapsed).toBeLessThan(200)
    }
  })
})
