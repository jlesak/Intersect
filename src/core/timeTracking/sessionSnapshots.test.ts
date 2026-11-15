import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { makeTestDb, makeTestDeps } from '../db/testkit'
import { createAppStateRepo } from '../db/appStateRepo'
import { createTimeSessionDayRepo } from '../db/timeSessionDayRepo'
import { createSessionIndex } from '../sessions/sessionIndex'
import { tx } from '../db/tx'
import { createSessionSnapshots, TRACKING_ZONE_KEY } from './sessionSnapshots'
import { insideAppData } from './exclusions'

const cleanup: (() => void)[] = []
afterEach(() => { vi.useRealTimers(); for (const fn of cleanup.splice(0).reverse()) fn() })
const raw = [0, 6].map(minute => JSON.stringify({ type: 'user', cwd: '/work/project',
  timestamp: `2026-07-06T22:0${minute}:00Z`, message: { content: 'Work' } })).join('\n')
function setup(readFile: () => Promise<string> = async () => raw) {
  const db = makeTestDb()
  cleanup.push(() => db.close())
  const state = createAppStateRepo(db)
  const snapshots = createTimeSessionDayRepo(db, makeTestDeps().now)
  const readDir = vi.fn(async () => ['/fixture/session.jsonl'])
  const index = createSessionIndex({ readDir, readFile })
  const changed = vi.fn()
  const failed = vi.fn()
  let prefixes: string[] = []
  let zone = 'Europe/Prague'
  const scanner = createSessionSnapshots({ sessions: index, snapshots, state,
    userDataDir: '/synthetic/intersect', settings: () => ({ excludedPathPrefixes: prefixes }),
    atomically: fn => tx(db, fn), changed, failed, systemTimeZone: () => zone })
  cleanup.push(() => scanner.dispose())
  return { db, state, snapshots, index, readDir, changed, failed, scanner,
    setPrefixes: (value: string[]) => { prefixes = value }, setZone: (value: string) => { zone = value } }
}

test('boot captures before board visit, timer runs at ten minutes and unchanged scans do not push', async () => {
  vi.useFakeTimers()
  const t = setup()
  t.scanner.start()
  await t.scanner.ready()
  expect(t.snapshots.get('session', '2026-07-07')?.activeDurationMs).toBe(360000)
  expect(t.readDir).toHaveBeenCalledTimes(1)
  expect(t.changed).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(599999)
  expect(t.readDir).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(t.readDir).toHaveBeenCalledTimes(2)
  expect(t.changed).toHaveBeenCalledTimes(1)
  t.scanner.dispose()
  await vi.advanceTimersByTimeAsync(600000)
  expect(t.readDir).toHaveBeenCalledTimes(2)
})

test('coalesces index and scanner requests; settings at completion win over old settings', async () => {
  let finish!: (text: string) => void
  const t = setup(() => new Promise(resolve => { finish = resolve }))
  const first = t.scanner.scan()
  const second = t.scanner.scan()
  expect(second).toBe(first)
  const list = t.index.list()
  const refresh = t.index.refresh()
  await Promise.resolve()
  t.setPrefixes(['/work'])
  finish(raw)
  await Promise.all([first, second, list, refresh])
  expect(t.readDir).toHaveBeenCalledTimes(1)
  expect(t.changed).toHaveBeenCalledTimes(1)
  // The next scan with the same settings must not emit a spurious settings change.
  const next = t.scanner.scan()
  await Promise.resolve()
  finish(raw)
  await next
  expect(t.changed).toHaveBeenCalledTimes(1)
})

test('dispose before unresolved read finishes prevents all access to a closed DB and pushes', async () => {
  let finish!: (text: string) => void
  const t = setup(() => new Promise(resolve => { finish = resolve }))
  const scan = t.scanner.scan()
  await Promise.resolve()
  t.scanner.dispose()
  t.db.close()
  // DB already closed, remove its cleanup while keeping scanner cleanup.
  cleanup.splice(0, 1)
  finish(raw)
  await expect(scan).resolves.toBeUndefined()
  expect(t.changed).not.toHaveBeenCalled()
  await expect(t.scanner.scan()).resolves.toBeUndefined()
})

test('failed refresh retains persisted snapshots and can retry; no failure push', async () => {
  const t = setup()
  await t.scanner.scan()
  const before = t.snapshots.get('session', '2026-07-07')
  t.readDir.mockRejectedValueOnce(new Error('synthetic read failure'))
  await expect(t.scanner.scan()).rejects.toThrow('synthetic read failure')
  expect(t.snapshots.get('session', '2026-07-07')).toEqual(before)
  expect(t.changed).toHaveBeenCalledTimes(1)
  await t.scanner.scan()
  expect(t.snapshots.get('session', '2026-07-07')).toEqual(before)
})

test('initial failure is logged and a later scan succeeds', async () => {
  const t = setup()
  t.readDir.mockRejectedValueOnce(new Error('synthetic read failure'))
  t.scanner.start()
  await t.scanner.ready()
  expect(t.failed).toHaveBeenCalledTimes(1)
  expect(t.changed).not.toHaveBeenCalled()
  await t.scanner.scan()
  expect(t.snapshots.get('session', '2026-07-07')).toBeDefined()
})

test('persisted IANA zone prevents duplicate/moving day keys after machine zone changes', async () => {
  const t = setup()
  await t.scanner.scan()
  expect(t.state.get(TRACKING_ZONE_KEY)).toBe('Europe/Prague')
  t.setZone('America/Los_Angeles')
  await t.scanner.scan()
  expect(t.snapshots.get('session', '2026-07-06')).toBeUndefined()
  expect(t.snapshots.get('session', '2026-07-07')?.activeDurationMs).toBe(360000)
})

test('canonical own-data exclusion handles symlink aliases, missing tails and sibling names', () => {
  const root = mkdtempSync(join(tmpdir(), 'intersect-snapshot-path-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const data = join(root, 'data')
  mkdirSync(data)
  symlinkSync(data, join(root, 'alias'))
  expect(insideAppData(data, data)).toBe(true)
  expect(insideAppData(join(root, 'alias', 'missing', 'worktree'), data)).toBe(true)
  expect(insideAppData(join(root, 'data-old'), data)).toBe(false)
})

test('real index imports only top-level transcript files, never nested subagents', async () => {
  const root = mkdtempSync(join(tmpdir(), 'intersect-snapshot-index-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'project', 'session', 'subagents'), { recursive: true })
  writeFileSync(join(root, 'project', 'session.jsonl'), raw)
  writeFileSync(join(root, 'project', 'session', 'subagents', 'agent.jsonl'), raw)
  const index = createSessionIndex({ projectsDir: root })
  expect((await index.scan()).map(s => s.summary.id)).toEqual(['session'])
})
