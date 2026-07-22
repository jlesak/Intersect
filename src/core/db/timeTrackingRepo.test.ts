import { beforeEach, describe, expect, test } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import type { NewManualTimeEntry } from '@common/domain'
import {
  createManualTimeEntryRepo,
  createTimeOverrideRepo,
  type ManualTimeEntryRepo,
  type TimeOverrideRepo
} from './timeTrackingRepo'
import { makeTestDb, makeTestDeps } from './testkit'

const entry = (over: Partial<NewManualTimeEntry> = {}): NewManualTimeEntry => ({
  day: '2026-07-06',
  description: 'Team sync meeting',
  issueKey: null,
  durationMs: 30 * 60_000,
  ...over
})

describe('manualTimeEntryRepo', () => {
  let db: DatabaseSync
  let repo: ManualTimeEntryRepo

  beforeEach(() => {
    db = makeTestDb()
    repo = createManualTimeEntryRepo(db, makeTestDeps())
  })

  test('create stores a manual entry with a deterministic id and returns the canonical row', () => {
    const e = repo.create(entry({ issueKey: 'FID2507-611' }))
    expect(e).toEqual({
      id: 'id-1',
      source: 'manual',
      day: '2026-07-06',
      description: 'Team sync meeting',
      issueKey: 'FID2507-611',
      durationMs: 30 * 60_000
    })
  })

  test('an entry without an issue key round-trips as null', () => {
    const e = repo.create(entry())
    expect(e.issueKey).toBeNull()
  })

  test('listByDays returns only the asked-for days, ordered by day then creation', () => {
    repo.create(entry({ day: '2026-07-07', description: 'second day' }))
    repo.create(entry({ day: '2026-07-06', description: 'first day, first' }))
    repo.create(entry({ day: '2026-07-06', description: 'first day, second' }))
    repo.create(entry({ day: '2026-07-13', description: 'next week' }))
    const list = repo.listByDays(['2026-07-06', '2026-07-07'])
    expect(list.map((e) => e.description)).toEqual([
      'first day, first',
      'first day, second',
      'second day'
    ])
  })

  test('listByDays with no days returns an empty list', () => {
    repo.create(entry())
    expect(repo.listByDays([])).toEqual([])
  })

  test('update overwrites description, time and issue key, including clearing the key', () => {
    const e = repo.create(entry({ issueKey: 'FID2507-611' }))
    const updated = repo.update(e.id, {
      description: 'Renamed meeting',
      issueKey: null,
      durationMs: 60 * 60_000
    })
    expect(updated.issueKey).toBeNull()
    expect(updated.durationMs).toBe(60 * 60_000)
    expect(updated.description).toBe('Renamed meeting')
  })

  test('update of a missing entry throws a message-only error', () => {
    expect(() =>
      repo.update('nope', { description: 'x', issueKey: null, durationMs: 1 })
    ).toThrow(/not found/i)
  })

  test('remove hard-deletes the row', () => {
    const e = repo.create(entry())
    repo.remove(e.id)
    expect(repo.listByDays(['2026-07-06'])).toEqual([])
  })
})

describe('timeOverrideRepo', () => {
  let db: DatabaseSync
  let repo: TimeOverrideRepo

  beforeEach(() => {
    db = makeTestDb()
    repo = createTimeOverrideRepo(db, makeTestDeps())
  })

  test('upsert inserts a new override and get reads it back', () => {
    repo.upsert('sess-1', {
      description: 'Edited label',
      issueKey: 'FID2507-611',
      durationMs: 90 * 60_000,
      deleted: false
    })
    expect(repo.get('sess-1')).toEqual({
      sessionId: 'sess-1',
      description: 'Edited label',
      issueKey: 'FID2507-611',
      durationMs: 90 * 60_000,
      deleted: false
    })
  })

  test('a never-edited description round-trips as null', () => {
    repo.upsert('sess-1', { description: null, issueKey: null, durationMs: 1000, deleted: false })
    expect(repo.get('sess-1')?.description).toBeNull()
  })

  test('upsert replaces an existing override whole, including clearing the issue key', () => {
    repo.upsert('sess-1', {
      description: 'first',
      issueKey: 'FID2507-611',
      durationMs: 1000,
      deleted: false
    })
    repo.upsert('sess-1', { description: null, issueKey: null, durationMs: 2000, deleted: false })
    expect(repo.get('sess-1')).toEqual({
      sessionId: 'sess-1',
      description: null,
      issueKey: null,
      durationMs: 2000,
      deleted: false
    })
  })

  test('a tombstone survives round-trip and keeps its snapshot fields', () => {
    repo.upsert('sess-1', {
      description: 'kept',
      issueKey: 'FID2507-611',
      durationMs: 1000,
      deleted: true
    })
    const o = repo.get('sess-1')
    expect(o?.deleted).toBe(true)
    expect(o?.issueKey).toBe('FID2507-611')
  })

  test('get of an unknown session is undefined', () => {
    expect(repo.get('nope')).toBeUndefined()
  })

  test('listAll returns every override', () => {
    repo.upsert('sess-1', { description: null, issueKey: null, durationMs: 1, deleted: false })
    repo.upsert('sess-2', { description: null, issueKey: 'AB-1', durationMs: 2, deleted: true })
    expect(repo.listAll().map((o) => o.sessionId).sort()).toEqual(['sess-1', 'sess-2'])
  })

  test('pruneAbsent drops only overrides whose session is gone', () => {
    repo.upsert('sess-1', { description: null, issueKey: null, durationMs: 1, deleted: false })
    repo.upsert('sess-2', { description: null, issueKey: 'AB-1', durationMs: 2, deleted: true })
    repo.pruneAbsent(['sess-1'])
    expect(repo.listAll().map((o) => o.sessionId)).toEqual(['sess-1'])
  })
})
