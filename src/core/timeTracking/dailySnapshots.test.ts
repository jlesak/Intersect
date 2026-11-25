import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import { runMigrations } from '../db/migrations'
import { makeTestDb, makeTestDeps } from '../db/testkit'
import { createManualTimeEntryRepo, createRunningTimerRepo, createTimeOverrideRepo } from '../db/timeTrackingRepo'
import { createSessionIndex } from '../sessions/sessionIndex'
import { createTimeTracking } from './timeTracking'
import { createTimeSessionDayRepo } from '../db/timeSessionDayRepo'
import { createAppStateRepo } from '../db/appStateRepo'
import { createSessionSnapshots } from './sessionSnapshots'
import { createSettingsRepo } from '../db/settingsRepo'
import { createSettingsHandlers } from '../api/settings.ipc'
import { tx } from '../db/tx'

const WEEK = '2026-07-06'
const dbs: DatabaseSync[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })
const line = (timestamp: string, cwd = '/work/project'): string => JSON.stringify({
  type: 'user', timestamp, cwd, gitBranch: 'feature/ABC-12', message: { content: 'Implement search' }
})
function setup(content: string, cwd = '/synthetic/intersect', database?: DatabaseSync) {
  const db = database ?? makeTestDb()
  if (!dbs.includes(db)) dbs.push(db)
  const deps = makeTestDeps()
  const files = new Map([['/synthetic/project/session.jsonl', content]])
  const sessions = createSessionIndex({ readDir: async () => [...files.keys()], readFile: async p => files.get(p)!,
    canReadFile: async p => files.has(p) })
  const snapshots = createTimeSessionDayRepo(db, deps.now)
  const settingsRepo = createSettingsRepo(db)
  if (!database) settingsRepo.setTimeTracking({ excludedPathPrefixes: ['/excluded'] })
  const settings = () => settingsRepo.getTimeTracking()
  const changed = vi.fn()
  const scanner = createSessionSnapshots({ sessions, snapshots, state: createAppStateRepo(db), settings,
    userDataDir: cwd, atomically: fn => tx(db, fn), changed, failed: () => {} })
  const service = createTimeTracking({ snapshots, scanner, isResumable: id => sessions.isResumable(id),
    settings, userDataDir: cwd, manual: createManualTimeEntryRepo(db, deps),
    overrides: createTimeOverrideRepo(db, deps), timer: createRunningTimerRepo(db, deps),
    now: deps.now, atomically: fn => tx(db, fn)
  })
  return { db, service, files, scanner, snapshots, settingsRepo, changed, sessions }
}

test('raw two-day activity yields two exact daily cards, never one moving session', async () => {
  const { service } = setup([
    line('2026-07-06T09:00:00'), line('2026-07-06T09:05:00'),
    line('2026-07-07T09:00:00'), line('2026-07-07T09:06:00')
  ].join('\n'))
  expect((await service.refreshWeek(WEEK)).map(e => [e.day, e.durationMs])).toEqual([
    ['2026-07-06', 900000], ['2026-07-07', 360000]
  ])
})

test.each([299000, 299999, 300000, 300001])('threshold uses measured milliseconds: %i', async duration => {
  const start = new Date('2026-07-06T09:00:00').getTime()
  const { service } = setup([line(new Date(start).toISOString()), line(new Date(start + duration).toISOString())].join('\n'))
  expect(await service.refreshWeek(WEEK)).toHaveLength(duration >= 300000 ? 1 : 0)
})

test.each(['/synthetic/intersect', '/synthetic/intersect/reviews/123', '/excluded/work'])('excluded cwd %s never contributes a card', async cwd => {
  const { service } = setup([line('2026-07-06T09:00:00', cwd), line('2026-07-06T09:06:00', cwd)].join('\n'))
  expect(await service.refreshWeek(WEEK)).toEqual([])
})

test('a deleted source transcript cannot erase a previously captured card', async () => {
  const { service, files } = setup([line('2026-07-06T09:00:00'), line('2026-07-06T09:06:00')].join('\n'))
  const before = await service.refreshWeek(WEEK)
  expect(before).toHaveLength(1)
  files.clear()
  expect(await service.refreshWeek(WEEK)).toEqual(before.map(entry => entry.source === 'auto'
    ? { ...entry, resumable: false } : entry))
})

test('migration keeps every legacy field without guessing a work day', () => {
  const db = new DatabaseSync(':memory:')
  dbs.push(db)
  runMigrations(db, 30)
  db.prepare('INSERT INTO time_entry_override (session_id, description, issue_key, duration_ms, deleted, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('missing', null, null, 123456, 1, 42)
  runMigrations(db)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name)
  expect(tables).toContain('time_entry_override_legacy')
  expect(db.prepare('SELECT * FROM time_entry_override_legacy').all()).toEqual([
    { session_id: 'missing', description: null, issue_key: null, duration_ms: 123456, deleted: 1, updated_at: 42 }
  ])
  expect(db.prepare('SELECT * FROM time_entry_override').all()).toEqual([])
})

const twoDays = [line('2026-07-06T09:00:00'), line('2026-07-06T09:05:00'),
  line('2026-07-07T09:00:00'), line('2026-07-07T09:06:00')].join('\n')
const ref = (day = WEEK) => ({ source: 'auto' as const, sessionId: 'session', day })
const edit = { description: 'Owner text', issueKey: null, durationMs: 60000 }

test('editing only time or issue key leaves description free for a later summary', async () => {
  const t = setup(twoDays)
  const [before] = await t.service.refreshWeek(WEEK)
  await t.service.updateEntry(ref(), { description: before.description,
    issueKey: 'ABC-12', durationMs: 60000 })
  expect(t.db.prepare(`SELECT description FROM time_entry_override WHERE session_id = 'session'
    AND day = '2026-07-06'`).get()).toEqual({ description: null })
  t.snapshots.saveSummary('session', WEEK, before.source === 'auto' ? before.lastTimestamp : 0,
    { summary: 'Nový popis práce.', isWork: true })
  expect((await t.service.getWeek(WEEK))[0].description).toBe('Nový popis práce.')
})

test('first continuation adds the capped gap to Monday, later Tuesday activity never changes Monday', async () => {
  const t = setup(twoDays.split('\n').slice(0, 2).join('\n'))
  expect((await t.service.refreshWeek(WEEK))[0].durationMs).toBe(300000)
  t.files.set('/synthetic/project/session.jsonl', twoDays)
  const first = await t.service.refreshWeek(WEEK)
  expect(first.map(e => e.durationMs)).toEqual([900000, 360000])
  t.files.set('/synthetic/project/session.jsonl', twoDays + '\n' + line('2026-07-07T09:10:00'))
  const later = await t.service.refreshWeek(WEEK)
  expect(later[0]).toEqual(first[0])
  expect(later[1].durationMs).toBe(600000)
})

test('edited one-minute auto card and one-minute manual entry survive source deletion and service restart', async () => {
  const t = setup(twoDays)
  await t.service.refreshWeek(WEEK)
  await t.service.updateEntry(ref(), edit)
  t.service.addManual({ ...edit, day: WEEK })
  const before = await t.service.getWeek(WEEK)
  expect(before.filter(e => e.source === 'auto').every(e => e.resumable)).toBe(true)
  t.files.clear()
  const withoutTranscript = before.map(entry => entry.source === 'auto'
    ? { ...entry, resumable: false } : entry)
  expect(await t.service.refreshWeek(WEEK)).toEqual(withoutTranscript)
  t.scanner.dispose()
  const restarted = setup('', '/synthetic/intersect', t.db)
  restarted.files.clear()
  expect(await restarted.service.refreshWeek(WEEK)).toEqual(withoutTranscript)
  await restarted.service.updateEntry(ref(), { ...edit, description: 'After deletion' })
  expect((await restarted.service.getWeek(WEEK))[0].description).toBe('After deletion')
  await restarted.service.deleteEntry(ref())
  expect((await restarted.service.getWeek(WEEK)).filter(e => e.source === 'auto').map(e => e.day)).toEqual(['2026-07-07'])
  const again = setup('', '/synthetic/intersect', t.db)
  again.files.clear()
  expect((await again.service.refreshWeek(WEEK)).filter(e => e.source === 'auto').map(e => e.day)).toEqual(['2026-07-07'])
})

test('settings handler hides and restores persisted edited cards even without transcripts', async () => {
  const t = setup(twoDays)
  await t.service.refreshWeek(WEEK)
  await t.service.updateEntry(ref(), edit)
  const expected = await t.service.getWeek(WEEK)
  t.files.clear()
  const withoutTranscript = expected.map(entry => entry.source === 'auto'
    ? { ...entry, resumable: false } : entry)
  const handler = createSettingsHandlers({ settings: t.settingsRepo,
    installTimeCli: () => '/tmp/intersect-time',
    fallbackAdo: () => ({ orgUrl: '', project: '', repository: '', pat: '' }),
    testConnection: vi.fn(), adoSettingsChanged: async () => {},
    timeTrackingChanged: () => { void t.scanner.scan() } })
  await handler.setTimeTracking({ excludedPathPrefixes: [' /work/proj ', '', '/work/proj'] })
  expect(t.settingsRepo.getTimeTracking()).toEqual({ excludedPathPrefixes: ['/work/proj'] })
  expect(await t.service.refreshWeek(WEEK)).toEqual([])
  await handler.setTimeTracking({ excludedPathPrefixes: [] })
  expect(await t.service.refreshWeek(WEEK)).toEqual(withoutTranscript)
  await handler.setTimeTracking({ excludedPathPrefixes: ['/work/project/'] })
  expect(await t.service.refreshWeek(WEEK)).toEqual(withoutTranscript)
  for (const invalid of [null, {}, { excludedPathPrefixes: 'x' }, { excludedPathPrefixes: [2] },
    { excludedPathPrefixes: ['relative'] }, { excludedPathPrefixes: ['/a\u0000b'] }]) {
    await expect(handler.setTimeTracking(invalid as never)).rejects.toThrow()
  }
})

test('short measurements accumulate before threshold, and weekend/zero days are stored but not displayed', async () => {
  const start = new Date('2026-07-06T09:00:00').getTime()
  const records = Array.from({ length: 11 }, (_, i) => line(new Date(start + i * 29999).toISOString()))
  const t = setup(records.join('\n'))
  expect(await t.service.refreshWeek(WEEK)).toEqual([])
  expect(t.snapshots.get('session', WEEK)?.activeDurationMs).toBe(299990)
  records.push(line(new Date(start + 300000).toISOString()))
  t.files.set('/synthetic/project/session.jsonl', records.join('\n'))
  expect((await t.service.refreshWeek(WEEK))[0].durationMs).toBe(300000)
  t.files.set('/synthetic/project/session.jsonl', records.concat(line('2026-07-11T09:00:00'), line('2026-07-11T09:05:00'), line('2026-07-12T09:00:00')).join('\n'))
  expect(await t.service.refreshWeek(WEEK)).toHaveLength(1)
  expect(t.snapshots.get('session', '2026-07-11')?.activeDurationMs).toBe(900000)
  expect(t.snapshots.get('session', '2026-07-12')?.activeDurationMs).toBe(0)
})

function legacyDb() {
  const db = new DatabaseSync(':memory:')
  runMigrations(db, 30)
  const insert = db.prepare(`INSERT INTO time_entry_override
    (session_id, description, issue_key, duration_ms, deleted, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
  insert.run('session', 'Legacy text', null, 7200123, 0, 42)
  insert.run('deleted', null, 'ABC-8', 13, 1, 43)
  insert.run('missing', 'Absent', null, 14, 0, 44)
  insert.run('invalid', 'No date', 'ABC-9', 15, 0, 45)
  runMigrations(db)
  return db
}

test('legacy adoption preserves exact values on last day once, retaining absent and invalid-time records', async () => {
  const t = setup(twoDays, '/synthetic/intersect', legacyDb())
  t.files.set('/synthetic/project/deleted.jsonl', twoDays)
  t.files.set('/synthetic/project/invalid.jsonl', line('invalid'))
  await t.service.refreshWeek(WEEK)
  expect(t.db.prepare('SELECT * FROM time_entry_override ORDER BY session_id').all()).toEqual([
    { session_id: 'deleted', day: '2026-07-07', description: null, issue_key: 'ABC-8', duration_ms: 13, deleted: 1, updated_at: 43 },
    { session_id: 'session', day: '2026-07-07', description: 'Legacy text', issue_key: null, duration_ms: 7200123, deleted: 0, updated_at: 42 }
  ])
  const unresolved = t.db.prepare('SELECT * FROM time_entry_override_legacy ORDER BY session_id').all()
  expect(unresolved).toEqual([
    { session_id: 'invalid', description: 'No date', issue_key: 'ABC-9', duration_ms: 15, deleted: 0, updated_at: 45 },
    { session_id: 'missing', description: 'Absent', issue_key: null, duration_ms: 14, deleted: 0, updated_at: 44 }
  ])
  t.files.set('/synthetic/project/session.jsonl', twoDays + '\n' + line('2026-07-08T09:00:00'))
  await t.service.refreshWeek(WEEK)
  expect(t.db.prepare("SELECT day, duration_ms, updated_at FROM time_entry_override WHERE session_id='session'").get())
    .toEqual({ day: '2026-07-07', duration_ms: 7200123, updated_at: 42 })
  expect(t.db.prepare('SELECT * FROM time_entry_override_legacy ORDER BY session_id').all()).toEqual(unresolved)
  t.files.set('/synthetic/project/missing.jsonl', twoDays)
  await t.service.refreshWeek(WEEK)
  expect(t.db.prepare("SELECT updated_at FROM time_entry_override WHERE session_id='missing'").get()).toEqual({ updated_at: 44 })
})

test('adoption transaction rolls back snapshots and preserves the original legacy row on failure', async () => {
  const t = setup(twoDays, '/synthetic/intersect', legacyDb())
  t.db.exec(`CREATE TRIGGER reject_adoption BEFORE INSERT ON time_entry_override
    BEGIN SELECT RAISE(ABORT, 'injected adoption failure'); END`)
  await expect(t.scanner.scan()).rejects.toThrow('injected adoption failure')
  expect(t.db.prepare('SELECT * FROM time_session_day').all()).toEqual([])
  expect(t.db.prepare('SELECT * FROM time_entry_override_legacy').all()).toHaveLength(4)
  t.db.exec('DROP TRIGGER reject_adoption')
  await t.scanner.scan()
  expect(t.db.prepare('SELECT * FROM time_entry_override_legacy').all()).toHaveLength(3)
})

test('conflicting day override wins without discarding unresolved legacy data', async () => {
  const t = setup(twoDays, '/synthetic/intersect', legacyDb())
  t.snapshots.upsert({ sessionId: 'session', day: '2026-07-07', title: '', cwd: '', gitBranch: null,
    autoDescription: '', firstTimestamp: 1, lastTimestamp: 2, activeDurationMs: 300000 })
  createTimeOverrideRepo(t.db, makeTestDeps()).upsert('session', '2026-07-07', { ...edit, deleted: false })
  await t.scanner.scan()
  expect((await t.service.getWeek(WEEK))[1].description).toBe('Owner text')
  expect(t.db.prepare("SELECT updated_at FROM time_entry_override_legacy WHERE session_id='session'").get()).toEqual({ updated_at: 42 })
})

test('own-data legacy records are retained without snapshots; same-name sibling is visible', async () => {
  const t = setup(twoDays.replaceAll('/work/project', '/synthetic/intersect'), '/synthetic/intersect', legacyDb())
  await t.scanner.scan()
  expect(t.db.prepare('SELECT * FROM time_session_day').all()).toEqual([])
  expect(t.db.prepare('SELECT * FROM time_entry_override_legacy').all()).toHaveLength(4)
  t.files.set('/synthetic/project/sibling.jsonl', twoDays.replaceAll('/work/project', '/synthetic/intersect-old'))
  expect(await t.service.refreshWeek(WEEK)).toHaveLength(2)
  // A captured row is filtered on reads even if its transcript no longer exists.
  t.snapshots.upsert({ sessionId: 'own', day: WEEK, title: 'Internal', cwd: '/synthetic/intersect/reviews',
    gitBranch: null, autoDescription: 'Internal', firstTimestamp: 1, lastTimestamp: 2, activeDurationMs: 999999 })
  t.files.clear()
  expect(await t.service.refreshWeek(WEEK)).toHaveLength(2)
})

test('split and overlapping sessions plus manual/edited/hidden rows produce exact weekday totals', async () => {
  const t = setup(twoDays)
  t.files.set('/synthetic/project/overlap.jsonl', twoDays)
  t.files.set('/synthetic/project/short.jsonl', [line('2026-07-06T09:00:00'), line('2026-07-06T09:04:59')].join('\n'))
  t.files.set('/synthetic/project/hidden.jsonl', twoDays.replaceAll('/work/project', '/excluded/work'))
  await t.service.refreshWeek(WEEK)
  await t.service.updateEntry(ref(), edit)
  await t.service.deleteEntry({ source: 'auto', sessionId: 'overlap', day: '2026-07-07' })
  t.service.addManual({ ...edit, day: WEEK })
  const entries = await t.service.getWeek(WEEK)
  expect(entries.filter(e => e.day === WEEK).reduce((sum, e) => sum + e.durationMs, 0)).toBe(1020000)
  expect(entries.filter(e => e.day === '2026-07-07').reduce((sum, e) => sum + e.durationMs, 0)).toBe(360000)
  expect(entries.reduce((sum, e) => sum + e.durationMs, 0)).toBe(1380000)
})

test.each([{}, { source: 'unknown' }, { source: 'auto', sessionId: 'session', day: '2026-02-30' },
  { source: 'auto', sessionId: 'session' }, { source: 'manual' }])('malformed reference is rejected: %j', async value => {
  const t = setup(twoDays)
  await expect(t.service.updateEntry(value as never, edit)).rejects.toThrow('Invalid entry reference')
  await expect(t.service.deleteEntry(value as never)).rejects.toThrow('Invalid entry reference')
})


test('new session title updates metadata while owner description wins and missing branch remains null', async () => {
  const t = setup(twoDays.replaceAll('feature/ABC-12', ''))
  await t.service.refreshWeek(WEEK)
  await t.service.updateEntry(ref(), edit)
  t.files.set('/synthetic/project/session.jsonl', JSON.stringify({ type: 'ai-title', aiTitle: 'New title' }) + '\n' + twoDays.replaceAll('feature/ABC-12', ''))
  const rows = await t.service.refreshWeek(WEEK)
  expect(rows[0]).toMatchObject({ source: 'auto', description: 'Owner text', resumable: true })
  expect(rows[1]).toMatchObject({ source: 'auto', description: 'New title', resumable: true })
  expect(rows[0]).not.toHaveProperty('sessionTitle')
  expect(rows[0]).not.toHaveProperty('gitBranch')
  expect(t.snapshots.get('session', WEEK)).toMatchObject({ title: 'New title', gitBranch: null,
    cwd: '/work/project' })
})
