import { basename } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Layout, Workspace } from '@common/domain'
import type { RepoDeps } from './deps'

interface WorkspaceRow {
  id: string
  name: string
  folder_path: string
  layout: string
  active_tab_id: string | null
  sort_order: number
  created_at: number
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    folderPath: row.folder_path,
    layout: row.layout as Layout,
    activeTabId: row.active_tab_id,
    sortOrder: row.sort_order
  }
}

export interface WorkspaceRepo {
  list(): Workspace[]
  getById(id: string): Workspace | undefined
  create(folderPath: string, name?: string): Workspace
  rename(id: string, name: string): Workspace
  remove(id: string): void
  setLayout(id: string, layout: Layout): Workspace
  setActiveTab(id: string, tabId: string | null): Workspace
}

export function createWorkspaceRepo(db: DatabaseSync, deps: RepoDeps): WorkspaceRepo {
  const getById = (id: string): Workspace | undefined => {
    const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined
    return row ? toWorkspace(row) : undefined
  }

  const mustGet = (id: string): Workspace => {
    const ws = getById(id)
    if (!ws) throw new Error(`Workspace not found: ${id}`)
    return ws
  }

  return {
    list() {
      const rows = db
        .prepare('SELECT * FROM workspaces ORDER BY sort_order')
        .all() as unknown as WorkspaceRow[]
      return rows.map(toWorkspace)
    },

    getById,

    create(folderPath, name) {
      const nextOrder = (
        db.prepare('SELECT COALESCE(MAX(sort_order) + 1, 0) AS n FROM workspaces').get() as {
          n: number
        }
      ).n
      const finalName = name ?? (basename(folderPath) || 'workspace')
      const id = deps.newId()
      db.prepare(
        'INSERT INTO workspaces (id,name,folder_path,layout,active_tab_id,sort_order,created_at) VALUES (?,?,?,?,?,?,?)'
      ).run(id, finalName, folderPath, 'single', null, nextOrder, deps.now())
      return mustGet(id)
    },

    rename(id, name) {
      mustGet(id)
      db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(name, id)
      return mustGet(id)
    },

    remove(id) {
      db.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
    },

    setLayout(id, layout) {
      mustGet(id)
      db.prepare('UPDATE workspaces SET layout = ? WHERE id = ?').run(layout, id)
      return mustGet(id)
    },

    setActiveTab(id, tabId) {
      mustGet(id)
      db.prepare('UPDATE workspaces SET active_tab_id = ? WHERE id = ?').run(tabId, id)
      return mustGet(id)
    }
  }
}
