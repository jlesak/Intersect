import type { DatabaseSync } from 'node:sqlite'
import type {
  NewWorkItemRef,
  WorkItemRef,
  WorkItemRefAction,
  WorkItemRefEvent,
  WorkItemSource
} from '@common/domain'
import type { RepoDeps } from './deps'
import { tx } from './tx'

/**
 * A persisted primary ref without its liveness state: `state` is computed against the source
 * caches on every read (see core/workItems), never stored.
 */
export type StoredWorkItemRef = Omit<WorkItemRef, 'state'>

interface RefRow {
  tab_id: string
  source: string
  external_key: string
  project_id: string | null
  snapshot_key: string
  snapshot_title: string
  snapshot_type: string
  assigned_at: number
}

function toRef(row: RefRow): StoredWorkItemRef {
  return {
    tabId: row.tab_id,
    source: row.source as WorkItemSource,
    externalKey: row.external_key,
    projectId: row.project_id,
    snapshot: { key: row.snapshot_key, title: row.snapshot_title, type: row.snapshot_type },
    assignedAt: row.assigned_at
  }
}

interface EventRow {
  id: number
  tab_id: string
  action: string
  source: string | null
  external_key: string | null
  snapshot_key: string | null
  snapshot_title: string | null
  at: number
}

function toEvent(row: EventRow): WorkItemRefEvent {
  return {
    id: row.id,
    tabId: row.tab_id,
    action: row.action as WorkItemRefAction,
    source: row.source as WorkItemSource | null,
    externalKey: row.external_key,
    snapshotKey: row.snapshot_key,
    snapshotTitle: row.snapshot_title,
    at: row.at
  }
}

/**
 * Persistence of each session's one primary work item plus its append-only audit history.
 * The table's tab-id primary key enforces the at-most-one invariant; every mutation writes its
 * event in the same transaction so a ref can never exist without its history entry.
 */
export interface WorkItemRefRepo {
  get(tabId: string): StoredWorkItemRef | undefined
  /** The refs of every tab of the workspace (tabs without a ref simply have no row). */
  listForWorkspace(workspaceId: string): StoredWorkItemRef[]
  /** Assign or replace the tab's ref, recording an 'assign' (fresh) or 'change' (replace) event. */
  set(tabId: string, ref: NewWorkItemRef): StoredWorkItemRef
  /** Drop the tab's ref, recording a 'clear' event with the cleared identity. No-op without one. */
  clear(tabId: string): void
  /** The tab's full audit history, oldest first. Events outlive the tab itself. */
  history(tabId: string): WorkItemRefEvent[]
}

export function createWorkItemRefRepo(db: DatabaseSync, deps: RepoDeps): WorkItemRefRepo {
  const get = (tabId: string): StoredWorkItemRef | undefined => {
    const row = db.prepare('SELECT * FROM work_item_refs WHERE tab_id = ?').get(tabId) as
      | RefRow
      | undefined
    return row ? toRef(row) : undefined
  }

  const appendEvent = (
    tabId: string,
    action: WorkItemRefAction,
    ref: Pick<StoredWorkItemRef, 'source' | 'externalKey' | 'snapshot'>,
    at: number
  ): void => {
    db.prepare(
      `INSERT INTO work_item_ref_events (tab_id, action, source, external_key, snapshot_key, snapshot_title, at)
       VALUES (?,?,?,?,?,?,?)`
    ).run(tabId, action, ref.source, ref.externalKey, ref.snapshot.key, ref.snapshot.title, at)
  }

  return {
    get,

    listForWorkspace(workspaceId) {
      const rows = db
        .prepare(
          `SELECT r.* FROM work_item_refs r
           JOIN tabs t ON t.id = r.tab_id
           WHERE t.workspace_id = ?
           ORDER BY t.sort_order`
        )
        .all(workspaceId) as unknown as RefRow[]
      return rows.map(toRef)
    },

    set(tabId, ref) {
      return tx(db, () => {
        const existing = get(tabId)
        const now = deps.now()
        db.prepare(
          `INSERT INTO work_item_refs
             (tab_id, source, external_key, project_id, snapshot_key, snapshot_title, snapshot_type, assigned_at)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(tab_id) DO UPDATE SET
             source = excluded.source, external_key = excluded.external_key,
             project_id = excluded.project_id, snapshot_key = excluded.snapshot_key,
             snapshot_title = excluded.snapshot_title, snapshot_type = excluded.snapshot_type,
             assigned_at = excluded.assigned_at`
        ).run(
          tabId,
          ref.source,
          ref.externalKey,
          ref.projectId,
          ref.snapshot.key,
          ref.snapshot.title,
          ref.snapshot.type,
          now
        )
        appendEvent(tabId, existing ? 'change' : 'assign', ref, now)
        const stored = get(tabId)
        if (!stored) throw new Error(`Work item ref not written for tab: ${tabId}`)
        return stored
      })
    },

    clear(tabId) {
      tx(db, () => {
        const existing = get(tabId)
        if (!existing) return
        db.prepare('DELETE FROM work_item_refs WHERE tab_id = ?').run(tabId)
        appendEvent(tabId, 'clear', existing, deps.now())
      })
    },

    history(tabId) {
      const rows = db
        .prepare('SELECT * FROM work_item_ref_events WHERE tab_id = ? ORDER BY at, id')
        .all(tabId) as unknown as EventRow[]
      return rows.map(toEvent)
    }
  }
}
