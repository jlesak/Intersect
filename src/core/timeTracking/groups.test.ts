import { describe, expect, test } from 'vitest'
import { makeTestDb, makeTestDeps } from '../db/testkit'
import { createManualTimeEntryRepo, createRunningTimerRepo, createTimeOverrideRepo } from '../db/timeTrackingRepo'
import { createTimeEntryGroupRepo } from '../db/timeEntryGroupRepo'
import { createTimeSessionDayRepo } from '../db/timeSessionDayRepo'
import { tx } from '../db/tx'
import { createTimeTracking } from './timeTracking'

const DAY = '2026-07-06'
const NEXT = '2026-07-07'

function setup() {
  const db = makeTestDb()
  const deps = makeTestDeps()
  const manual = createManualTimeEntryRepo(db, deps)
  const snapshots = createTimeSessionDayRepo(db, deps.now)
  const groups = createTimeEntryGroupRepo(db, deps)
  let excludedPathPrefixes: string[] = []
  const service = createTimeTracking({
    snapshots,
    scanner: { ready: async () => {}, scan: async () => {}, start() {}, dispose() {} },
    isResumable: async () => false,
    settings: () => ({ excludedPathPrefixes }), userDataDir: '/intersect',
    manual, groups, overrides: createTimeOverrideRepo(db, deps),
    timer: createRunningTimerRepo(db, deps), now: deps.now, atomically: fn => tx(db, fn)
  })
  const add = (description: string, issueKey: string | null, day = DAY) =>
    manual.create({ day, description, issueKey, durationMs: 600_000 })
  const auto = (sessionId: string, day = DAY, cwd = '/work') => snapshots.upsert({
    sessionId, day, title: sessionId, cwd, gitBranch: 'feature/ABC-1-test',
    autoDescription: sessionId, firstTimestamp: 1, lastTimestamp: 2,
    activeDurationMs: 600_000
  })
  return { db, service, add, auto, groups,
    exclude(prefixes: string[]) { excludedPathPrefixes = prefixes } }
}

describe('time entry groups integration', () => {
  test('groups mixed entries, preserves member values and derives duration until override', async () => {
    const t = setup()
    t.auto('s1')
    const manual = t.add('Review', 'ABC-1')
    const refs = [{ source: 'auto' as const, sessionId: 's1', day: DAY },
      { source: 'manual' as const, id: manual.id }]
    const groupId = t.service.groupEntries(refs)
    expect((await t.service.getWeek(DAY))[0]).toMatchObject({ source: 'group', day: DAY, issueKey: 'ABC-1',
      description: 's1; Review', durationMs: 1_200_000 })
    expect((await t.service.getWeek(DAY))).toHaveLength(1)
    await t.service.updateEntry({ source: 'manual', id: manual.id },
      { description: 'Changed', issueKey: 'ABC-2', durationMs: 900_000 })
    expect((await t.service.getWeek(DAY))[0]).toMatchObject({ description: 's1; Review',
      issueKey: 'ABC-1', durationMs: 1_500_000 })
    t.service.updateGroup(groupId,
      { description: 'Combined', issueKey: 'ABC-3', durationMs: 2_000_000 })
    expect((await t.service.getWeek(DAY))[0]).toMatchObject({ description: 'Combined',
      issueKey: 'ABC-3', durationMs: 2_000_000 })
    t.service.ungroup(groupId)
    expect((await t.service.getWeek(DAY))).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: manual.id, description: 'Changed', issueKey: 'ABC-2',
        durationMs: 900_000 })
    ]))
  })

  test('rejects a card that already belongs to another group', () => {
    const t = setup()
    const a = t.add('A', null)
    const b = t.add('B', null)
    const c = t.add('C', null)
    t.service.groupEntries([{ source: 'manual', id: a.id }, { source: 'manual', id: b.id }])
    expect(() => t.service.groupEntries([{ source: 'manual', id: a.id },
      { source: 'manual', id: c.id }])).toThrow('A card is already grouped')
    expect(t.groups.listByDays([DAY])).toHaveLength(1)
    expect((t.db.prepare('SELECT count(*) AS n FROM time_entry_group_member').get() as { n: number }).n)
      .toBe(2)
  })

  test('rejects ungrouped cards from different days without a partial group', () => {
    const t = setup()
    const a = t.add('A', null, DAY)
    const b = t.add('B', null, NEXT)
    expect(() => t.service.groupEntries([{ source: 'manual', id: a.id },
      { source: 'manual', id: b.id }])).toThrow('A group cannot span days')
    expect(t.groups.listByDays([DAY, NEXT])).toEqual([])
    expect((t.db.prepare('SELECT count(*) AS n FROM time_entry_group_member').get() as { n: number }).n)
      .toBe(0)
  })

  test('deleting one member dissolves a two-member group', async () => {
    const t = setup()
    const a = t.add('A', null)
    const b = t.add('B', null)
    await t.service.groupEntries([{ source: 'manual', id: a.id }, { source: 'manual', id: b.id }])
    await t.service.deleteEntry({ source: 'manual', id: a.id })
    expect(await t.service.getWeek(DAY)).toEqual([expect.objectContaining({ id: b.id })])
    expect(t.groups.listByDays([DAY])).toEqual([])
  })

  test('excluded member hides group without leaking its description or duration, then restores it', async () => {
    const t = setup()
    t.auto('private', DAY, '/private/work')
    const b = t.add('Public', 'ABC-1')
    const groupId = t.service.groupEntries([{ source: 'auto', sessionId: 'private', day: DAY },
      { source: 'manual', id: b.id }])
    t.exclude(['/private'])
    expect(await t.service.getWeek(DAY)).toEqual([expect.objectContaining({ id: b.id })])
    expect(t.groups.listByDays([DAY])).toHaveLength(1)
    t.exclude([])
    expect((await t.service.getWeek(DAY))[0].id).toBe(groupId)
  })

  test('groups a day by shared key, skips non-work, missing keys and existing membership', async () => {
    const t = setup()
    for (let i = 0; i < 3; i++) t.add(`A${i}`, 'ABC-1')
    for (let i = 0; i < 2; i++) t.add(`B${i}`, 'ABC-2')
    const unkeyed = t.add('Unkeyed', null)
    t.auto('nonwork')
    t.db.prepare(`UPDATE time_session_day SET is_work = 0 WHERE session_id = 'nonwork'`).run()
    const groups = await t.service.groupDayByIssue(DAY)
    expect(groups).toHaveLength(2)
    const week = await t.service.getWeek(DAY)
    expect(week.filter(entry => entry.source === 'group')).toHaveLength(2)
    expect(week.filter(entry => entry.source !== 'group').map(entry => entry.description).sort())
      .toEqual(['Unkeyed', 'nonwork'].sort())
    expect(await t.service.groupDayByIssue(DAY)).toEqual([])
    const manualGroup = t.service.groupEntries([
      { source: 'auto', sessionId: 'nonwork', day: DAY },
      { source: 'manual', id: unkeyed.id }
    ])
    expect((await t.service.getWeek(DAY)).find(entry => entry.id === manualGroup))
      .toMatchObject({ source: 'group', issueKey: null })
  })

  test('same session on two days has distinct membership identity', async () => {
    const t = setup()
    t.auto('same', DAY)
    t.auto('same', NEXT)
    const a = t.add('Monday', null, DAY)
    const b = t.add('Tuesday', null, NEXT)
    await t.service.groupEntries([{ source: 'auto', sessionId: 'same', day: DAY },
      { source: 'manual', id: a.id }])
    await t.service.groupEntries([{ source: 'auto', sessionId: 'same', day: NEXT },
      { source: 'manual', id: b.id }])
    expect(t.groups.listByDays([DAY, NEXT])).toHaveLength(2)
  })
})
