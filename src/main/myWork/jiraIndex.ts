import type { JiraBoardResult } from '@common/domain'
import type { MyWorkCacheRepo } from '../db/myWorkCacheRepo'

export interface JiraIndexDeps {
  /** Run one board fetch (the hidden Claude Code session); resolves with data or a typed failure. */
  fetch: () => Promise<JiraBoardResult>
  /** Persisted last-good board, so the section is useful immediately on boot. */
  store?: MyWorkCacheRepo
}

/** The in-memory board cache the IPC layer delegates to. */
export interface JiraIndex {
  /**
   * The cached board: memory first, then the persisted snapshot from the last app run (instant),
   * fetching only when neither exists. Concurrent cold-start calls share one fetch.
   */
  list(): Promise<JiraBoardResult>
  /**
   * Force a fresh fetch, ignoring the cache. Joins a fetch already in flight instead of spawning
   * a second hidden session.
   */
  refresh(): Promise<JiraBoardResult>
}

export function createJiraIndex(deps: JiraIndexDeps): JiraIndex {
  // Only a successful board is cached: a failed fetch is returned to its caller but never pinned,
  // so the next list() retries instead of replaying a stale error. `building` memoizes the
  // in-flight fetch so overlapping list/refresh calls share one hidden session.
  let cached: Extract<JiraBoardResult, { ok: true }> | null = null
  let building: Promise<JiraBoardResult> | null = null

  function build(): Promise<JiraBoardResult> {
    if (!building) {
      building = deps
        .fetch()
        .then((result) => {
          if (result.ok) {
            cached = result
            try {
              deps.store?.put({ issues: result.issues, fetchedAt: result.fetchedAt })
            } catch {
              // A persistence failure must never fail the fetch; the board still renders.
            }
          }
          return result
        })
        .finally(() => (building = null))
    }
    return building
  }

  return {
    async list() {
      if (cached) return cached
      try {
        const snapshot = deps.store?.get()
        if (snapshot) {
          cached = { ok: true, issues: snapshot.issues, fetchedAt: snapshot.fetchedAt }
          return cached
        }
      } catch {
        // An unreadable snapshot falls through to a live fetch.
      }
      return build()
    },

    async refresh() {
      return build()
    }
  }
}
