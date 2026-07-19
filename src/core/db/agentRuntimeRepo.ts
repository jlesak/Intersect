import type { DatabaseSync } from 'node:sqlite'
import type { AgentRuntimeEvidence, NewAgentRuntimeEvidence } from '@common/domain'
import { tx } from './tx'

interface EvidenceRow {
  session_id: string
  local_date: string
  minutes: number
  source: string
  confidence: string
  project_id: string | null
  work_item_source: string | null
  work_item_key: string | null
  external_id: string
  computed_at: number
}

function toEvidence(row: EvidenceRow): AgentRuntimeEvidence {
  return {
    sessionId: row.session_id,
    localDate: row.local_date,
    minutes: row.minutes,
    source: row.source as AgentRuntimeEvidence['source'],
    confidence: row.confidence as AgentRuntimeEvidence['confidence'],
    projectId: row.project_id,
    workItemSource: row.work_item_source,
    workItemKey: row.work_item_key,
    externalId: row.external_id,
    computedAt: row.computed_at
  }
}

/** The stable idempotent external id for one evidence row: `${source}:${sessionId}:${localDate}`. */
export function agentRuntimeExternalId(row: NewAgentRuntimeEvidence): string {
  return `${row.source}:${row.sessionId}:${row.localDate}`
}

/**
 * Persistence of measured agent runtime evidence, kept strictly apart from human worklogs and
 * from Toggl. The composite (session, local day) primary key is the idempotency guard: an upsert
 * updates the same row rather than duplicating it, so any recompute converges. This repo never
 * writes to the time_entry_* tables and has no notion of uploading anything.
 */
export interface AgentRuntimeRepo {
  /** Insert or update one row, keyed by (session, local day). Returns the persisted row. */
  upsert(row: NewAgentRuntimeEvidence): AgentRuntimeEvidence
  /** Every evidence row falling on any of the given local days, deterministically ordered. */
  listByDays(days: string[]): AgentRuntimeEvidence[]
  /** Every evidence row for the project across the given local days. */
  listForProject(projectId: string, days: string[]): AgentRuntimeEvidence[]
  /** Every evidence row for one session, oldest local day first. */
  listForSession(sessionId: string): AgentRuntimeEvidence[]
  /**
   * Reconcile the whole computed set for one session in a single transaction: delete the rows
   * for days no longer produced, then upsert the supplied set. A fresh recompute therefore
   * converges - a shrunk timeline drops stale days, a grown one accrues, and re-running twice
   * leaves identical rows.
   */
  replaceForSession(sessionId: string, rows: NewAgentRuntimeEvidence[]): void
}

const SORT = 'ORDER BY local_date, session_id'

export function createAgentRuntimeRepo(db: DatabaseSync): AgentRuntimeRepo {
  const upsertRow = (row: NewAgentRuntimeEvidence): void => {
    db.prepare(
      `INSERT INTO agent_runtime_evidence
         (session_id, local_date, minutes, source, confidence, project_id,
          work_item_source, work_item_key, external_id, computed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(session_id, local_date) DO UPDATE SET
         minutes = excluded.minutes, source = excluded.source, confidence = excluded.confidence,
         project_id = excluded.project_id, work_item_source = excluded.work_item_source,
         work_item_key = excluded.work_item_key, external_id = excluded.external_id,
         computed_at = excluded.computed_at`
    ).run(
      row.sessionId,
      row.localDate,
      row.minutes,
      row.source,
      row.confidence,
      row.projectId,
      row.workItemSource,
      row.workItemKey,
      agentRuntimeExternalId(row),
      row.computedAt
    )
  }

  const getRow = (sessionId: string, localDate: string): AgentRuntimeEvidence => {
    const row = db
      .prepare('SELECT * FROM agent_runtime_evidence WHERE session_id = ? AND local_date = ?')
      .get(sessionId, localDate) as EvidenceRow | undefined
    if (!row) throw new Error(`Agent runtime evidence not written: ${sessionId} ${localDate}`)
    return toEvidence(row)
  }

  const placeholders = (days: string[]): string => days.map(() => '?').join(',')

  return {
    upsert(row) {
      upsertRow(row)
      return getRow(row.sessionId, row.localDate)
    },

    listByDays(days) {
      if (days.length === 0) return []
      const rows = db
        .prepare(
          `SELECT * FROM agent_runtime_evidence WHERE local_date IN (${placeholders(days)}) ${SORT}`
        )
        .all(...days) as unknown as EvidenceRow[]
      return rows.map(toEvidence)
    },

    listForProject(projectId, days) {
      if (days.length === 0) return []
      const rows = db
        .prepare(
          `SELECT * FROM agent_runtime_evidence
           WHERE project_id = ? AND local_date IN (${placeholders(days)}) ${SORT}`
        )
        .all(projectId, ...days) as unknown as EvidenceRow[]
      return rows.map(toEvidence)
    },

    listForSession(sessionId) {
      const rows = db
        .prepare(`SELECT * FROM agent_runtime_evidence WHERE session_id = ? ${SORT}`)
        .all(sessionId) as unknown as EvidenceRow[]
      return rows.map(toEvidence)
    },

    replaceForSession(sessionId, rows) {
      tx(db, () => {
        const keep = new Set(rows.map((r) => r.localDate))
        const existing = db
          .prepare('SELECT local_date FROM agent_runtime_evidence WHERE session_id = ?')
          .all(sessionId) as { local_date: string }[]
        const remove = db.prepare(
          'DELETE FROM agent_runtime_evidence WHERE session_id = ? AND local_date = ?'
        )
        for (const { local_date } of existing) {
          if (!keep.has(local_date)) remove.run(sessionId, local_date)
        }
        for (const row of rows) upsertRow(row)
      })
    }
  }
}
