import type { DatabaseSync } from 'node:sqlite'
import {
  PRESET_META,
  type Layout,
  type Preset,
  type SessionLifecycleEvent,
  type SuspendStatus,
  type Tab
} from '@common/domain'
import { regroupTabs } from '@common/layout'
import type { RepoDeps } from './deps'
import { tx } from './tx'

interface TabRow {
  id: string
  workspace_id: string
  title: string
  preset: string
  pane_slot: number | null
  sort_order: number
  last_active_at: number | null
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
    // Migration 27 could not make the column NOT NULL, so the invariant "every tab is in a
    // group" is upheld here: a NULL slot reads as group 0.
    paneSlot: row.pane_slot ?? 0,
    sortOrder: row.sort_order,
    lastActiveAt: row.last_active_at ?? null,
    resumeSessionId: row.resume_session_id ?? null,
    sessionStatus: (row.session_status as SuspendStatus | null) ?? null,
    suspendReason: row.suspend_reason ?? null,
    suspendedAt: row.suspended_at ?? null
  }
}

export interface TabRepo {
  /** The workspace's tabs in screen order: group by group, and inside a group in bar order. */
  listByWorkspace(workspaceId: string): Tab[]
  getById(id: string): Tab | undefined
  /** Append a tab at the end of `paneSlot`'s group (group 0 when the caller states none). */
  create(
    workspaceId: string,
    preset: Preset,
    title?: string,
    resumeSessionId?: string | null,
    paneSlot?: number
  ): Tab
  rename(id: string, title: string): Tab
  /** Delete the tab and close the gap its departure leaves in its group's `sortOrder`. */
  remove(id: string): void
  /**
   * Move the tab into `slot` at position `index`, renumbering both the group it left and the one
   * it joined so each stays a dense 0..n-1 sequence. A move inside the same group is a plain
   * reorder, and `index` clamps into the target group's range. Returns the workspace's full tab
   * list in (paneSlot, sortOrder) order.
   */
  moveToGroup(id: string, slot: number, index: number): Tab[]
  /**
   * Persist the group placements a layout change implies (see regroupTabs) and return the
   * workspace's full tab list in the new order.
   */
  regroup(workspaceId: string, from: Layout, to: Layout): Tab[]
  /** Record that the tab was just activated, which is what makes it its group's visible tab. */
  touchActive(id: string, at: number): Tab
  /**
   * Persist the Claude session UUID the tab's live session is currently writing, so a
   * respawn after restart resumes the same conversation. Tolerates an unknown tab id
   * (hook events can outlive a deleted tab) as a silent no-op.
   */
  setResumeSessionId(id: string, resumeSessionId: string | null): void
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
      .prepare(
        'SELECT * FROM tabs WHERE workspace_id = ? ORDER BY COALESCE(pane_slot, 0), sort_order'
      )
      .all(workspaceId) as unknown as TabRow[]
    return rows.map(toTab)
  }

  /** One group's tabs in bar order. Coalescing matches the read side of the slot invariant. */
  const listGroup = (workspaceId: string, slot: number): Tab[] => {
    const rows = db
      .prepare(
        'SELECT * FROM tabs WHERE workspace_id = ? AND COALESCE(pane_slot, 0) = ? ORDER BY sort_order'
      )
      .all(workspaceId, slot) as unknown as TabRow[]
    return rows.map(toTab)
  }

  return {
    listByWorkspace,

    getById,

    create(workspaceId, preset, title, resumeSessionId, paneSlot = 0) {
      const nextOrder = (
        db
          .prepare(
            'SELECT COALESCE(MAX(sort_order) + 1, 0) AS n FROM tabs WHERE workspace_id = ? AND COALESCE(pane_slot, 0) = ?'
          )
          .get(workspaceId, paneSlot) as { n: number }
      ).n
      const id = deps.newId()
      db.prepare(
        'INSERT INTO tabs (id,workspace_id,title,preset,pane_slot,sort_order,created_at,resume_session_id) VALUES (?,?,?,?,?,?,?,?)'
      ).run(
        id,
        workspaceId,
        title ?? PRESET_META[preset].defaultTitle,
        preset,
        paneSlot,
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
      const tab = getById(id)
      if (!tab) return
      tx(db, () => {
        db.prepare('DELETE FROM tabs WHERE id = ?').run(id)
        const renumber = db.prepare('UPDATE tabs SET sort_order = ? WHERE id = ?')
        listGroup(tab.workspaceId, tab.paneSlot).forEach((t, i) => renumber.run(i, t.id))
      })
    },

    moveToGroup(id, slot, index) {
      return tx(db, () => {
        const tab = mustGet(id)
        const place = db.prepare('UPDATE tabs SET pane_slot = ?, sort_order = ? WHERE id = ?')

        // Removing the tab from the target list first is what makes a same-group move a plain
        // reorder: the index the caller gave is a position among the other tabs either way.
        const target = listGroup(tab.workspaceId, slot).filter((t) => t.id !== id)
        target.splice(Math.min(Math.max(index, 0), target.length), 0, tab)
        target.forEach((t, i) => place.run(slot, i, t.id))

        if (tab.paneSlot !== slot) {
          // The tab has already left, so the source group now reads as exactly the tabs that
          // stay, and renumbering them closes the hole its departure left.
          listGroup(tab.workspaceId, tab.paneSlot).forEach((t, i) => place.run(tab.paneSlot, i, t.id))
        }

        return listByWorkspace(tab.workspaceId)
      })
    },

    regroup(workspaceId, from, to) {
      return tx(db, () => {
        const place = db.prepare('UPDATE tabs SET pane_slot = ?, sort_order = ? WHERE id = ?')
        for (const a of regroupTabs(listByWorkspace(workspaceId), from, to)) {
          place.run(a.paneSlot, a.sortOrder, a.id)
        }
        return listByWorkspace(workspaceId)
      })
    },

    touchActive(id, at) {
      mustGet(id)
      db.prepare('UPDATE tabs SET last_active_at = ? WHERE id = ?').run(at, id)
      return mustGet(id)
    },

    setResumeSessionId(id, resumeSessionId) {
      db.prepare('UPDATE tabs SET resume_session_id = ? WHERE id = ?').run(resumeSessionId, id)
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
