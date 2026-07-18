import type { DatabaseSync } from 'node:sqlite'

/** app_state key under which the selected workspace id is persisted. */
export const SELECTED_WORKSPACE_KEY = 'selected_workspace_id'

/** Flat key/value store for cross-cutting singletons (e.g. the selected workspace id). */
export interface AppStateRepo {
  get(key: string): string | null
  set(key: string, value: string | null): void
}

export function createAppStateRepo(db: DatabaseSync): AppStateRepo {
  return {
    get(key) {
      const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as
        | { value: string | null }
        | undefined
      return row ? row.value : null
    },

    set(key, value) {
      db.prepare(
        'INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).run(key, value)
    }
  }
}
