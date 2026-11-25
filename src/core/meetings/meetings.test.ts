import { describe, expect, test, vi } from 'vitest'
import { makeTestDb, makeTestDeps } from '../db/testkit'
import { createAppStateRepo } from '../db/appStateRepo'
import { createManualTimeEntryRepo } from '../db/timeTrackingRepo'
import { createMeetingProposals, DEFAULT_MEETING_ROUTING } from '../timeTracking/meetingProposals'
import { createMeetings, normalizeCalendarReport } from './meetings'

const DAY = '2026-11-25'
const raw = (patch: Record<string, unknown> = {}) => ({
  id: 'event-1', subject: 'Synthetic meeting',
  start: '2026-11-25T09:00:00+01:00', end: '2026-11-25T09:30:00+01:00',
  onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' },
  ...patch
})

function setup(fetch = vi.fn<(day: string) => Promise<unknown>>(async () => [raw()])) {
  const db = makeTestDb()
  const state = createAppStateRepo(db)
  const deps = makeTestDeps()
  const proposals = createMeetingProposals(db, createManualTimeEntryRepo(db, deps), deps.now)
  const service = createMeetings({ state, proposals, routing: () => DEFAULT_MEETING_ROUTING,
    fetch, now: () => Date.parse('2026-11-25T10:00:00+01:00'),
    atomically: (fn) => { db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error } }
  })
  return { db, state, proposals, service, fetch }
}

describe('calendar report validation', () => {
  test('projects timestamp to local day and extracts only Teams Join URLs', () => {
    const meetings = normalizeCalendarReport([raw(), raw({ id: 'event-2',
      onlineMeeting: { joinUrl: 'https://evil.example/meeting' } })], DAY)
    expect(meetings).toHaveLength(2)
    expect(meetings[0]).toMatchObject({ day: DAY, startAt: Date.parse('2026-11-25T09:00:00+01:00'),
      joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' })
    expect(meetings[1].joinUrl).toBeNull()
  })

  test('rejects malformed, zero-duration, and wrong-day events while retaining all-day for display', () => {
    expect(normalizeCalendarReport([raw({ end: '2026-11-25T09:00:00+01:00' }),
      raw({ id: 'other', start: '2026-11-26T09:00:00+01:00', end: '2026-11-26T10:00:00+01:00' }),
      raw({ id: 'all', isAllDay: true })], DAY)).toMatchObject([{ externalId: 'all', allDay: true }])
  })
})

describe('shared meetings cache', () => {
  test('first open refreshes once and creates proposals from the same report', async () => {
    const { service, fetch, proposals } = setup()
    const [first, second] = await Promise.all([service.open(DAY), service.open(DAY)])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(first.meetings).toHaveLength(1)
    expect(second.syncedAt).toBe(first.syncedAt)
    expect(proposals.list(DAY)).toHaveLength(1)
    await service.open(DAY)
    expect(fetch).toHaveBeenCalledTimes(1)
    await service.refresh(DAY)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test('a failed refresh preserves dated same-day cache and never shows yesterday as today', async () => {
    const { service, fetch } = setup()
    await service.open(DAY)
    fetch.mockRejectedValueOnce(new Error('permission required'))
    const stale = await service.refresh(DAY)
    expect(stale.meetings).toHaveLength(1)
    expect(stale.error).toMatch(/permission required/)
    expect(service.get('2026-11-26')).toMatchObject({ meetings: [], syncedAt: null })
  })

  test('an older day finishing last cannot replace the newer day cache', async () => {
    let finishOld!: (events: unknown[]) => void
    const fetch = vi.fn((day: string) => day === '2026-11-25'
      ? new Promise<unknown[]>((resolve) => { finishOld = resolve })
      : Promise.resolve([raw({ id: 'new-day', start: '2026-11-26T09:00:00+01:00',
        end: '2026-11-26T09:30:00+01:00' })]))
    const { service } = setup(fetch)
    const old = service.open('2026-11-25')
    await service.open('2026-11-26')
    finishOld([raw()])
    await old
    expect(service.get('2026-11-26').meetings).toMatchObject([{ externalId: 'new-day' }])
    expect(service.get('2026-11-25').meetings).toMatchObject([{ externalId: 'event-1' }])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test('changing routing reassigns cached pending proposals without another calendar fetch', async () => {
    const { service, fetch, proposals } = setup()
    await service.open(DAY)
    service.rerouteCached({ rules: [{ pattern: 'meeting', target: {
      kind: 'issue', issueKey: 'APP-17' } }], defaultTarget: { kind: 'unassigned' } })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(proposals.list(DAY)).toMatchObject([{ issueKey: 'APP-17' }])
    proposals.accept('microsoft365', 'event-1')
    service.rerouteCached(DEFAULT_MEETING_ROUTING)
    expect(proposals.list(DAY)).toEqual([])
  })

  test('a moved event stays on the newest day after old fetch completion and routing edit', async () => {
    let finishOld!: (events: unknown[]) => void
    const fetch = vi.fn((day: string) => day === DAY
      ? new Promise<unknown[]>((resolve) => { finishOld = resolve })
      : Promise.resolve([raw({ start: '2026-11-26T09:00:00+01:00',
        end: '2026-11-26T09:30:00+01:00' })]))
    const { service, proposals } = setup(fetch)
    const old = service.open(DAY)
    await service.open('2026-11-26')
    finishOld([raw()])
    await old
    expect(proposals.list(DAY)).toEqual([])
    expect(proposals.list('2026-11-26')).toMatchObject([{ externalId: 'event-1' }])
    service.rerouteCached({ rules: [{ pattern: 'meeting', target: {
      kind: 'issue', issueKey: 'APP-17' } }], defaultTarget: { kind: 'unassigned' } })
    expect(proposals.list(DAY)).toEqual([])
    expect(proposals.list('2026-11-26')).toMatchObject([{
      externalId: 'event-1', issueKey: 'APP-17'
    }])
  })

  test('a moved then cancelled event cannot reappear from an old day cache or late response', async () => {
    let finishOld!: (events: unknown[]) => void
    let oldDelayed = false
    let newCancelled = false
    const fetch = vi.fn((day: string) => {
      if (day === DAY && oldDelayed) return new Promise<unknown[]>((resolve) => { finishOld = resolve })
      if (day === DAY) return Promise.resolve([raw()])
      return Promise.resolve(newCancelled ? [] : [raw({
        start: '2026-11-26T09:00:00+01:00', end: '2026-11-26T09:30:00+01:00'
      })])
    })
    const { service, proposals } = setup(fetch)
    await service.open(DAY)
    await service.open('2026-11-26')
    newCancelled = true
    await service.refresh('2026-11-26')
    expect(proposals.list(DAY)).toEqual([])
    expect(proposals.list('2026-11-26')).toEqual([])
    oldDelayed = true
    const lateOld = service.refresh(DAY)
    // A later old-day request is a genuinely new observation; this would be allowed. Instead,
    // the late response case below starts before the new-day observation in a fresh service.
    finishOld([raw()])
    await lateOld
    expect(proposals.list(DAY)).toHaveLength(1)

    const raced = setup(vi.fn((day: string) => day === DAY
      ? new Promise<unknown[]>((resolve) => { finishOld = resolve })
      : Promise.resolve(newCancelled ? [] : [raw({
        start: '2026-11-26T09:00:00+01:00', end: '2026-11-26T09:30:00+01:00'
      })])))
    newCancelled = false
    const pendingOld = raced.service.open(DAY)
    await raced.service.open('2026-11-26')
    newCancelled = true
    await raced.service.refresh('2026-11-26')
    finishOld([raw()])
    await pendingOld
    expect(raced.proposals.list(DAY)).toEqual([])
    expect(raced.proposals.list('2026-11-26')).toEqual([])
  })
})
