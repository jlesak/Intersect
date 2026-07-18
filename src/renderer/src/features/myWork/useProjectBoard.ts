import { useCallback, useEffect, useState } from 'react'
import { projectJiraSource, type JiraBoardSnapshot } from '@common/domain'
import * as api from './ipc'

/**
 * One project's own Jira board (its JQL filter or board URL) with the core's cache semantics:
 * the cached envelope paints immediately, a stale cache triggers one shared background refresh
 * whose completion push re-fetches, and `refresh` forces a fresh fetch on demand.
 */
export function useProjectBoard(projectId: string): {
  board: JiraBoardSnapshot | null
  refreshing: boolean
  refresh(): void
} {
  const [board, setBoard] = useState<JiraBoardSnapshot | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    let disposed = false
    setBoard(null)
    const load = (): void => {
      api.projectBoard(projectId).then(
        (b) => {
          if (!disposed) setBoard(b)
        },
        () => {}
      )
    }
    load()
    const sourceKey = projectJiraSource(projectId)
    const unsubscribe = api.onChanged((event) => {
      if (event.sourceKey === sourceKey) load()
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [projectId])

  const refresh = useCallback(() => {
    setRefreshing(true)
    api
      .refreshProject(projectId)
      .then(
        (b) => setBoard(b),
        () => {}
      )
      .finally(() => setRefreshing(false))
  }, [projectId])

  return { board, refreshing, refresh }
}
