import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { runMigrations } from '../db/migrations'
import { makeTestDeps } from '../db/testkit'
import { createManualTimeEntryRepo, createRunningTimerRepo, createTimeOverrideRepo } from '../db/timeTrackingRepo'
import { createTimeEntryGroupRepo } from '../db/timeEntryGroupRepo'
import { createTimeSessionDayRepo } from '../db/timeSessionDayRepo'
import { tx } from '../db/tx'
import { createMeetingProposals, DEFAULT_MEETING_ROUTING } from './meetingProposals'
import { createTimeTracking } from './timeTracking'
import { createTimeCliDispatcher } from './timeCliDispatch'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })))

test('accepted project meeting keeps its link across restart, grouping and CLI edits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'intersect-meeting-integration-'))
  dirs.push(dir)
  const path = join(dir, 'app.sqlite')
  const day = '2026-11-25'
  const db = new DatabaseSync(path)
  runMigrations(db)
  const deps = makeTestDeps()
  const manual = createManualTimeEntryRepo(db, deps)
  const proposals = createMeetingProposals(db, manual, deps.now)
  proposals.reconcile(day, [{ source: 'microsoft365', externalId: 'synthetic-1', day,
    subject: 'Synthetic planning', startAt: Date.parse('2026-11-25T09:00:00+01:00'),
    endAt: Date.parse('2026-11-25T09:30:00+01:00'), joinUrl: null,
    cancelled: false, declined: false, allDay: false }], {
    rules: [{ pattern: 'planning', target: { kind: 'project', projectId: 'project-a' } }],
    defaultTarget: DEFAULT_MEETING_ROUTING.defaultTarget
  })
  const accepted = proposals.accept('microsoft365', 'synthetic-1')!
  expect(accepted.projectId).toBe('project-a')
  db.close()

  const reopened = new DatabaseSync(path)
  runMigrations(reopened)
  const freshManual = createManualTimeEntryRepo(reopened, deps)
  expect(freshManual.get(accepted.id).projectId).toBe('project-a')
  const other = freshManual.create({ day, description: 'Other work', issueKey: null,
    durationMs: 600_000 })
  const groups = createTimeEntryGroupRepo(reopened, deps)
  const service = createTimeTracking({
    snapshots: createTimeSessionDayRepo(reopened, deps.now),
    scanner: { ready: async () => {}, scan: async () => {}, start() {}, dispose() {} },
    isResumable: async () => false, settings: () => ({ excludedPathPrefixes: [] }),
    userDataDir: '/intersect', manual: freshManual, groups,
    overrides: createTimeOverrideRepo(reopened, deps),
    timer: createRunningTimerRepo(reopened, deps), now: deps.now, atomically: fn => tx(reopened, fn)
  })
  const cli = createTimeCliDispatcher({ service, db: reopened, groups,
    now: () => Date.UTC(2026, 10, 25), zone: () => 'Europe/Prague',
    scannerReady: async () => {}, changed: () => {}, isSynced: () => false })
  const meetingRef = `manual:${accepted.id}`
  const group = await cli({ command: 'group', actor: 'user', refs: [meetingRef, `manual:${other.id}`] })
  expect(group.code).toBe(0)
  expect(freshManual.get(accepted.id).projectId).toBe('project-a')
  expect((await cli({ command: 'edit', actor: 'user', ref: meetingRef,
    issue: 'PLAT-7' })).code).toBe(0)
  expect(freshManual.get(accepted.id)).toMatchObject({ issueKey: 'PLAT-7', projectId: 'project-a' })
  expect((await cli({ command: 'edit', actor: 'user', ref: meetingRef,
    noIssue: true })).code).toBe(0)
  expect((await cli({ command: 'ungroup', actor: 'user',
    ref: (group.value as { ref: string }).ref })).code).toBe(0)
  expect(freshManual.get(accepted.id)).toMatchObject({ issueKey: null, projectId: 'project-a' })
  reopened.close()
})
