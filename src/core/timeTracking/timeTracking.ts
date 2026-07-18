import type {
  NewManualTimeEntry,
  TimeEntry,
  TimeEntrySource,
  TimeEntryUpdate
} from '@common/domain'
import { dayKeyOf, weekdayKeys } from '@common/week'
import type { ManualTimeEntryRepo, TimeOverrideRepo } from '../db/timeTrackingRepo'
import type { SessionIndex } from '../sessions/sessionIndex'
import { issueKeyFromBranch } from './issueKey'

export interface TimeTrackingDeps {
  /** The app-wide session index instance - the same one the Sessions slice reads. */
  sessions: SessionIndex
  manual: ManualTimeEntryRepo
  overrides: TimeOverrideRepo
}

/**
 * The weekly worklog board's read/write model. A week is the five weekdays starting at a Monday
 * day key; auto entries are Claude Code sessions bucketed by the local day of their last activity,
 * with any persisted user edits (overrides) applied on top and tombstoned sessions dropped.
 * Weekend sessions are excluded entirely - no card, no share in any total.
 */
export interface TimeTrackingService {
  getWeek(weekStart: string): Promise<TimeEntry[]>
  /** Force a session re-scan from disk, then return the fresh week. */
  refreshWeek(weekStart: string): Promise<TimeEntry[]>
  addManual(input: NewManualTimeEntry): TimeEntry
  updateEntry(source: TimeEntrySource, id: string, update: TimeEntryUpdate): Promise<TimeEntry>
  deleteEntry(source: TimeEntrySource, id: string): Promise<void>
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/

/**
 * The renderer form validates too, but persisted garbage would surface as wrong totals or as
 * rows on no visible day, so the write path enforces its own invariants.
 */
function assertDuration(durationMs: number): void {
  if (!Number.isInteger(durationMs) || durationMs <= 0) {
    throw new Error('The logged time must be a positive duration')
  }
}

export function createTimeTracking(deps: TimeTrackingDeps): TimeTrackingService {
  async function findSession(id: string) {
    const session = (await deps.sessions.list()).find((s) => s.id === id)
    if (!session) throw new Error(`Unknown session: ${id}`)
    return session
  }

  async function getWeek(weekStart: string): Promise<TimeEntry[]> {
    const days = weekdayKeys(weekStart)
    const daySet = new Set(days)
    const overridesById = new Map(deps.overrides.listAll().map((o) => [o.sessionId, o]))

    const auto: { entry: TimeEntry; ts: number }[] = []
    for (const session of await deps.sessions.list()) {
      const day = dayKeyOf(session.lastTimestamp)
      // Only the shown week's Monday-Friday qualifies; a weekend day is never in the set.
      if (!daySet.has(day)) continue
      const override = overridesById.get(session.id)
      if (override?.deleted) continue
      auto.push({
        ts: session.lastTimestamp,
        entry: {
          id: session.id,
          source: 'auto',
          day,
          description: session.title,
          issueKey: override ? override.issueKey : issueKeyFromBranch(session.gitBranch),
          durationMs: override ? override.durationMs : session.durationMs
        }
      })
    }
    // Within a day: sessions in chronological order, then manual entries in creation order
    // (matching how the user appends them at the end of a column). The final day-only sort is
    // stable, so both pre-sorted groups keep their internal order.
    auto.sort((a, b) => a.entry.day.localeCompare(b.entry.day) || a.ts - b.ts)
    const manual = deps.manual.listByDays(days)
    return [...auto.map((a) => a.entry), ...manual].sort((a, b) => a.day.localeCompare(b.day))
  }

  return {
    getWeek,

    async refreshWeek(weekStart) {
      const sessions = await deps.sessions.refresh()
      // The fresh scan is the authority on which sessions still exist; overrides and tombstones
      // of deleted transcripts have nothing left to override.
      deps.overrides.pruneAbsent(sessions.map((s) => s.id))
      return getWeek(weekStart)
    },

    addManual(input) {
      if (!DAY_KEY.test(input.day)) throw new Error(`Not a day: ${input.day}`)
      if (!input.description.trim()) throw new Error('A description is required')
      assertDuration(input.durationMs)
      return deps.manual.create(input)
    },

    async updateEntry(source, id, update) {
      assertDuration(update.durationMs)
      if (source === 'manual') return deps.manual.update(id, update)
      const session = await findSession(id)
      deps.overrides.upsert(id, {
        issueKey: update.issueKey,
        durationMs: update.durationMs,
        deleted: false
      })
      return {
        id,
        source: 'auto',
        day: dayKeyOf(session.lastTimestamp),
        description: session.title,
        issueKey: update.issueKey,
        durationMs: update.durationMs
      }
    },

    async deleteEntry(source, id) {
      if (source === 'manual') {
        deps.manual.remove(id)
        return
      }
      // Tombstone the auto card, snapshotting whatever the card currently shows so the row
      // satisfies its own NOT NULL fields without inventing values.
      const existing = deps.overrides.get(id)
      if (existing) {
        deps.overrides.upsert(id, { ...existing, deleted: true })
        return
      }
      const session = await findSession(id)
      deps.overrides.upsert(id, {
        issueKey: issueKeyFromBranch(session.gitBranch),
        durationMs: session.durationMs,
        deleted: true
      })
    }
  }
}
