import { useEffect } from 'react'
import { useSessionsStore } from '../store'
import { SessionFilters } from './SessionFilters'
import { SessionList } from './SessionList'
import { TranscriptViewer } from './TranscriptViewer'

/**
 * The Sessions section's main region: a filters bar over a master-detail body - the filtered
 * session list on the left and the selected session's transcript on the right. Builds the index
 * on first mount, mirroring how WorkspaceView hydrates the tabs store.
 */
export function SessionsView() {
  useEffect(() => {
    const { status } = useSessionsStore.getState()
    if (status === 'idle') void useSessionsStore.getState().hydrate()
  }, [])

  return (
    <div className="ix-main">
      <SessionFilters />
      <div className="ix-sessions-body">
        <SessionList />
        <TranscriptViewer />
      </div>
    </div>
  )
}
