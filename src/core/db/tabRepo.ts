import type { DatabaseSync } from 'node:sqlite'
import {
  PRESET_META,
  type Preset,
  type SessionLifecycleEvent,
  type SuspendStatus,
  type Tab
} from '@common/domain'
import type { RepoDeps } from './deps'

interface TabRow {
  id: string
  workspace_id: string
  title: string
  preset: string
  pane_slot: number | null
  sort_order: number
  created_at: number
  resume_session_id: string | null
  session_status: string | null
  suspend_reason: string | null
  suspended_at: number | null
}

function toTab(row: TabRow): Tab {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    preset: row.preset as Preset,
    paneSlot: row.pane_slot,
    sortOrder: row.sort_order,
    resumeSessionId: row.resume_session_id ?? null,
    sessionStatus: (row.session_status as SuspendStatus | null) ?? null,
    suspendReason: row.suspend_reason ?? null,
    suspendedAt: row.suspended_at ?? null
  }
}

export interface TabRepo {
  listByWorkspace(workspaceId: string): Tab[]
  getById(id: string): Tab | undefined
  create(workspaceId: string, preset: Preset, title?: string, resumeSessionId?: string | null): Tab
  rename(id: string, title: string): Tab
  remove(id: string): void
  reorder(workspaceId: string, orderedIds: string[]): Tab[]
  setPaneSlot(id: string, slot: number | null): Tab
  setPaneSlots(assignments: { id: string; paneSlot: number | null }[]): void
  /**
   * Persist the Claude session UUID the tab's live session is currently writing, so a
   * respawn after restart resumes the same conversation. Tolerates an unknown tab id
   * (hook events can outlive a deleted tab) as a silent no-op.
   */
  setResumeSessionId(id: string, resumeSessionId: string | null): void
  /** Clear the given pane slot for every tab of the workspace except `exceptId`. */
  clearPaneSlot(workspaceId: string, slot: number, exceptId: string): void
  /**
   * Mark the tab `suspended` with a termination reason and append a `suspend` audit event. Two
   * statements, deliberately without its own transaction - the caller (the coordinated shutdown)
   * wraps the whole suspend pass in one `tx()`. Tolerates an unknown tab id as a no-op.
   */
  setSuspended(id: string, reason: string): void
  /** Move a suspended tab to the recoverable `resume-failed` state and audit it. */
  setResumeFailed(id: string, reason: string): void
  /** Clear a tab's suspend marker after a successful respawn and append a `resume` audit event. */
  clearSuspended(id: string): void
  /** Every tab currently marked `suspended`, across all workspaces (the boot reconcile input). */
  listSuspended(): Tab[]
  /** The tab's full suspend/resume audit history, oldest first. Survives tab deletion. */
  history(id: string): SessionLifecycleEvent[]
}

export function createTabRepo(db: DatabaseSync, deps: RepoDeps): TabRepo {
  const getById = (id: string): Tab | undefined => {
    const row = db.prepare('SELECT * FROM tabs WHERE id = ?').get(id) as TabRow | undefined
    return row ? toTab(row) : undefined
  }

  const mustGet = (id: string): Tab => {
    const tab = getById(id)
    if (!tab) throw new Error(`Tab not found: ${id}`)
    return tab
  }

  const listByWorkspace = (workspaceId: string): Tab[] => {
    const rows = db
      .prepare('SELECT * FROM tabs WHERE workspace_id = ? ORDER BY sort_order')
      .all(workspaceId) as unknown as TabRow[]
    return rows.map(toTab)
  }

  return {
    listByWorkspace,

    getById,

    create(workspaceId, preset, title, resumeSessionId) {
      const nextOrder = (
        db
          .prepare('SELECT COALESCE(MAX(sort_order) + 1, 0) AS n FROM tabs WHERE workspace_id = ?')
          .get(workspaceId) as { n: number }
      ).n
      const id = deps.newId()
      db.prepare(
        'INSERT INTO tabs (id,workspace_id,title,preset,pane_slot,sort_order,created_at,resume_session_id) VALUES (?,?,?,?,?,?,?,?)'
      ).run(
        id,
        workspaceId,
        title ?? PRESET_META[preset].defaultTitle,
        preset,
        null,
        nextOrder,
        deps.now(),
        resumeSessionId ?? null
      )
      return mustGet(id)
    },

    rename(id, title) {
      mustGet(id)
      db.prepare('UPDATE tabs SET title = ? WHERE id = ?').run(title, id)
      return mustGet(id)
    },

    remove(id) {
      db.prepare('DELETE FROM tabs WHERE id = ?').run(id)
    },

    // Does not open its own transaction; wrap in tx() when composing with other writes.
    reorder(workspaceId, orderedIds) {
      const update = db.prepare('UPDATE tabs SET sort_order = ? WHERE id = ? AND workspace_id = ?')
      orderedIds.forEach((id, index) => update.run(index, id, workspaceId))
      return listByWorkspace(workspaceId)
    },

    setPaneSlot(id, slot) {
      mustGet(id)
      db.prepare('UPDATE tabs SET pane_slot = ? WHERE id = ?').run(slot, id)
      return mustGet(id)
    },

    setResumeSessionId(id, resumeSessionId) {
      db.prepare('UPDATE tabs SET resume_session_id = ? WHERE id = ?').run(resumeSessionId, id)
    },

    setPaneSlots(assignments) {
      const update = db.prepare('UPDATE tabs SET pane_slot = ? WHERE id = ?')
      for (const a of assignments) update.run(a.paneSlot, a.id)
    },

    clearPaneSlot(workspaceId, slot, exceptId) {
      db.prepare(
        'UPDATE tabs SET pane_slot = NULL WHERE workspace_id = ? AND pane_slot = ? AND id != ?'
      ).run(workspaceId, slot, exceptId)
    },

    setSuspended(id, reason) {
      const at = deps.now()
      const changed = db
        .prepare(
          "UPDATE tabs SET session_status = 'suspended', suspend_reason = ?, suspended_at = ? WHERE id = ?"
        )
        .run(reason, at, id)
      if (changed.changes === 0) return
      appendEvent(id, 'suspend', reason, at)
    },

    setResumeFailed(id, reason) {
      const at = deps.now()
      const changed = db
        .prepare(
          "UPDATE tabs SET session_status = 'resume-failed', suspend_reason = ?, suspended_at = ? WHERE id = ?"
        )
        .run(reason, at, id)
      if (changed.changes === 0) return
      appendEvent(id, 'resume-failed', reason, at)
    },

    clearSuspended(id) {
      const changed = db
        .prepare(
          'UPDATE tabs SET session_status = NULL, suspend_reason = NULL, suspended_at = NULL WHERE id = ?'
        )
        .run(id)
      if (changed.changes === 0) return
      appendEvent(id, 'resume', null, deps.now())
    },

    listSuspended() {
      const rows = db
        .prepare("SELECT * FROM tabs WHERE session_status = 'suspended' ORDER BY suspended_at")
        .all() as unknown as TabRow[]
      return rows.map(toTab)
    },

    history(id) {
      const rows = db
        .prepare(
          'SELECT tab_id, action, reason, at FROM session_lifecycle_events WHERE tab_id = ? ORDER BY at, id'
        )
        .all(id) as { tab_id: string; action: string; reason: string | null; at: number }[]
      return rows.map((r) => ({
        tabId: r.tab_id,
        action: r.action as SessionLifecycleEvent['action'],
        reason: r.reason ?? null,
        at: r.at
      }))
    }
  }

  function appendEvent(
    tabId: string,
    action: SessionLifecycleEvent['action'],
    reason: string | null,
    at: number
  ): void {
    db.prepare(
      'INSERT INTO session_lifecycle_events (tab_id, action, reason, at) VALUES (?,?,?,?)'
    ).run(tabId, action, reason, at)
  }
}
