import type { DatabaseSync } from 'node:sqlite'
import type { Preset, Tab } from '@common/domain'
import type { RepoDeps } from './deps'

interface TabRow {
  id: string
  workspace_id: string
  title: string
  preset: string
  pane_slot: number | null
  sort_order: number
  created_at: number
}

function toTab(row: TabRow): Tab {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    preset: row.preset as Preset,
    paneSlot: row.pane_slot,
    sortOrder: row.sort_order
  }
}

const DEFAULT_TITLE: Record<Preset, string> = { shell: 'Shell', claude: 'Claude' }

export interface TabRepo {
  listByWorkspace(workspaceId: string): Tab[]
  getById(id: string): Tab | undefined
  create(workspaceId: string, preset: Preset, title?: string): Tab
  rename(id: string, title: string): Tab
  remove(id: string): void
  reorder(workspaceId: string, orderedIds: string[]): Tab[]
  setPaneSlot(id: string, slot: number | null): Tab
  setPaneSlots(assignments: { id: string; paneSlot: number | null }[]): void
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

    create(workspaceId, preset, title) {
      const nextOrder = (
        db
          .prepare('SELECT COALESCE(MAX(sort_order) + 1, 0) AS n FROM tabs WHERE workspace_id = ?')
          .get(workspaceId) as { n: number }
      ).n
      const id = deps.newId()
      db.prepare(
        'INSERT INTO tabs (id,workspace_id,title,preset,pane_slot,sort_order,created_at) VALUES (?,?,?,?,?,?,?)'
      ).run(id, workspaceId, title ?? DEFAULT_TITLE[preset], preset, null, nextOrder, deps.now())
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

    // Transaction-agnostic: callers (handlers) wrap multi-step operations in tx() as needed.
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

    setPaneSlots(assignments) {
      const update = db.prepare('UPDATE tabs SET pane_slot = ? WHERE id = ?')
      for (const a of assignments) update.run(a.paneSlot, a.id)
    }
  }
}
