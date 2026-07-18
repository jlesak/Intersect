import {
  GLOBAL_JIRA_SOURCE,
  type JiraBoardSnapshot,
  type JiraSyncError,
  type Project
} from '@common/domain'
import type { JiraCacheRepo } from '../db/jiraCacheRepo'
import { parseJiraBoardUrl, type JiraFetchResult, type ParsedBoardUrl } from './jiraClient'
import { JIRA_GLOBAL_JQL, toSnapshots } from './jiraMapping'

/**
 * What one source resolves to: the global query and a project's JQL run through the search
 * path, a project's board URL through the Agile board path. This is the whole query language -
 * the engine deliberately has no way to express a Jira write.
 */
export type JiraQuery = { kind: 'jql'; jql: string } | { kind: 'board'; board: ParsedBoardUrl }

export interface JiraSyncEngineDeps {
  /**
   * Run one read-only fetch for the source. Injected so the composition root decides what
   * executes a query (the direct client, the E2E stub, or the diagnostic hidden path) - the
   * engine itself has no fetch, spawn, or network access of any kind.
   */
  runQuery(sourceKey: string, query: JiraQuery): Promise<JiraFetchResult>
  repo: JiraCacheRepo
  /** Project lookup for `project:<id>` sources (their JQL / board URL configuration). */
  getProject(id: string): Project | undefined
  now(): number
  /** A source's background refresh finished (success or failure); the renderer refetches. */
  onChanged(sourceKey: string): void
  staleMs?: number
}

/**
 * The stale-while-revalidate core of the Jira slice. Reads always answer from the SQLite read
 * model immediately; a stale cache additionally starts exactly one shared background refresh per
 * source (concurrent readers join it, never stack). Every failure lands as sync-state data next
 * to the retained last-good issues - nothing here throws for a failed fetch, and nothing here
 * ever opens the login window.
 */
export interface JiraSyncEngine {
  /** The cached envelope, immediately; starts one shared background refresh when stale. */
  getBoard(sourceKey: string): Promise<JiraBoardSnapshot>
  /** Force one refresh (joining an in-flight one) and return the resulting envelope. */
  refresh(sourceKey: string): Promise<JiraBoardSnapshot>
}

const DEFAULT_STALE_MS = 5 * 60_000

/** An envelope for a source with no cache rows at all (nothing fetched, nothing failed yet). */
function emptyBoard(sourceKey: string): JiraBoardSnapshot {
  return { sourceKey, issues: [], fetchedAt: null, partial: false, error: null }
}

export function createJiraSyncEngine(deps: JiraSyncEngineDeps): JiraSyncEngine {
  const staleMs = deps.staleMs ?? DEFAULT_STALE_MS

  // Single-flight per source: overlapping refreshes join the promise already running. The
  // attempt clock keeps a persistently failing source from re-fetching on every read - only
  // once per stale window, like a succeeding one.
  const inFlight = new Map<string, Promise<void>>()
  const lastAttemptAt = new Map<string, number>()

  /** The source's query, or the not-configured error explaining why it has none. */
  function resolveQuery(sourceKey: string): JiraQuery | JiraSyncError {
    if (sourceKey === GLOBAL_JIRA_SOURCE) return { kind: 'jql', jql: JIRA_GLOBAL_JQL }
    const match = /^project:(.+)$/.exec(sourceKey)
    if (!match) return { kind: 'not-configured', message: `Unknown Jira source: ${sourceKey}` }
    const project = deps.getProject(match[1])
    if (!project) {
      return { kind: 'not-configured', message: 'The project no longer exists.' }
    }
    if (project.jiraJql) return { kind: 'jql', jql: project.jiraJql }
    if (project.jiraBoardUrl) {
      const board = parseJiraBoardUrl(project.jiraBoardUrl)
      if (!board) {
        return {
          kind: 'not-configured',
          message: 'The Jira board URL on this project is invalid - expected a rapidView link.'
        }
      }
      return { kind: 'board', board }
    }
    return { kind: 'not-configured', message: 'This project has no Jira filter or board URL configured.' }
  }

  /** Land one fetch outcome in the read model. */
  function land(sourceKey: string, result: JiraFetchResult): void {
    if (result.ok) {
      if (result.warning) console.warn(`[jira] ${sourceKey}: ${result.warning}`)
      deps.repo.putSuccess(sourceKey, toSnapshots(result.issues, deps.now()), deps.now(), result.partial)
    } else {
      deps.repo.putError(sourceKey, { kind: result.kind, message: result.message })
    }
  }

  function startRefresh(sourceKey: string, query: JiraQuery): Promise<void> {
    let running = inFlight.get(sourceKey)
    if (!running) {
      lastAttemptAt.set(sourceKey, deps.now())
      running = deps
        .runQuery(sourceKey, query)
        .then(
          (result) => land(sourceKey, result),
          (err) =>
            land(sourceKey, {
              ok: false,
              kind: 'other',
              message: err instanceof Error ? err.message : String(err)
            })
        )
        .finally(() => {
          inFlight.delete(sourceKey)
          deps.onChanged(sourceKey)
        })
      inFlight.set(sourceKey, running)
    }
    return running
  }

  /** Whether the source needs a background refresh: strictly older than the stale window. */
  function isStale(sourceKey: string, fetchedAt: number | null): boolean {
    const reference = Math.max(fetchedAt ?? 0, lastAttemptAt.get(sourceKey) ?? 0)
    if (reference === 0) return true
    return deps.now() - reference > staleMs
  }

  /** The current envelope, with a not-configured source reported as such over any stale error. */
  function currentBoard(sourceKey: string, resolved: JiraQuery | JiraSyncError): JiraBoardSnapshot {
    const cached = deps.repo.getBoard(sourceKey) ?? emptyBoard(sourceKey)
    if ('message' in resolved) return { ...cached, error: resolved }
    return cached
  }

  return {
    async getBoard(sourceKey) {
      const resolved = resolveQuery(sourceKey)
      const board = currentBoard(sourceKey, resolved)
      if (!('message' in resolved) && isStale(sourceKey, board.fetchedAt)) {
        void startRefresh(sourceKey, resolved)
      }
      return board
    },

    async refresh(sourceKey) {
      const resolved = resolveQuery(sourceKey)
      if ('message' in resolved) return currentBoard(sourceKey, resolved)
      await startRefresh(sourceKey, resolved)
      return currentBoard(sourceKey, resolved)
    }
  }
}
