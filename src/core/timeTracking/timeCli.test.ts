import { afterEach, expect, test } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { makeTestDb, makeTestDeps } from '../db/testkit'
import { createManualTimeEntryRepo, createRunningTimerRepo, createTimeOverrideRepo } from '../db/timeTrackingRepo'
import { createTimeSessionDayRepo } from '../db/timeSessionDayRepo'
import { createTimeEntryGroupRepo } from '../db/timeEntryGroupRepo'
import { tx } from '../db/tx'
import { createTimeTracking } from './timeTracking'
import { createTimeCliDispatcher, TIME_CLI_ROUTES } from './timeCliDispatch'
import { startTimeCliServer } from './timeCliServer'
import { installTimeCliShim } from './timeCliInstall'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function setup(now = Date.UTC(2026, 10, 25), zone = 'Europe/Prague') {
  const db = makeTestDb()
  const deps = makeTestDeps()
  const day = '2026-11-25'
  const manual = createManualTimeEntryRepo(db, deps)
  const groups = createTimeEntryGroupRepo(db, deps)
  const snapshots = createTimeSessionDayRepo(db, deps.now)
  const service = createTimeTracking({
    snapshots,
    scanner: { ready: async () => {}, scan: async () => {}, start() {}, dispose() {} },
    isResumable: async () => false, settings: () => ({ excludedPathPrefixes: [] }),
    userDataDir: '/intersect', manual, groups, overrides: createTimeOverrideRepo(db, deps),
    timer: createRunningTimerRepo(db, deps), now: deps.now, atomically: fn => tx(db, fn)
  })
  let broadcasts = 0
  const synced = new Set<string>()
  const dispatch = createTimeCliDispatcher({ service, db, groups, now: () => now,
    zone: () => zone, scannerReady: async () => {},
    changed: () => { broadcasts++ }, isSynced: ref => synced.has(ref) })
  return { db, day, dispatch, synced, snapshots, get broadcasts() { return broadcasts } }
}

test('CLI writes commit one audit row and broadcast only after a successful mutation', async () => {
  const t = setup()
  expect(TIME_CLI_ROUTES).toEqual(['list', 'add', 'edit', 'delete', 'group', 'ungroup'])
  const add = await t.dispatch({ command: 'add', actor: 'codex', day: t.day,
    duration: '45m', description: 'Review', issue: 'abc-1' })
  expect(add.code).toBe(0)
  expect(t.db.prepare('SELECT actor, action FROM time_entry_audit').all()).toEqual([
    { actor: 'codex', action: 'add' }
  ])
  expect(t.broadcasts).toBe(1)
  expect((await t.dispatch({ command: 'list', day: t.day })).value).toEqual([
    expect.objectContaining({ ref: expect.stringMatching(/^manual:/), issueKey: 'ABC-1',
      durationMs: 2_700_000 })
  ])
  expect((await t.dispatch({ command: 'add', actor: 'bot', day: t.day,
    duration: '45m', description: 'No' })).code).toBe(2)
  expect(t.db.prepare('SELECT count(*) AS n FROM time_entry_audit').get()).toEqual({ n: 1 })
  t.db.close()
})

test('real socket rotates token, restricts file modes, and rejects unauthenticated requests', async () => {
  const t = setup()
  const root = mkdtempSync(join(tmpdir(), 'intersect-time-test-'))
  dirs.push(root)
  const send = (token: string) => new Promise<string>((resolve, reject) => {
    const socket = createConnection(join(root, 'time-cli', 'time.sock'))
    let reply = ''
    socket.on('data', chunk => { reply += chunk.toString() })
    socket.on('end', () => resolve(reply))
    socket.on('error', reject)
    socket.end(JSON.stringify({ token, request: { command: 'list', day: t.day } }))
  })
  const first = await startTimeCliServer(root, t.dispatch)
  const tokenFile = join(root, 'time-cli', 'token')
  const token = readFileSync(tokenFile, 'utf8').trim()
  expect(statSync(join(root, 'time-cli')).mode & 0o777).toBe(0o700)
  expect(statSync(tokenFile).mode & 0o777).toBe(0o600)
  expect(statSync(join(root, 'time-cli', 'time.sock')).mode & 0o777).toBe(0o600)
  expect(JSON.parse(await send('wrong')).code).toBe(4)
  expect(JSON.parse(await send('')).code).toBe(4)
  expect(JSON.parse(await send(token)).code).toBe(0)
  const raw = (body: string) => new Promise<string>((resolve, reject) => {
    const socket = createConnection(join(root, 'time-cli', 'time.sock'))
    let reply = ''
    socket.on('data', chunk => { reply += chunk.toString() })
    socket.on('end', () => resolve(reply))
    socket.on('error', reject)
    socket.end(body)
  })
  const unknown = await raw(JSON.stringify({ token, request: { command: 'jiraUpload' } }))
  expect(JSON.parse(unknown).code).toBe(2)
  const oversized = await raw(JSON.stringify({ token, request: { command: 'add',
    actor: 'user', day: t.day, duration: '1m', description: 'A'.repeat(17_000) } }))
  expect(JSON.parse(oversized).code).toBe(2)
  expect(t.db.prepare('SELECT count(*) AS n FROM time_entry_audit').get()).toEqual({ n: 0 })
  await first.stop()
  const second = await startTimeCliServer(root, t.dispatch)
  expect(readFileSync(tokenFile, 'utf8').trim()).not.toBe(token)
  expect(JSON.parse(await send(token)).code).toBe(4)
  await second.stop()
  t.db.close()
})

test('a timed-out request cannot mutate after scanner readiness resolves', async () => {
  const t = setup()
  const root = mkdtempSync(join(tmpdir(), 'intersect-time-timeout-'))
  dirs.push(root)
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const dispatch = createTimeCliDispatcher({ service: createTimeTracking({
    snapshots: createTimeSessionDayRepo(t.db, makeTestDeps().now),
    scanner: { ready: async () => {}, scan: async () => {}, start() {}, dispose() {} },
    isResumable: async () => false, settings: () => ({ excludedPathPrefixes: [] }),
    userDataDir: '/intersect', manual: createManualTimeEntryRepo(t.db, makeTestDeps()),
    groups: createTimeEntryGroupRepo(t.db, makeTestDeps()),
    overrides: createTimeOverrideRepo(t.db, makeTestDeps()),
    timer: createRunningTimerRepo(t.db, makeTestDeps()), now: Date.now,
    atomically: fn => tx(t.db, fn) }), db: t.db,
  groups: createTimeEntryGroupRepo(t.db, makeTestDeps()), now: () => Date.UTC(2026, 10, 25),
  zone: () => 'UTC', scannerReady: () => pending, changed: () => {}, isSynced: () => false })
  const server = await startTimeCliServer(root, dispatch)
  const token = readFileSync(server.tokenPath, 'utf8').trim()
  const response = new Promise<string>((resolve, reject) => {
    const socket = createConnection(server.socketPath)
    let text = ''
    socket.on('data', chunk => { text += chunk.toString() })
    socket.on('end', () => resolve(text))
    socket.on('error', reject)
    socket.end(JSON.stringify({ token, request: { command: 'add', actor: 'user',
      day: t.day, duration: '1m', description: 'Late' } }))
  })
  expect(JSON.parse(await response).code).toBe(1)
  release()
  await new Promise(resolve => setImmediate(resolve))
  expect(t.db.prepare('SELECT count(*) AS n FROM time_entry_audit').get()).toEqual({ n: 0 })
  await server.stop()
  t.db.close()
})

test('validation rejects invalid boundaries and weekends remain listable', async () => {
  const t = setup()
  const valid = { command: 'add', actor: 'codex', day: '2026-11-21',
    duration: '1h30m', description: 'Weekend work', issue: 'abc-1' }
  expect((await t.dispatch(valid)).code).toBe(0)
  expect((await t.dispatch({ command: 'list', day: valid.day })).value).toEqual([
    expect.objectContaining({ source: 'manual', day: valid.day })
  ])
  expect((await t.dispatch({ command: 'list', day: '2026-10-24' })).code).toBe(2)
  const invalid = [
    { day: '2026-02-30' }, { day: '9999-99-99' }, { day: '2026-10-24' },
    { day: '2026-11-26' },
    { duration: '0m' }, { duration: '12h1m' }, { duration: '1:30' },
    { description: '   ' }, { description: 'a'.repeat(256) }, { description: 'bad\u0000data' },
    { issue: 'A-0' }, { issue: 'bad key' }, { actor: 'robot' }
  ]
  for (const bad of invalid) expect((await t.dispatch({ ...valid, ...bad })).code).toBe(2)
  expect(t.db.prepare('SELECT count(*) AS n FROM time_entry_audit').get()).toEqual({ n: 1 })
  t.db.close()
})

test('list exposes exact auto, manual and group refs with required fields', async () => {
  const t = setup()
  t.snapshots.upsert({ sessionId: 'session-1', day: t.day, title: 'Synthetic',
    cwd: '/work', gitBranch: 'feature/abc-1-work', autoDescription: 'Auto work',
    firstTimestamp: 1, lastTimestamp: 2, activeDurationMs: 600_000 })
  const manual = (await t.dispatch({ command: 'add', actor: 'user', day: t.day,
    duration: '10m', description: 'Manual work' })).value as { ref: string }
  expect((await t.dispatch({ command: 'list', day: t.day })).value).toEqual([
    expect.objectContaining({ ref: `auto:session-1:${t.day}`, source: 'auto',
      description: 'Auto work', issueKey: 'ABC-1', durationMs: 600_000 }),
    expect.objectContaining({ ref: manual.ref, source: 'manual',
      description: 'Manual work', issueKey: null, durationMs: 600_000 })
  ])
  const grouped = (await t.dispatch({ command: 'group', actor: 'codex',
    refs: [`auto:session-1:${t.day}`, manual.ref] })).value as { ref: string }
  expect((await t.dispatch({ command: 'list', day: t.day })).value).toEqual([
    expect.objectContaining({ ref: grouped.ref, source: 'group',
      description: 'Auto work; Manual work', issueKey: null, durationMs: 1_200_000 })
  ])
  t.db.close()
})

test('the saved zone determines the accepted calendar day', async () => {
  const t = setup(Date.UTC(2026, 10, 25, 23, 30))
  expect((await t.dispatch({ command: 'add', actor: 'user', day: '2026-11-26',
    duration: '1m', description: 'After local midnight' })).code).toBe(0)
  expect((await t.dispatch({ command: 'list', day: '2026-11-26' })).code).toBe(0)
  t.db.close()
})

test('group, edit, ungroup and delete are audited once each and reject old resolved refs', async () => {
  const t = setup()
  const add = async (description: string) => (await t.dispatch({ command: 'add', actor: 'user',
    day: t.day, duration: '30m', description })).value as { ref: string }
  const a = await add('A')
  const b = await add('B')
  const grouped = await t.dispatch({ command: 'group', actor: 'codex', refs: [a.ref, b.ref] })
  expect(grouped.code).toBe(0)
  const groupRef = (grouped.value as { ref: string }).ref
  expect((await t.dispatch({ command: 'edit', actor: 'claude', ref: groupRef,
    description: 'Combined', duration: '1h' })).code).toBe(0)
  expect((await t.dispatch({ command: 'ungroup', actor: 'user', ref: groupRef })).code).toBe(0)
  expect((await t.dispatch({ command: 'delete', actor: 'user', ref: a.ref })).code).toBe(0)
  expect(t.db.prepare('SELECT actor, action FROM time_entry_audit ORDER BY id').all()).toEqual([
    { actor: 'user', action: 'add' }, { actor: 'user', action: 'add' },
    { actor: 'codex', action: 'group' }, { actor: 'claude', action: 'edit' },
    { actor: 'user', action: 'ungroup' }, { actor: 'user', action: 'delete' }
  ])
  expect((await t.dispatch({ command: 'edit', actor: 'user', ref: a.ref,
    duration: '1m' })).code).toBe(2)
  t.db.prepare(`INSERT INTO time_entry_manual
    (id, day, description, issue_key, duration_ms, created_at)
    VALUES ('old', '2026-10-24', 'Old', NULL, 60000, 1)`).run()
  expect((await t.dispatch({ command: 'edit', actor: 'user', ref: 'manual:old',
    duration: '2m' })).code).toBe(2)
  t.db.close()
})

test('audit rows preserve before and after values for every CLI write', async () => {
  const t = setup()
  const add = async (description: string, duration: string) => {
    const result = await t.dispatch({ command: 'add', actor: 'user', day: t.day,
      duration, description })
    expect(result.code).toBe(0)
    return (result.value as { ref: string }).ref
  }
  const first = await add('First', '30m')
  const second = await add('Second', '20m')
  expect((await t.dispatch({ command: 'edit', actor: 'codex', ref: first,
    duration: '45m', description: 'Edited', issue: 'abc-2' })).code).toBe(0)
  const grouped = await t.dispatch({ command: 'group', actor: 'claude', refs: [first, second] })
  expect(grouped.code).toBe(0)
  const group = (grouped.value as { ref: string }).ref
  expect((await t.dispatch({ command: 'ungroup', actor: 'user', ref: group })).code).toBe(0)
  expect((await t.dispatch({ command: 'delete', actor: 'user', ref: first })).code).toBe(0)

  const rows = t.db.prepare(`SELECT actor, action, ref, before_json, after_json
    FROM time_entry_audit ORDER BY id`).all() as unknown as Array<{
      actor: string; action: string; ref: string
      before_json: string | null; after_json: string | null
    }>
  const card = (ref: string, description: string, durationMs: number,
    issueKey: string | null = null) => ({ ref, source: ref.startsWith('group:') ? 'group' : 'manual',
    day: t.day, description, issueKey, durationMs })
  const original = card(first, 'First', 1_800_000)
  const edited = card(first, 'Edited', 2_700_000, 'ABC-2')
  const other = card(second, 'Second', 1_200_000)
  const combined = card(group, 'Edited; Second', 3_900_000)
  expect(rows.map(row => ({ actor: row.actor, action: row.action, ref: row.ref,
    before: row.before_json === null ? null : JSON.parse(row.before_json),
    after: row.after_json === null ? null : JSON.parse(row.after_json) }))).toEqual([
    { actor: 'user', action: 'add', ref: first, before: null, after: original },
    { actor: 'user', action: 'add', ref: second, before: null, after: other },
    { actor: 'codex', action: 'edit', ref: first, before: original,
      after: { ref: first, description: 'Edited', issueKey: 'ABC-2', durationMs: 2_700_000 } },
    { actor: 'claude', action: 'group', ref: group, before: [edited, other], after: combined },
    { actor: 'user', action: 'ungroup', ref: group, before: combined,
      after: [edited, other] },
    { actor: 'user', action: 'delete', ref: first, before: edited, after: null }
  ])
  t.db.close()
})

test('deleting a group audits delete-group and leaves both member entries intact', async () => {
  const t = setup()
  const add = async (description: string) => ((await t.dispatch({ command: 'add',
    actor: 'user', day: t.day, duration: '15m', description })).value as { ref: string }).ref
  const first = await add('First')
  const second = await add('Second')
  const group = (await t.dispatch({ command: 'group', actor: 'codex', refs: [first, second] }))
    .value as { ref: string }
  expect((await t.dispatch({ command: 'delete', actor: 'claude', ref: group.ref })).code).toBe(0)
  expect((await t.dispatch({ command: 'list', day: t.day })).value).toEqual([
    expect.objectContaining({ ref: first, description: 'First' }),
    expect.objectContaining({ ref: second, description: 'Second' })
  ])
  expect(t.db.prepare('SELECT count(*) AS n FROM time_entry_group').get()).toEqual({ n: 0 })
  expect(t.db.prepare('SELECT count(*) AS n FROM time_entry_manual').get()).toEqual({ n: 2 })
  const deletion = t.db.prepare(`SELECT actor, action, ref, before_json, after_json
    FROM time_entry_audit ORDER BY id DESC LIMIT 1`).get() as {
      actor: string; action: string; ref: string
      before_json: string | null; after_json: string | null
    }
  expect(deletion).toEqual({ actor: 'claude', action: 'delete-group', ref: group.ref,
    before_json: JSON.stringify({ ref: group.ref, source: 'group', day: t.day,
      description: 'First; Second', issueKey: null, durationMs: 1_800_000 }),
    after_json: null })
  t.db.close()
})

test('synced policy guards a group and its affected members before any write', async () => {
  const t = setup()
  const add = async (label: string) => ((await t.dispatch({ command: 'add', actor: 'user',
    day: t.day, duration: '1m', description: label })).value as { ref: string }).ref
  const a = await add('A')
  const b = await add('B')
  const group = (await t.dispatch({ command: 'group', actor: 'user', refs: [a, b] }))
    .value as { ref: string }
  t.synced.add(a)
  expect((await t.dispatch({ command: 'ungroup', actor: 'user', ref: group.ref })).code).toBe(4)
  expect((await t.dispatch({ command: 'edit', actor: 'user', ref: b,
    description: 'Changed' })).code).toBe(4)
  expect(t.db.prepare('SELECT count(*) AS n FROM time_entry_audit').get()).toEqual({ n: 3 })
  t.db.close()
})

test('an audit failure rolls the mutation back and sends no board change', async () => {
  const t = setup()
  t.db.exec('DROP TABLE time_entry_audit')
  expect((await t.dispatch({ command: 'add', actor: 'user', day: t.day,
    duration: '1m', description: 'Must roll back' })).code).toBe(1)
  expect(t.db.prepare('SELECT count(*) AS n FROM time_entry_manual').get()).toEqual({ n: 0 })
  expect(t.broadcasts).toBe(0)
  t.db.close()
})

test('61st write is refused until the rolling minute advances', async () => {
  const db = makeTestDb()
  const deps = makeTestDeps()
  const service = createTimeTracking({ snapshots: createTimeSessionDayRepo(db, deps.now),
    scanner: { ready: async () => {}, scan: async () => {}, start() {}, dispose() {} },
    isResumable: async () => false, settings: () => ({ excludedPathPrefixes: [] }),
    userDataDir: '/intersect', manual: createManualTimeEntryRepo(db, deps),
    groups: createTimeEntryGroupRepo(db, deps), overrides: createTimeOverrideRepo(db, deps),
    timer: createRunningTimerRepo(db, deps), now: deps.now, atomically: fn => tx(db, fn) })
  let now = Date.UTC(2026, 10, 25)
  const dispatch = createTimeCliDispatcher({ service, db,
    groups: createTimeEntryGroupRepo(db, deps), now: () => now, zone: () => 'UTC',
    scannerReady: async () => {}, changed: () => {}, isSynced: () => false })
  const input = { command: 'add', actor: 'codex', day: '2026-11-25',
    duration: '1m', description: 'A' }
  for (let i = 0; i < 60; i++) expect((await dispatch(input)).code).toBe(0)
  expect((await dispatch(input)).code).toBe(4)
  now += 60_001
  expect((await dispatch(input)).code).toBe(0)
  db.close()
})

test('shim is installed only by action and preserves unrelated files', () => {
  const home = mkdtempSync(join(tmpdir(), 'intersect-time-home-'))
  dirs.push(home)
  const target = join(home, '.local', 'bin', 'intersect-time')
  expect(existsSync(target)).toBe(false)
  expect(installTimeCliShim(home, '/Applications/Intersect.app/Contents/MacOS/Intersect',
    '/Applications/Intersect.app/Contents/Resources/app.asar/out/main/timeCli.js',
    '/tmp/profile with spaces')).toBe(target)
  expect(readFileSync(target, 'utf8')).toContain("INTERSECT_TIME_DATA_DIR='/tmp/profile with spaces'")
  expect(statSync(target).mode & 0o777).toBe(0o700)
  writeFileSync(target, '#!/bin/sh\necho unrelated\n')
  expect(() => installTimeCliShim(home, '/app', '/cli', '/profile'))
    .toThrow('An unrelated intersect-time file already exists')
  expect(readFileSync(target, 'utf8')).toBe('#!/bin/sh\necho unrelated\n')
})
