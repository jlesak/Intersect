import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { SessionSummary } from '@common/domain'
import {
  createManualTimeEntryRepo,
  createTimeOverrideRepo,
  type ManualTimeEntryRepo,
  type TimeOverrideRepo
} from '../db/timeTrackingRepo'
import { makeTestDb, makeTestDeps } from '../db/testkit'
import type { SessionIndex } from '../sessions/sessionIndex'
import { createTimeTracking, type TimeTrackingService } from './timeTracking'

// The tested week: Monday 2026-07-06 through Friday 2026-07-10 (weekend 07-11/07-12).
const WEEK = '2026-07-06'

/** Epoch ms at a local time of a day in the tested week, so bucketing is timezone-independent. */
const at = (day: number, hour: number, minute = 0): number =>
  new Date(2026, 6, day, hour, minute).getTime()

const session = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  filePath: `/p/${id}.jsonl`,
  cwd: `/repo/${id}`,
  folderName: id,
  title: `Session ${id}`,
  gitBranch: null,
  firstTimestamp: at(6, 9),
  lastTimestamp: at(6, 10),
  durationMs: 60 * 60_000,
  activeDurationMs: 60 * 60_000,
  messageCount: 2,
  userPrompts: [],
  ...over
})

function makeIndex(sessions: SessionSummary[]): SessionIndex {
  return {
    list: vi.fn(async () => sessions),
    refresh: vi.fn(async () => sessions),
    getTranscript: vi.fn()
  }
}

describe('timeTracking service', () => {
  let manual: ManualTimeEntryRepo
  let overrides: TimeOverrideRepo

  beforeEach(() => {
    const db = makeTestDb()
    const deps = makeTestDeps()
    manual = createManualTimeEntryRepo(db, deps)
    overrides = createTimeOverrideRepo(db, deps)
  })

  const make = (sessions: SessionSummary[]): TimeTrackingService =>
    createTimeTracking({ sessions: makeIndex(sessions), manual, overrides })

  test('buckets sessions into local days of the shown week and derives issue keys', async () => {
    const svc = make([
      session('mon', { lastTimestamp: at(6, 15), gitBranch: 'feature/fid2507-611-slug' }),
      session('wed', { lastTimestamp: at(8, 11), gitBranch: 'feature/time-tracking' })
    ])
    const week = await svc.getWeek(WEEK)
    expect(week).toEqual([
      {
        id: 'mon',
        source: 'auto',
        day: '2026-07-06',
        description: 'Session mon',
        issueKey: 'FID2507-611',
        durationMs: 60 * 60_000
      },
      {
        id: 'wed',
        source: 'auto',
        day: '2026-07-08',
        description: 'Session wed',
        issueKey: null,
        durationMs: 60 * 60_000
      }
    ])
  })

  test('a session ending just before local midnight belongs to that day', async () => {
    const svc = make([session('late', { lastTimestamp: new Date(2026, 6, 6, 23, 59).getTime() })])
    const week = await svc.getWeek(WEEK)
    expect(week.map((e) => e.day)).toEqual(['2026-07-06'])
  })

  test('weekend sessions are excluded entirely', async () => {
    const svc = make([
      session('sat', { lastTimestamp: at(11, 10) }),
      session('sun', { lastTimestamp: at(12, 10) })
    ])
    expect(await svc.getWeek(WEEK)).toEqual([])
  })

  test('sessions from another week are excluded', async () => {
    const svc = make([session('prev', { lastTimestamp: new Date(2026, 5, 30, 10).getTime() })])
    expect(await svc.getWeek(WEEK)).toEqual([])
  })

  test('an override replaces both editable fields, including a cleared issue key', async () => {
    const svc = make([session('s1', { gitBranch: 'fid2507-611' })])
    overrides.upsert('s1', {
      description: 'Edited',
      issueKey: null,
      durationMs: 45 * 60_000,
      deleted: false
    })
    const [e] = await svc.getWeek(WEEK)
    expect(e.issueKey).toBeNull()
    expect(e.durationMs).toBe(45 * 60_000)
  })

  test('a tombstoned session yields no card', async () => {
    const svc = make([session('s1')])
    overrides.upsert('s1', { description: null, issueKey: null, durationMs: 0, deleted: true })
    expect(await svc.getWeek(WEEK)).toEqual([])
  })

  test('manual entries of the week are merged after the day\'s sessions', async () => {
    const svc = make([session('s1', { lastTimestamp: at(6, 16) })])
    svc.addManual({ day: '2026-07-06', description: 'Standup', issueKey: null, durationMs: 15 * 60_000 })
    const week = await svc.getWeek(WEEK)
    expect(week.map((e) => [e.source, e.description])).toEqual([
      ['auto', 'Session s1'],
      ['manual', 'Standup']
    ])
  })

  test('entries are ordered by day, sessions chronologically within a day', async () => {
    const svc = make([
      // The index returns newest activity first; the board wants chronological days.
      session('tue-late', { lastTimestamp: at(7, 18) }),
      session('tue-early', { lastTimestamp: at(7, 9) }),
      session('mon', { lastTimestamp: at(6, 10) })
    ])
    svc.addManual({ day: '2026-07-06', description: 'Meeting', issueKey: null, durationMs: 1 })
    const week = await svc.getWeek(WEEK)
    expect(week.map((e) => e.id.startsWith('id-') ? e.description : e.id)).toEqual([
      'mon',
      'Meeting',
      'tue-early',
      'tue-late'
    ])
  })

  test('updateEntry on an auto card upserts the override and survives a re-read', async () => {
    const svc = make([session('s1', { gitBranch: 'fid2507-611' })])
    const updated = await svc.updateEntry('auto', 's1', {
      description: 'Session s1',
      issueKey: 'FID2507-999',
      durationMs: 2 * 60 * 60_000
    })
    expect(updated.issueKey).toBe('FID2507-999')
    expect(updated.day).toBe('2026-07-06')
    const [e] = await svc.getWeek(WEEK)
    expect(e.issueKey).toBe('FID2507-999')
    expect(e.durationMs).toBe(2 * 60 * 60_000)
  })

  test('updateEntry on a manual card writes through the manual repo', async () => {
    const svc = make([])
    const created = svc.addManual({
      day: '2026-07-07',
      description: '1:1 with Marek',
      issueKey: null,
      durationMs: 60 * 60_000
    })
    const updated = await svc.updateEntry('manual', created.id, {
      description: '1:1 with Marek',
      issueKey: 'FID2507-1',
      durationMs: 30 * 60_000
    })
    expect(updated.issueKey).toBe('FID2507-1')
    expect((await svc.getWeek(WEEK))[0].durationMs).toBe(30 * 60_000)
  })

  test('updateEntry on an unknown session throws', async () => {
    const svc = make([])
    await expect(
      svc.updateEntry('auto', 'nope', { description: 'x', issueKey: null, durationMs: 1 })
    ).rejects.toThrow(/Unknown session/)
  })

  test('deleteEntry on an auto card tombstones it - the card never resurrects', async () => {
    const svc = make([session('s1')])
    await svc.deleteEntry('auto', 's1')
    expect(await svc.getWeek(WEEK)).toEqual([])
    // A later "refresh" (same sessions re-scanned) still shows nothing.
    expect(await svc.refreshWeek(WEEK)).toEqual([])
  })

  test('deleting an unedited auto card snapshots its active time, not wall clock', async () => {
    const svc = make([
      session('s1', { durationMs: 8 * 60 * 60_000, activeDurationMs: 20 * 60_000 })
    ])
    await svc.deleteEntry('auto', 's1')
    expect(overrides.get('s1')?.durationMs).toBe(20 * 60_000)
  })

  test('deleting an edited auto card keeps the override snapshot but marks it deleted', async () => {
    const svc = make([session('s1')])
    await svc.updateEntry('auto', 's1', { description: 'Edited', issueKey: 'AB-12', durationMs: 5 })
    await svc.deleteEntry('auto', 's1')
    expect(overrides.get('s1')).toEqual({
      sessionId: 's1',
      description: 'Edited',
      issueKey: 'AB-12',
      durationMs: 5,
      deleted: true
    })
  })

  test('deleteEntry on a manual card hard-deletes it', async () => {
    const svc = make([])
    const created = svc.addManual({
      day: '2026-07-06',
      description: 'Meeting',
      issueKey: null,
      durationMs: 1
    })
    await svc.deleteEntry('manual', created.id)
    expect(await svc.getWeek(WEEK)).toEqual([])
  })

  test('refreshWeek forces a session re-scan', async () => {
    const index = makeIndex([])
    const svc = createTimeTracking({ sessions: index, manual, overrides })
    await svc.refreshWeek(WEEK)
    expect(index.refresh).toHaveBeenCalledOnce()
  })

  test('refreshWeek prunes overrides of sessions whose transcript is gone', async () => {
    const svc = make([session('s1')])
    await svc.updateEntry('auto', 's1', {
      description: 'Session s1',
      issueKey: 'ABC-1',
      durationMs: 5 * 60_000
    })
    overrides.upsert('gone', { description: null, issueKey: null, durationMs: 1, deleted: true })

    await svc.refreshWeek(WEEK)

    expect(overrides.get('s1')).toBeDefined()
    expect(overrides.get('gone')).toBeUndefined()
  })

  test('addManual rejects a malformed day, an empty description, and a non-positive duration', () => {
    const svc = make([])
    const valid = { day: WEEK, description: 'standup', issueKey: null, durationMs: 15 * 60_000 }
    expect(() => svc.addManual({ ...valid, day: 'today' })).toThrow(/Not a day/)
    expect(() => svc.addManual({ ...valid, description: '  ' })).toThrow(/description/)
    expect(() => svc.addManual({ ...valid, durationMs: 0 })).toThrow(/positive/)
    expect(() => svc.addManual({ ...valid, durationMs: -5 })).toThrow(/positive/)
  })

  test('updateEntry rejects a non-positive duration for both kinds', async () => {
    const svc = make([session('s1')])
    const created = svc.addManual({
      day: WEEK,
      description: 'standup',
      issueKey: null,
      durationMs: 15 * 60_000
    })
    await expect(
      svc.updateEntry('manual', created.id, { description: 'x', issueKey: null, durationMs: 0 })
    ).rejects.toThrow(/positive/)
    await expect(
      svc.updateEntry('auto', 's1', { description: 'x', issueKey: null, durationMs: -1 })
    ).rejects.toThrow(/positive/)
  })

  test('auto entries log active time, not wall-clock duration', async () => {
    const svc = make([
      session('s1', { durationMs: 8 * 60 * 60_000, activeDurationMs: 15 * 60_000 })
    ])
    const [e] = await svc.getWeek(WEEK)
    expect(e.durationMs).toBe(15 * 60_000)
  })

  test('an auto description is sanitized, falling back to a user prompt', async () => {
    const svc = make([
      session('s1', {
        title: '<task-notification><task-id>x</task-id></task-notification>',
        userPrompts: ['Wire up the worklog board']
      })
    ])
    const [e] = await svc.getWeek(WEEK)
    expect(e.description).toBe('Wire up the worklog board')
  })

  test('updateEntry persists an edited description for an auto card', async () => {
    const svc = make([session('s1')])
    await svc.updateEntry('auto', 's1', {
      description: 'Pair-review with Marek',
      issueKey: 'AB-1',
      durationMs: 30 * 60_000
    })
    expect(overrides.get('s1')?.description).toBe('Pair-review with Marek')
    const [e] = await svc.getWeek(WEEK)
    expect(e.description).toBe('Pair-review with Marek')
  })

  test('an override with a null description still applies its duration and issue key', async () => {
    const svc = make([
      session('s1', { title: 'Auto label', activeDurationMs: 90 * 60_000 })
    ])
    overrides.upsert('s1', {
      description: null,
      issueKey: 'AB-2',
      durationMs: 20 * 60_000,
      deleted: false
    })
    const [e] = await svc.getWeek(WEEK)
    expect(e.description).toBe('Auto label')
    expect(e.issueKey).toBe('AB-2')
    expect(e.durationMs).toBe(20 * 60_000)
  })

  test('updateEntry rejects an empty description for both kinds', async () => {
    const svc = make([session('s1')])
    const created = svc.addManual({
      day: WEEK,
      description: 'standup',
      issueKey: null,
      durationMs: 15 * 60_000
    })
    await expect(
      svc.updateEntry('manual', created.id, { description: '  ', issueKey: null, durationMs: 1 })
    ).rejects.toThrow(/description/)
    await expect(
      svc.updateEntry('auto', 's1', { description: '', issueKey: null, durationMs: 1 })
    ).rejects.toThrow(/description/)
  })
})
