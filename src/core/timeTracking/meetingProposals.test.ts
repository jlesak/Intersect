import { describe, expect, test } from 'vitest'
import { makeTestDb, makeTestDeps } from '../db/testkit'
import { createManualTimeEntryRepo } from '../db/timeTrackingRepo'
import { createMeetingProposals, routeMeeting } from './meetingProposals'
import type { CalendarMeeting, MeetingRoutingSettings } from '@common/domain'

const rules: MeetingRoutingSettings = {
  rules: [
    { pattern: 'review', target: { kind: 'issue', issueKey: 'APP-12' } },
    { pattern: 'plan', target: { kind: 'project', projectId: 'project-1' } }
  ],
  defaultTarget: { kind: 'unassigned' }
}
const meeting = (patch: Partial<CalendarMeeting> = {}): CalendarMeeting => ({
  source: 'microsoft365', externalId: 'event-1', day: '2026-11-25',
  subject: 'Design review', startAt: 1795593600000, endAt: 1795595400000,
  joinUrl: null, cancelled: false, declined: false, allDay: false, ...patch
})

function setup() {
  const db = makeTestDb()
  const deps = makeTestDeps()
  const manual = createManualTimeEntryRepo(db, deps)
  const proposals = createMeetingProposals(db, manual, deps.now)
  return { db, manual, proposals }
}

describe('meeting proposal ledger', () => {
  test('routes first matching literal rule without regard to case and falls back to default', () => {
    expect(routeMeeting('REVIEW planning', rules)).toEqual({ issueKey: 'APP-12', projectId: null })
    expect(routeMeeting('Planning', rules)).toEqual({ issueKey: null, projectId: 'project-1' })
    expect(routeMeeting('standup', rules)).toEqual({ issueKey: null, projectId: null })
  })

  test('proposes exact duration and excludes cancelled, declined, all-day and invalid events', () => {
    const { proposals } = setup()
    proposals.reconcile('2026-11-25', [meeting(), meeting({ externalId: 'x', cancelled: true }),
      meeting({ externalId: 'y', declined: true }), meeting({ externalId: 'z', allDay: true }),
      meeting({ externalId: 'zero', endAt: 1795593600000 }),
      meeting({ externalId: 'wrong-day', day: '2026-11-26' })], rules)
    expect(proposals.list('2026-11-25')).toMatchObject([
      { externalId: 'event-1', durationMs: 1800000, description: 'Design review', issueKey: 'APP-12' }
    ])
  })

  test('accepted and declined events never return after a refetch or accepted entry deletion', () => {
    const { proposals, manual } = setup()
    proposals.reconcile('2026-11-25', [meeting(), meeting({ externalId: 'event-2', subject: 'Planning' })], rules)
    const accepted = proposals.accept('microsoft365', 'event-1')
    proposals.decline('microsoft365', 'event-2')
    manual.remove(accepted!.id)
    proposals.reconcile('2026-11-25', [meeting({ subject: 'Renamed review' }),
      meeting({ externalId: 'event-2', subject: 'Planning' })], rules)
    expect(proposals.list('2026-11-25')).toEqual([])
    expect(proposals.accept('microsoft365', 'event-1')).toBeNull()
  })

  test('a pending event rescheduled across days moves, while a decided event stays decided', () => {
    const { proposals } = setup()
    proposals.reconcile('2026-11-25', [meeting(),
      meeting({ externalId: 'decided', subject: 'Planning' })], rules)
    proposals.decline('microsoft365', 'decided')
    const nextDay = (patch: Partial<CalendarMeeting> = {}): CalendarMeeting => meeting({
      day: '2026-11-26', startAt: Date.parse('2026-11-26T09:00:00+01:00'),
      endAt: Date.parse('2026-11-26T10:00:00+01:00'),
      subject: 'Planning moved', ...patch
    })
    proposals.reconcile('2026-11-26', [nextDay(), nextDay({ externalId: 'decided' })], rules)
    expect(proposals.list('2026-11-25')).toEqual([])
    expect(proposals.list('2026-11-26')).toMatchObject([{
      externalId: 'event-1', description: 'Planning moved', durationMs: 3_600_000,
      projectId: 'project-1'
    }])
  })

  test('accept all writes each entry and decision atomically; a second call writes nothing', () => {
    const { proposals, manual } = setup()
    proposals.reconcile('2026-11-25', [meeting(), meeting({ externalId: 'event-2', subject: 'Planning' })], rules)
    const accepted = proposals.acceptAll('2026-11-25')
    expect(accepted).toHaveLength(2)
    expect(accepted[0].issueKey).toBe('APP-12')
    expect(accepted[1].source).toBe('manual')
    expect(accepted[1].projectId).toBe('project-1')
    expect(proposals.acceptAll('2026-11-25')).toEqual([])
    expect(manual.listByDays(['2026-11-25'])).toHaveLength(2)
  })

  test('a failed manual insert rolls back the proposal decision', () => {
    const { db, proposals } = setup()
    proposals.reconcile('2026-11-25', [meeting()], rules)
    db.exec(`CREATE TRIGGER reject_meeting BEFORE INSERT ON time_entry_manual BEGIN SELECT RAISE(ABORT, 'rejected'); END`)
    expect(() => proposals.accept('microsoft365', 'event-1')).toThrow('rejected')
    expect(proposals.list('2026-11-25')).toHaveLength(1)
  })
})
