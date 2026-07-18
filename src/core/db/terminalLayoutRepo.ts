import type { DatabaseSync } from 'node:sqlite'
import {
  isResizableLayout,
  normalizeShares,
  type LayoutShares,
  type ResizableLayout,
  type TerminalLayoutSharesMap
} from '@common/terminalLayoutShares'
import type { RepoDeps } from './deps'

export interface TerminalLayoutRepo {
  /**
   * Every persisted layout's shares for the project key ('other' = the virtual bucket for
   * unassigned workspaces). Values are normalized on read, so a corrupt or incompatible row
   * comes back as safe equal shares instead of failing.
   */
  getAll(projectKey: string): TerminalLayoutSharesMap
  /** Persist one layout's shares for the project key, overwriting any previous value. */
  set(projectKey: string, layout: ResizableLayout, shares: LayoutShares): void
  /** Drop every layout row of a removed project so its ratios never resurface. */
  removeForProject(projectKey: string): void
}

export function createTerminalLayoutRepo(db: DatabaseSync, deps: RepoDeps): TerminalLayoutRepo {
  return {
    getAll(projectKey) {
      const rows = db
        .prepare('SELECT layout, shares FROM project_terminal_layouts WHERE project_key = ?')
        .all(projectKey) as unknown as { layout: string; shares: string }[]
      const result: TerminalLayoutSharesMap = {}
      for (const row of rows) {
        if (!isResizableLayout(row.layout)) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(row.shares)
        } catch {
          parsed = undefined
        }
        result[row.layout] = normalizeShares(row.layout, parsed) as never
      }
      return result
    },

    set(projectKey, layout, shares) {
      if (!projectKey) throw new Error('Project key must not be empty')
      if (!isResizableLayout(layout)) throw new Error(`Layout has no pane shares: ${layout}`)
      const normalized = normalizeShares(layout, shares)
      db.prepare(
        `INSERT INTO project_terminal_layouts (project_key, layout, shares, updated_at)
         VALUES (?,?,?,?)
         ON CONFLICT(project_key, layout) DO UPDATE SET shares = excluded.shares,
           updated_at = excluded.updated_at`
      ).run(projectKey, layout, JSON.stringify(normalized), deps.now())
    },

    removeForProject(projectKey) {
      db.prepare('DELETE FROM project_terminal_layouts WHERE project_key = ?').run(projectKey)
    }
  }
}
