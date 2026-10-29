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

const q = (over: Partial<NoteQuery> = {}): NoteQuery => ({ text: '', from: null, to: null, ...over })

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
    env.repo.create('café notes')
    expect(bodies(env.repo, { text: 'café' })).toEqual(['café notes'])
    expect(bodies(env.repo, { text: 'café' })).toEqual(['café notes'])
  })

  test('diacritics are matched exactly', () => {
    env.repo.create('café')
    expect(bodies(env.repo, { text: 'cafe' })).toEqual([])
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
      'Ωmega and σίγμα'
    ]
    for (const body of corpus) env.repo.create(body)
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
      'İstan',
      'istan',
      'party',
      '中',
      'ωm',
      'σί',
      'ca au'
    ]
    let hits = 0
    for (const text of queries) {
      const terms = noteSearchTerms(text)
      for (const body of bodies(env.repo, { text })) {
        hits += 1
        const ranges = matchRanges(body, terms)
        for (const term of terms) {
          const marked = ranges.some(([s, e]) =>
            body.slice(s, e).toLowerCase().startsWith(term.toLowerCase())
          )
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

describe('scale', () => {
  test('a search with a date range over 10,000 entries returns in under 200 ms', () => {
    const insert = db.prepare(
      'INSERT INTO note_entry (id, day, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    )
    const words = ['cache', 'deploy', 'review', 'lunch', 'Bob', 'Alice', 'pipeline', 'budget']
    db.exec('BEGIN')
    for (let i = 0; i < 10_000; i++) {
      const key = dayKeyOf(new Date(2026, 0, 1 + Math.floor(i / 30), 12).getTime())
      const body = `${words[i % words.length]} note ${i} about ${words[(i * 7) % words.length]}`
      insert.run(`s-${i}`, key, body, i, i)
    }
    db.exec('COMMIT')

    const started = performance.now()
    const result = env.repo.list(q({ text: 'cach', from: '2026-03-01', to: '2026-06-30' }))
    const elapsed = performance.now() - started

    expect(result.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(200)
  })
})
