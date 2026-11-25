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

function setup(fetch = vi.fn(async () => [raw()])) {
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
})
