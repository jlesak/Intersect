import type { DatabaseSync } from 'node:sqlite'
import type { SessionDayActivity } from '../timeTracking/dayActivity'

export interface TimeSessionDay extends SessionDayActivity {
  sessionId: string
  title: string
  cwd: string
  gitBranch: string | null
  autoDescription: string
  summary: string | null
  summaryStatus: 'pending' | 'done' | 'failed'
  summarizedThrough: number | null
  isWork: boolean | null
  workConfirmed: boolean
}
const columns = `session_id AS sessionId, day, title, cwd, git_branch AS gitBranch,
  auto_description AS autoDescription, first_timestamp AS firstTimestamp,
  last_timestamp AS lastTimestamp, active_duration_ms AS activeDurationMs,
  summary, summary_status AS summaryStatus, summarized_through AS summarizedThrough,
  is_work AS isWork, work_confirmed AS workConfirmed`

type SnapshotInput = Omit<TimeSessionDay, 'summary' | 'summaryStatus' | 'summarizedThrough' |
  'isWork' | 'workConfirmed'>
type RawDay = Omit<TimeSessionDay, 'isWork' | 'workConfirmed'> & {
  isWork: number | null; workConfirmed: number
}
function fromRow(row: RawDay): TimeSessionDay {
  return { ...row, isWork: row.isWork === null ? null : row.isWork === 1,
    workConfirmed: row.workConfirmed === 1 }
}

export function createTimeSessionDayRepo(db: DatabaseSync, now: () => number) {
  return {
    get(sessionId: string, day: string): TimeSessionDay | undefined {
      const row = db.prepare(`SELECT ${columns} FROM time_session_day WHERE session_id = ? AND day = ?`)
        .get(sessionId, day) as RawDay | undefined
      return row && fromRow(row)
    },
    listByDays(days: string[]): TimeSessionDay[] {
      if (days.length === 0) return []
      return db.prepare(`SELECT ${columns} FROM time_session_day WHERE day IN (${days.map(() => '?').join(',')})`)
        .all(...days).map(row => fromRow(row as RawDay))
    },
    listAll(): TimeSessionDay[] {
      return db.prepare(`SELECT ${columns} FROM time_session_day`)
        .all().map(row => fromRow(row as RawDay))
    },
    upsert(row: SnapshotInput): boolean {
      const result = db.prepare(`INSERT INTO time_session_day
        (session_id, day, title, cwd, git_branch, auto_description, first_timestamp, last_timestamp, active_duration_ms, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, day) DO UPDATE SET title=excluded.title, cwd=excluded.cwd,
          git_branch=excluded.git_branch, auto_description=excluded.auto_description,
          first_timestamp=excluded.first_timestamp, last_timestamp=excluded.last_timestamp,
          active_duration_ms=excluded.active_duration_ms, updated_at=excluded.updated_at
        WHERE title IS NOT excluded.title OR cwd IS NOT excluded.cwd OR git_branch IS NOT excluded.git_branch
          OR auto_description IS NOT excluded.auto_description OR first_timestamp IS NOT excluded.first_timestamp
          OR last_timestamp IS NOT excluded.last_timestamp OR active_duration_ms IS NOT excluded.active_duration_ms`)
        .run(row.sessionId, row.day, row.title, row.cwd, row.gitBranch, row.autoDescription,
          row.firstTimestamp, row.lastTimestamp, row.activeDurationMs, now())
      return result.changes > 0
    },
    saveSummary(sessionId: string, day: string, through: number,
      result: { summary: string; isWork: boolean }): boolean {
      const changed = db.prepare(`UPDATE time_session_day SET summary = ?, summary_status = 'done',
        summarized_through = ?, is_work = CASE WHEN work_confirmed = 1 THEN 1 ELSE ? END,
        updated_at = ? WHERE session_id = ? AND day = ? AND last_timestamp = ?`)
        .run(result.summary, through, result.isWork ? 1 : 0, now(), sessionId, day, through)
      return changed.changes > 0
    },
    failSummary(sessionId: string, day: string): void {
      db.prepare(`UPDATE time_session_day SET summary_status = 'failed', updated_at = ?
        WHERE session_id = ? AND day = ?`).run(now(), sessionId, day)
    },
    confirmWork(sessionId: string, day: string): boolean {
      const changed = db.prepare(`UPDATE time_session_day SET is_work = 1, work_confirmed = 1,
        updated_at = ? WHERE session_id = ? AND day = ? AND work_confirmed = 0`)
        .run(now(), sessionId, day)
      return changed.changes > 0
    },
    /** Copy first, then remove. A conflict deliberately retains the unresolved legacy row. */
    adoptLegacy(sessionId: string, day: string): boolean {
      const result = db.prepare(`INSERT INTO time_entry_override
        (session_id, day, description, issue_key, duration_ms, deleted, updated_at)
        SELECT session_id, ?, description, issue_key, duration_ms, deleted, updated_at
        FROM time_entry_override_legacy WHERE session_id = ?
        ON CONFLICT(session_id, day) DO NOTHING`).run(day, sessionId)
      if (result.changes === 0) return false
      db.prepare('DELETE FROM time_entry_override_legacy WHERE session_id = ?').run(sessionId)
      return true
    }
  }
}
export type TimeSessionDayRepo = ReturnType<typeof createTimeSessionDayRepo>
