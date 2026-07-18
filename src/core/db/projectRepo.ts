import type { DatabaseSync } from 'node:sqlite'
import type { Project, ProjectPatch } from '@common/domain'
import type { RepoDeps } from './deps'
import { tx } from './tx'

interface ProjectRow {
  id: string
  name: string
  sort_order: number
  archived: number
  jira_jql: string | null
  jira_board_url: string | null
  toggl_project_id: number | null
  created_at: number
}

export interface ProjectRepoDeps extends RepoDeps {
  /**
   * Maps any path to its canonical absolute form - the identity every binding is stored and
   * compared under, so symlink aliases of the same folder cannot bind twice.
   */
  canonicalize(path: string): string
}

export interface ProjectRepo {
  /** Every project (archived included), in manual order. */
  list(): Project[]
  getById(id: string): Project | undefined
  /** Create a project bound to one repository folder. Name must be non-empty after trimming. */
  create(name: string, folderPath: string): Project
  /** Edit name and external-tool bindings in place; an omitted field is left unchanged. */
  update(id: string, patch: ProjectPatch): Project
  /** Archive hides a project from active use; it is app-state only and fully reversible. */
  setArchived(id: string, archived: boolean): Project
  /** Replace the complete project ordering in one transaction. */
  reorder(orderedIds: string[]): Project[]
  /**
   * App-state delete: bindings go with the project, its workspaces detach to the virtual
   * "Other" bucket. Never touches filesystem folders or remote resources.
   */
  remove(id: string): void
  /** Bind one more repository folder. The canonical path must not be bound to any project yet. */
  addRepoPath(id: string, folderPath: string): Project
  /** Unbind a repository folder. A project always keeps at least one binding. */
  removeRepoPath(id: string, folderPath: string): Project
}

export function createProjectRepo(db: DatabaseSync, deps: ProjectRepoDeps): ProjectRepo {
  const repoPathsOf = (projectId: string): string[] =>
    (
      db
        .prepare('SELECT path FROM project_repo WHERE project_id = ? ORDER BY sort_order, path')
        .all(projectId) as unknown as { path: string }[]
    ).map((r) => r.path)

  const adoReposOf = (projectId: string): string[] =>
    (
      db
        .prepare(
          'SELECT repository_name FROM project_ado_repo WHERE project_id = ? ORDER BY repository_name'
        )
        .all(projectId) as unknown as { repository_name: string }[]
    ).map((r) => r.repository_name)

  const toProject = (row: ProjectRow): Project => ({
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    archived: row.archived === 1,
    repoPaths: repoPathsOf(row.id),
    jiraJql: row.jira_jql,
    jiraBoardUrl: row.jira_board_url,
    adoRepositories: adoReposOf(row.id),
    togglProjectId: row.toggl_project_id
  })

  const getById = (id: string): Project | undefined => {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
    return row ? toProject(row) : undefined
  }

  const mustGet = (id: string): Project => {
    const project = getById(id)
    if (!project) throw new Error(`Project not found: ${id}`)
    return project
  }

  const mustTrim = (name: string): string => {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Project name must not be empty')
    return trimmed
  }

  /**
   * The canonical form of a new binding, rejected when any project already owns an equivalent
   * one. Stored bindings are re-canonicalized for the comparison because rows migrated from
   * workspaces predate canonicalization and may still hold a symlink alias.
   */
  const newBinding = (folderPath: string): string => {
    const canonical = deps.canonicalize(folderPath)
    const existing = db
      .prepare(
        `SELECT r.path AS path, p.name AS name
         FROM project_repo r JOIN projects p ON p.id = r.project_id`
      )
      .all() as unknown as { path: string; name: string }[]
    const owner = existing.find((b) => deps.canonicalize(b.path) === canonical)
    if (owner) throw new Error(`Folder is already bound to project "${owner.name}": ${canonical}`)
    return canonical
  }

  const list = (): Project[] => {
    const rows = db
      .prepare('SELECT * FROM projects ORDER BY sort_order, created_at, id')
      .all() as unknown as ProjectRow[]
    return rows.map(toProject)
  }

  return {
    list,

    getById,

    create(name, folderPath) {
      const trimmed = mustTrim(name)
      const canonical = newBinding(folderPath)
      const nextOrder = (
        db.prepare('SELECT COALESCE(MAX(sort_order) + 1, 0) AS n FROM projects').get() as {
          n: number
        }
      ).n
      const id = deps.newId()
      return tx(db, () => {
        const now = deps.now()
        db.prepare(
          'INSERT INTO projects (id, name, sort_order, archived, created_at) VALUES (?,?,?,0,?)'
        ).run(id, trimmed, nextOrder, now)
        db.prepare(
          'INSERT INTO project_repo (project_id, path, sort_order, created_at) VALUES (?,?,0,?)'
        ).run(id, canonical, now)
        return mustGet(id)
      })
    },

    update(id, patch) {
      mustGet(id)
      return tx(db, () => {
        const sets: string[] = []
        const params: (string | number | null)[] = []

        if (patch.name !== undefined) {
          sets.push('name = ?')
          params.push(mustTrim(patch.name))
        }
        if (patch.jiraJql !== undefined) {
          sets.push('jira_jql = ?')
          params.push(patch.jiraJql?.trim() || null)
        }
        if (patch.jiraBoardUrl !== undefined) {
          sets.push('jira_board_url = ?')
          params.push(patch.jiraBoardUrl?.trim() || null)
        }
        if (patch.togglProjectId !== undefined) {
          if (patch.togglProjectId !== null && !Number.isInteger(patch.togglProjectId))
            throw new Error(`Invalid Toggl project id: ${patch.togglProjectId}`)
          sets.push('toggl_project_id = ?')
          params.push(patch.togglProjectId)
        }
        if (sets.length > 0) {
          params.push(id)
          db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...params)
        }

        if (patch.adoRepositories !== undefined) {
          const names = patch.adoRepositories.map((n) => n.trim()).filter((n) => n.length > 0)
          if (new Set(names).size !== names.length)
            throw new Error('ADO repository names must be unique')
          db.prepare('DELETE FROM project_ado_repo WHERE project_id = ?').run(id)
          const insert = db.prepare(
            'INSERT INTO project_ado_repo (project_id, repository_name) VALUES (?,?)'
          )
          for (const name of names) insert.run(id, name)
        }

        return mustGet(id)
      })
    },

    setArchived(id, archived) {
      mustGet(id)
      db.prepare('UPDATE projects SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id)
      return mustGet(id)
    },

    reorder(orderedIds) {
      const currentIds = list().map((p) => p.id)
      const uniqueIds = new Set(orderedIds)
      const currentSet = new Set(currentIds)
      const exactSet =
        orderedIds.length === currentIds.length &&
        uniqueIds.size === orderedIds.length &&
        orderedIds.every((id) => currentSet.has(id))
      if (!exactSet) throw new Error('Reorder must contain every project exactly once')

      return tx(db, () => {
        const update = db.prepare('UPDATE projects SET sort_order = ? WHERE id = ?')
        orderedIds.forEach((id, index) => {
          const result = update.run(index, id)
          if (result.changes !== 1) throw new Error(`Project not found while reordering: ${id}`)
        })
        return list()
      })
    },

    remove(id) {
      db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    },

    addRepoPath(id, folderPath) {
      mustGet(id)
      const canonical = newBinding(folderPath)
      const nextOrder = (
        db
          .prepare(
            'SELECT COALESCE(MAX(sort_order) + 1, 0) AS n FROM project_repo WHERE project_id = ?'
          )
          .get(id) as { n: number }
      ).n
      db.prepare(
        'INSERT INTO project_repo (project_id, path, sort_order, created_at) VALUES (?,?,?,?)'
      ).run(id, canonical, nextOrder, deps.now())
      return mustGet(id)
    },

    removeRepoPath(id, folderPath) {
      mustGet(id)
      const canonical = deps.canonicalize(folderPath)
      const bindings = repoPathsOf(id)
      // Match on canonical equivalence so a binding migrated as a symlink alias is still removable.
      const stored = bindings.find((b) => deps.canonicalize(b) === canonical)
      if (stored === undefined)
        throw new Error(`Folder is not bound to this project: ${canonical}`)
      if (bindings.length === 1)
        throw new Error('A project must keep at least one repository folder')
      db.prepare('DELETE FROM project_repo WHERE project_id = ? AND path = ?').run(id, stored)
      return mustGet(id)
    }
  }
}
