import type { DatabaseSync } from 'node:sqlite'
import type { ProjectOverride, ProjectOverrideKind } from '@common/domain'
import type { RepoDeps } from './deps'

interface OverrideRow {
  kind: string
  ext_key: string
  project_id: string | null
}

function toOverride(row: OverrideRow): ProjectOverride {
  return { kind: row.kind as ProjectOverrideKind, key: row.ext_key, projectId: row.project_id }
}

/**
 * Durable manual project assignments for external content (PRs, Jira issues). An override always
 * wins over binding-based inference; deleting its target project cascades the row away so the
 * item falls back to inference rather than pointing at a ghost.
 */
export interface ProjectOverrideRepo {
  list(): ProjectOverride[]
  set(kind: ProjectOverrideKind, key: string, projectId: string | null): void
  clear(kind: ProjectOverrideKind, key: string): void
}

export function createProjectOverrideRepo(
  db: DatabaseSync,
  deps: Pick<RepoDeps, 'now'>
): ProjectOverrideRepo {
  return {
    list() {
      const rows = db
        .prepare('SELECT kind, ext_key, project_id FROM project_overrides')
        .all() as unknown as OverrideRow[]
      return rows.map(toOverride)
    },

    set(kind, key, projectId) {
      db.prepare(
        `INSERT INTO project_overrides (kind, ext_key, project_id, created_at) VALUES (?,?,?,?)
         ON CONFLICT(kind, ext_key) DO UPDATE SET project_id = excluded.project_id`
      ).run(kind, key, projectId, deps.now())
    },

    clear(kind, key) {
      db.prepare('DELETE FROM project_overrides WHERE kind = ? AND ext_key = ?').run(kind, key)
    }
  }
}
