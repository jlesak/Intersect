import { afterEach, expect, test, vi } from 'vitest'
import { makeTestDb } from '../db/testkit'
import { createTimeSessionDayRepo } from '../db/timeSessionDayRepo'
import { createTimeOverrideRepo } from '../db/timeTrackingRepo'
import { createAppStateRepo } from '../db/appStateRepo'
import { createTimeSummaryScheduler, type TimeSummarySchedulerDeps } from './timeSummaryScheduler'

const DAY = '2026-07-06'
const end = Date.parse('2026-07-06T09:06:00Z')
const dbs: ReturnType<typeof makeTestDb>[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })

function setup() {
  const db = makeTestDb(); dbs.push(db)
  let now = end + 29 * 60_000 + 59_000
  const repo = createTimeSessionDayRepo(db, () => now)
  repo.upsert({ sessionId: 's1', day: DAY, title: 'Validation', cwd: '/work/project',
    gitBranch: 'feature/validation', autoDescription: 'Old fallback',
    firstTimestamp: end - 360_000, lastTimestamp: end, activeDurationMs: 360_000 })
  const state = createAppStateRepo(db)
  state.set('timeTracking.timeZone', 'UTC')
  const overrides = createTimeOverrideRepo(db, { now: () => now, newId: () => 'id' })
  const transcript = { id: 's1', title: 'Validation', cwd: '/work/project', entries: [
    { role: 'user' as const, timestamp: end, text: 'Oprav validaci', tools: [] }
  ] }
  let resumable = true
  const sessions = { isResumable: async () => resumable, getTranscript: async () => transcript }
  const summarize = vi.fn<TimeSummarySchedulerDeps['summarize']>(async () =>
    ({ summary: 'Oprava validace a testů.', isWork: false }))
  const changed = vi.fn(); const failed = vi.fn()
  const scheduler = createTimeSummaryScheduler({ snapshots: repo, overrides, sessions, state,
    scanner: { ready: async () => {} }, settings: () => ({ excludedPathPrefixes: [] }),
    userDataDir: '/synthetic/intersect', now: () => now, summarize, changed, failed,
    getTranscript: async () => transcript })
  return { db, repo, overrides, scheduler, summarize, changed, failed,
    setNow: (value: number) => { now = value },
    setResumable: (value: boolean) => { resumable = value } }
}

test('waits through 29:59, summarizes at 30 minutes, and replaces after later activity', async () => {
  const t = setup()
  await t.scheduler.tick()
  expect(t.summarize).not.toHaveBeenCalled()
  t.setNow(end + 30 * 60_000)
  await t.scheduler.tick()
  expect(t.repo.get('s1', DAY)).toMatchObject({
    summary: 'Oprava validace a testů.', isWork: false, summarizedThrough: end })
  expect(t.changed).toHaveBeenCalledTimes(1)
  const later = end + 60_000
  t.repo.upsert({ sessionId: 's1', day: DAY, title: 'Validation', cwd: '/work/project',
    gitBranch: 'feature/validation', autoDescription: 'Old fallback',
    firstTimestamp: end - 360_000, lastTimestamp: later, activeDurationMs: 420_000 })
  await t.scheduler.tick()
  expect(t.summarize).toHaveBeenCalledTimes(1)
  t.setNow(later + 30 * 60_000)
  await t.scheduler.tick()
  expect(t.summarize).toHaveBeenCalledTimes(2)
  expect(t.repo.get('s1', DAY)?.summarizedThrough).toBe(later)
})

test('confirmation survives regeneration and failure keeps prior accepted summary', async () => {
  const t = setup(); t.setNow(end + 30 * 60_000)
  await t.scheduler.tick()
  await t.scheduler.confirmWork({ source: 'auto', sessionId: 's1', day: DAY })
  expect(t.repo.get('s1', DAY)?.isWork).toBe(true)
  t.summarize.mockRejectedValueOnce(new Error('private model text'))
  await t.scheduler.regenerate({ source: 'auto', sessionId: 's1', day: DAY })
  await t.scheduler.tick()
  expect(t.repo.get('s1', DAY)).toMatchObject({
    summary: 'Oprava validace a testů.', summaryStatus: 'failed', isWork: true })
  expect(t.failed).toHaveBeenCalledWith('model-failed', 's1', DAY)
  await t.scheduler.regenerate({ source: 'auto', sessionId: 's1', day: DAY })
  await t.scheduler.tick()
  expect(t.repo.get('s1', DAY)).toMatchObject({ isWork: true, workConfirmed: true })
})

test('runs at most one model call and pauses for 30 minutes after three failures', async () => {
  const t = setup(); t.setNow(end + 30 * 60_000)
  t.repo.upsert({ sessionId: 's2', day: DAY, title: 'Other', cwd: '/work/other',
    gitBranch: null, autoDescription: 'Other fallback', firstTimestamp: end - 360_000,
    lastTimestamp: end, activeDurationMs: 360_000 })
  let release!: (result: { summary: string; isWork: boolean }) => void
  let active = 0; let maximum = 0
  t.summarize.mockImplementation(() => {
    active += 1; maximum = Math.max(maximum, active)
    return new Promise(resolve => { release = result => { active -= 1; resolve(result) } })
  })
  const first = t.scheduler.tick()
  const overlapping = t.scheduler.tick()
  expect(overlapping).toBe(first)
  await vi.waitFor(() => expect(t.summarize).toHaveBeenCalledTimes(1))
  release({ summary: 'Oprava prvního testu.', isWork: true })
  await vi.waitFor(() => expect(t.summarize).toHaveBeenCalledTimes(2))
  expect(maximum).toBe(1)
  release({ summary: 'Oprava druhého testu.', isWork: true })
  await first
  expect(maximum).toBe(1)

  t.summarize.mockRejectedValue(new Error('private model failure'))
  for (let i = 0; i < 3; i++) {
    await t.scheduler.regenerate({ source: 'auto', sessionId: 's1', day: DAY })
    await t.scheduler.tick()
  }
  expect(t.failed).toHaveBeenCalledTimes(3)
  const count = t.summarize.mock.calls.length
  await t.scheduler.regenerate({ source: 'auto', sessionId: 's1', day: DAY })
  await t.scheduler.tick()
  expect(t.summarize).toHaveBeenCalledTimes(count)
  t.setNow(end + 60 * 60_000)
  await t.scheduler.tick()
  expect(t.summarize).toHaveBeenCalledTimes(count + 1)
})

test('does not save a result after the snapshot becomes excluded or deleted', async () => {
  const t = setup(); t.setNow(end + 30 * 60_000)
  let release!: (result: { summary: string; isWork: boolean }) => void
  t.summarize.mockImplementation(() => new Promise(resolve => { release = resolve }))
  const pending = t.scheduler.tick()
  await vi.waitFor(() => expect(t.summarize).toHaveBeenCalledTimes(1))
  t.overrides.upsert('s1', DAY, { description: null, issueKey: null,
    durationMs: 360_000, deleted: true })
  release({ summary: 'Oprava validace.', isWork: true })
  await pending
  expect(t.repo.get('s1', DAY)?.summary).toBeNull()
})

test('missing transcript disables manual regeneration and leaves the saved summary alone', async () => {
  const t = setup(); t.setNow(end + 30 * 60_000)
  await t.scheduler.tick()
  t.setResumable(false)
  await expect(t.scheduler.regenerate({ source: 'auto', sessionId: 's1', day: DAY }))
    .rejects.toThrow('transcript is no longer available')
  expect(t.repo.get('s1', DAY)?.summary).toBe('Oprava validace a testů.')
  expect(t.summarize).toHaveBeenCalledTimes(1)
})

test('new activity during a model call prevents a stale result from being saved', async () => {
  const t = setup(); t.setNow(end + 30 * 60_000)
  let release!: (result: { summary: string; isWork: boolean }) => void
  t.summarize.mockImplementation(() => new Promise(resolve => { release = resolve }))
  const pending = t.scheduler.tick()
  await vi.waitFor(() => expect(t.summarize).toHaveBeenCalledTimes(1))
  t.repo.upsert({ sessionId: 's1', day: DAY, title: 'Validation', cwd: '/work/project',
    gitBranch: 'feature/validation', autoDescription: 'Old fallback',
    firstTimestamp: end - 360_000, lastTimestamp: end + 60_000, activeDurationMs: 420_000 })
  release({ summary: 'Zastaralá oprava.', isWork: false })
  await pending
  expect(t.repo.get('s1', DAY)?.summary).toBeNull()
})

test('disposing an active model call aborts its signal and saves no result', async () => {
  const t = setup(); t.setNow(end + 30 * 60_000)
  let signal!: AbortSignal
  let release!: (result: { summary: string; isWork: boolean }) => void
  t.summarize.mockImplementation((_, activeSignal) => {
    signal = activeSignal
    return new Promise(resolve => { release = resolve })
  })
  const pending = t.scheduler.tick()
  await vi.waitFor(() => expect(t.summarize).toHaveBeenCalledTimes(1))
  t.scheduler.dispose()
  const aborted = signal.aborted
  release({ summary: 'Oprava validace.', isWork: true })
  await pending
  expect(aborted).toBe(true)
  expect(t.repo.get('s1', DAY)?.summary).toBeNull()
})
