import type { DatabaseSync } from 'node:sqlite'
import { PRESET_META, type Preset, type Tab } from '@common/domain'
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
}

function toTab(row: TabRow): Tab {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    preset: row.preset as Preset,
    paneSlot: row.pane_slot,
    sortOrder: row.sort_order,
    resumeSessionId: row.resume_session_id ?? null
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
    }
  }
}
