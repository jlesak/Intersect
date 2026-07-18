import type { DatabaseSync } from 'node:sqlite'
import type { RepoDeps } from './deps'

/** One raw hook event as stored: which session sent what, and when it arrived. */
export interface HookEventRow {
  sessionId: string
  eventName: string
  payload: unknown
  receivedAt: number
}

/** How long raw hook events are kept before retention pruning deletes them. */
export const HOOK_EVENT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000

export interface HookEventRepo {
  /**
   * Append one accepted event verbatim. Runs BEFORE any domain handling so even events the
   * guards later reject (nested sessions, cwd mismatches) stay available as diagnostics.
   */
  append(sessionId: string, eventName: string, payload: unknown): void
  /** A session's stored events in arrival order, for diagnostics and tests. */
  listBySession(sessionId: string): HookEventRow[]
  /** Delete every event older than the cutoff timestamp; returns how many rows went. */
  pruneOlderThan(cutoff: number): number
}

export function createHookEventRepo(db: DatabaseSync, deps: RepoDeps): HookEventRepo {
  return {
    append(sessionId, eventName, payload) {
      db.prepare(
        'INSERT INTO hook_events (session_id, event_name, payload_json, received_at) VALUES (?,?,?,?)'
      ).run(sessionId, eventName, JSON.stringify(payload ?? null), deps.now())
    },

    listBySession(sessionId) {
      const rows = db
        .prepare(
          'SELECT session_id, event_name, payload_json, received_at FROM hook_events WHERE session_id = ? ORDER BY received_at, id'
        )
        .all(sessionId) as unknown as {
        session_id: string
        event_name: string
        payload_json: string
        received_at: number
      }[]
      return rows.map((row) => ({
        sessionId: row.session_id,
        eventName: row.event_name,
        payload: JSON.parse(row.payload_json),
        receivedAt: row.received_at
      }))
    },

    pruneOlderThan(cutoff) {
      const result = db.prepare('DELETE FROM hook_events WHERE received_at < ?').run(cutoff)
      return Number(result.changes)
    }
  }
}
