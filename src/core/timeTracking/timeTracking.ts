import type {
  NewManualTimeEntry,
  RunningTimer,
  TimeEntry,
  TimeEntryRef,
  TimeEntryUpdate
} from '@common/domain'
import { dayKeyOf, weekdayKeys } from '@common/week'
import type {
  ManualTimeEntryRepo,
  RunningTimerRepo,
  TimeOverrideRepo
} from '../db/timeTrackingRepo'
import { basename } from 'node:path'
import type { TimeTrackingSettings } from '@common/domain'
import type { TimeSessionDay, TimeSessionDayRepo } from '../db/timeSessionDayRepo'
import type { SessionSnapshots } from './sessionSnapshots'
import { insideAppData } from './exclusions'
import { issueKeyFromBranch } from './issueKey'

export interface TimeTrackingDeps {
  snapshots: TimeSessionDayRepo
  scanner: SessionSnapshots
  settings(): TimeTrackingSettings
  userDataDir: string
  manual: ManualTimeEntryRepo
  overrides: TimeOverrideRepo
  timer: RunningTimerRepo
  /** Injected so timer tests can advance the clock instead of sleeping. */
  now: () => number
  /**
   * Run several writes as one all-or-nothing unit. Stopping the timer both clears the running row
   * and logs the span, and a half-applied stop would destroy time the user actually worked.
   */
  atomically: <T>(fn: () => T) => T
}

/**
 * The weekly worklog board's read/write model. A week is the five weekdays starting at a Monday
 * day key; auto entries come from persisted daily snapshots with user edits applied on top.
 * Weekend snapshots remain stored but have no card or share in the weekday totals.
 */
export interface TimeTrackingService {
  getWeek(weekStart: string): Promise<TimeEntry[]>
  /** Force a session re-scan from disk, then return the fresh week. */
  refreshWeek(weekStart: string): Promise<TimeEntry[]>
  addManual(input: NewManualTimeEntry): TimeEntry
  updateEntry(ref: TimeEntryRef, update: TimeEntryUpdate): Promise<TimeEntry>
  deleteEntry(ref: TimeEntryRef): Promise<void>
  /** The timer currently running, or null. */
  getRunningTimer(): RunningTimer | null
  /** Begin timing now. Refuses when one is already running. */
  startTimer(description: string, issueKey: string | null): RunningTimer
  /** Re-attribute a running timer without disturbing what it has measured. */
  updateTimer(description: string, issueKey: string | null): RunningTimer
  /**
   * Stop timing and log the elapsed span as a manual entry on the day it was stopped. Returns
   * null when nothing was running, or when the span was too short to be real work.
   */
  stopTimer(): TimeEntry | null
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/
const validDay = (day: string): boolean => typeof day === 'string' && DAY_KEY.test(day) &&
  Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day

/**
 * The renderer form validates too, but persisted garbage would surface as wrong totals or as
 * rows on no visible day, so the write path enforces its own invariants.
 */
function assertDuration(durationMs: number): void {
  if (!Number.isInteger(durationMs) || durationMs <= 0) {
    throw new Error('The logged time must be a positive duration')
  }
}

/**
 * Below this, a start followed immediately by a stop is a misclick rather than work. Logging it
 * would put a zero-length row on the board for the user to hunt down and delete.
 */
const MIN_TIMED_MS = 1_000

/** A row is never logged unlabelled: the issue key stands in, and failing that a neutral label. */
function timedDescription(description: string, issueKey: string | null): string {
  const trimmed = description.trim()
  if (trimmed) return trimmed
  return issueKey ?? 'Timed work'
}

export function createTimeTracking(deps: TimeTrackingDeps): TimeTrackingService {
  const key = (sessionId: string, day: string) => `${sessionId}:${day}`
  const toEntry = (row: TimeSessionDay): TimeEntry => {
    const override = deps.overrides.get(row.sessionId, row.day)
    return { id: key(row.sessionId, row.day), source: 'auto', day: row.day,
      sessionId: row.sessionId, sessionTitle: row.title, cwd: row.cwd,
      folderName: row.cwd ? basename(row.cwd) : '', gitBranch: row.gitBranch,
      firstTimestamp: row.firstTimestamp, lastTimestamp: row.lastTimestamp,
      description: override?.description ?? row.autoDescription,
      issueKey: override ? override.issueKey : issueKeyFromBranch(row.gitBranch),
      durationMs: override ? override.durationMs : row.activeDurationMs }
  }

  function validateRef(ref: TimeEntryRef): void {
    if (!ref || typeof ref !== 'object') throw new Error('Invalid entry reference')
    if (ref.source === 'manual' && typeof ref.id === 'string' && ref.id) return
    if (ref.source === 'auto' && typeof ref.sessionId === 'string' && ref.sessionId &&
      validDay(ref.day)) return
    throw new Error('Invalid entry reference')
  }

  async function findSnapshot(ref: Extract<TimeEntryRef, { source: 'auto' }>) {
    await deps.scanner.ready()
    const row = deps.snapshots.get(ref.sessionId, ref.day)
    if (!row) throw new Error(`Unknown session day: ${ref.sessionId}:${ref.day}`)
    return row
  }

  async function getWeek(weekStart: string): Promise<TimeEntry[]> {
    await deps.scanner.ready()
    const days = weekdayKeys(weekStart)
    const prefixes = deps.settings().excludedPathPrefixes
    const rows = deps.snapshots.listByDays(days).filter(row =>
      row.activeDurationMs >= 300_000 && !deps.overrides.get(row.sessionId, row.day)?.deleted &&
      !insideAppData(row.cwd, deps.userDataDir) && !prefixes.some(prefix => row.cwd.startsWith(prefix)))
    rows.sort((a, b) => a.day.localeCompare(b.day) || a.lastTimestamp - b.lastTimestamp ||
      a.sessionId.localeCompare(b.sessionId))
    return [...rows.map(toEntry), ...deps.manual.listByDays(days)]
      .sort((a, b) => a.day.localeCompare(b.day))
  }

  return {
    getWeek,

    async refreshWeek(weekStart) {
      await deps.scanner.scan()
      return getWeek(weekStart)
    },

    addManual(input) {
      if (!validDay(input.day)) throw new Error(`Not a day: ${input.day}`)
      if (!input.description.trim()) throw new Error('A description is required')
      assertDuration(input.durationMs)
      return deps.manual.create(input)
    },

    async updateEntry(ref, update) {
      validateRef(ref)
      assertDuration(update.durationMs)
      if (!update.description.trim()) throw new Error('A description is required')
      if (ref.source === 'manual') return deps.manual.update(ref.id, update)
      const row = await findSnapshot(ref)
      deps.overrides.upsert(ref.sessionId, ref.day, { ...update, deleted: false })
      return toEntry(row)
    },

    async deleteEntry(ref) {
      validateRef(ref)
      if (ref.source === 'manual') {
        deps.manual.remove(ref.id)
        return
      }
      const row = await findSnapshot(ref)
      const existing = deps.overrides.get(ref.sessionId, ref.day)
      deps.overrides.upsert(ref.sessionId, ref.day, existing ? { ...existing, deleted: true } : {
        description: null, issueKey: issueKeyFromBranch(row.gitBranch),
        durationMs: row.activeDurationMs, deleted: true
      })
    },

    getRunningTimer() {
      return deps.timer.get()
    },

    startTimer(description, issueKey) {
      return deps.timer.start(deps.now(), description, issueKey)
    },

    updateTimer(description, issueKey) {
      return deps.timer.update(description, issueKey)
    },

    stopTimer() {
      const running = deps.timer.get()
      if (!running) return null
      // One reading of the clock for both the span and the day, so they can never disagree.
      const stoppedAt = deps.now()
      const durationMs = stoppedAt - running.startedAt
      // Clearing the running row and logging what it measured is one indivisible act: if the entry
      // cannot be written the timer must keep running, never be silently thrown away.
      return deps.atomically(() => {
        deps.timer.clear()
        if (durationMs < MIN_TIMED_MS) return null
        // Attributed to the day it was stopped, so a span crossing midnight lands on one day rather
        // than being split across two - manual entries and timers retain their single-day behavior.
        return deps.manual.create({
          day: dayKeyOf(stoppedAt),
          description: timedDescription(running.description, running.issueKey),
          issueKey: running.issueKey,
          durationMs
        })
      })
    }
  }
}
