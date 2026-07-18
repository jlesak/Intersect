import type { DatabaseSync } from 'node:sqlite'
import type { NewManualTimeEntry, TimeEntry, TimeEntryUpdate } from '@common/domain'
import type { RepoDeps } from './deps'

interface ManualRow {
  id: string
  day: string
  description: string
  issue_key: string | null
  duration_ms: number
  created_at: number
}

function toManualEntry(row: ManualRow): TimeEntry {
  return {
    id: row.id,
    source: 'manual',
    day: row.day,
    description: row.description,
    issueKey: row.issue_key,
    durationMs: row.duration_ms
  }
}

export interface ManualTimeEntryRepo {
  create(input: NewManualTimeEntry): TimeEntry
  /** Manual entries for the given day keys, ordered by day then creation time. */
  listByDays(days: string[]): TimeEntry[]
  /** Overwrite the two editable fields (time and issue key). */
  update(id: string, update: TimeEntryUpdate): TimeEntry
  /** Hard delete - a manual entry has no upstream source to resurrect from. */
  remove(id: string): void
}

export function createManualTimeEntryRepo(db: DatabaseSync, deps: RepoDeps): ManualTimeEntryRepo {
  const mustGet = (id: string): TimeEntry => {
    const row = db.prepare('SELECT * FROM time_entry_manual WHERE id = ?').get(id) as
      | ManualRow
      | undefined
    if (!row) throw new Error(`Time entry not found: ${id}`)
    return toManualEntry(row)
  }

  return {
    create(input) {
      const id = deps.newId()
      db.prepare(
        `INSERT INTO time_entry_manual (id, day, description, issue_key, duration_ms, created_at)
         VALUES (?,?,?,?,?,?)`
      ).run(id, input.day, input.description, input.issueKey, input.durationMs, deps.now())
      return mustGet(id)
    },

    listByDays(days) {
      if (days.length === 0) return []
      const placeholders = days.map(() => '?').join(',')
      const rows = db
        .prepare(
          `SELECT * FROM time_entry_manual WHERE day IN (${placeholders})
           ORDER BY day, created_at`
        )
        .all(...days) as unknown as ManualRow[]
      return rows.map(toManualEntry)
    },

    update(id, update) {
      mustGet(id)
      db.prepare('UPDATE time_entry_manual SET issue_key = ?, duration_ms = ? WHERE id = ?').run(
        update.issueKey,
        update.durationMs,
        id
      )
      return mustGet(id)
    },

    remove(id) {
      db.prepare('DELETE FROM time_entry_manual WHERE id = ?').run(id)
    }
  }
}

/**
 * The user's persisted edit of one auto entry, keyed by the Claude Code session id. Both editable
 * fields are snapshots taken when the edit happened (so a cleared issue key is simply null, no
 * sentinel needed); `deleted` tombstones the card so a re-scan cannot bring it back.
 */
export interface TimeOverride {
  sessionId: string
  issueKey: string | null
  durationMs: number
  deleted: boolean
}

interface OverrideRow {
  session_id: string
  issue_key: string | null
  duration_ms: number
  deleted: number
}

function toOverride(row: OverrideRow): TimeOverride {
  return {
    sessionId: row.session_id,
    issueKey: row.issue_key,
    durationMs: row.duration_ms,
    deleted: row.deleted === 1
  }
}

export interface TimeOverrideRepo {
  get(sessionId: string): TimeOverride | undefined
  listAll(): TimeOverride[]
  /** Insert or fully replace the override for a session. */
  upsert(sessionId: string, value: Omit<TimeOverride, 'sessionId'>): TimeOverride
  /** Drop overrides for sessions that no longer exist (their transcript was deleted from disk). */
  pruneAbsent(presentSessionIds: string[]): void
}

export function createTimeOverrideRepo(db: DatabaseSync, deps: RepoDeps): TimeOverrideRepo {
  const get = (sessionId: string): TimeOverride | undefined => {
    const row = db.prepare('SELECT * FROM time_entry_override WHERE session_id = ?').get(sessionId) as
      | OverrideRow
      | undefined
    return row ? toOverride(row) : undefined
  }

  return {
    get,

    listAll() {
      const rows = db
        .prepare('SELECT * FROM time_entry_override')
        .all() as unknown as OverrideRow[]
      return rows.map(toOverride)
    },

    upsert(sessionId, value) {
      db.prepare(
        `INSERT INTO time_entry_override (session_id, issue_key, duration_ms, deleted, updated_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET
           issue_key = excluded.issue_key,
           duration_ms = excluded.duration_ms,
           deleted = excluded.deleted,
           updated_at = excluded.updated_at`
      ).run(sessionId, value.issueKey, value.durationMs, value.deleted ? 1 : 0, deps.now())
      return get(sessionId)!
    },

    pruneAbsent(presentSessionIds) {
      const present = new Set(presentSessionIds)
      const stale = (
        db.prepare('SELECT session_id FROM time_entry_override').all() as unknown as {
          session_id: string
        }[]
      ).filter((row) => !present.has(row.session_id))
      const remove = db.prepare('DELETE FROM time_entry_override WHERE session_id = ?')
      for (const row of stale) remove.run(row.session_id)
    }
  }
}
