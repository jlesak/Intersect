import type { DatabaseSync } from 'node:sqlite'
import type { SessionDayActivity } from '../timeTracking/dayActivity'

export interface TimeSessionDay extends SessionDayActivity {
  sessionId: string
  title: string
  cwd: string
  gitBranch: string | null
  autoDescription: string
}
const columns = `session_id AS sessionId, day, title, cwd, git_branch AS gitBranch,
  auto_description AS autoDescription, first_timestamp AS firstTimestamp,
  last_timestamp AS lastTimestamp, active_duration_ms AS activeDurationMs`

export function createTimeSessionDayRepo(db: DatabaseSync, now: () => number) {
  return {
    get(sessionId: string, day: string): TimeSessionDay | undefined {
      return db.prepare(`SELECT ${columns} FROM time_session_day WHERE session_id = ? AND day = ?`)
        .get(sessionId, day) as TimeSessionDay | undefined
    },
    listByDays(days: string[]): TimeSessionDay[] {
      return db.prepare(`SELECT ${columns} FROM time_session_day WHERE day IN (${days.map(() => '?').join(',')})`)
        .all(...days) as unknown as TimeSessionDay[]
    },
    upsert(row: TimeSessionDay): boolean {
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
