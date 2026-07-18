import { useEffect, useState } from 'react'
import type { CoreStatus } from '@common/ipc'
import { ipc } from '@renderer/shared/ipc/client'

/**
 * Blocking recovery overlay for a dead core process. Every feature talks to the core, so
 * once it is gone nothing in the app can work - surface the state instead of leaving dead
 * buttons and hanging spinners. `restarting` is informational (recovery is automatic);
 * `failed` means automatic recovery gave up, so it offers the explicit ways out: retry the
 * core, quit, or relaunch the whole app. Invisible in the normal starting -> ready flow.
 */
export function CoreStatusOverlay({ initialStatus }: { initialStatus?: CoreStatus }) {
  const [status, setStatus] = useState<CoreStatus>(initialStatus ?? { state: 'ready' })

  useEffect(() => ipc().system.onCoreStatus(setStatus), [])

  if (status.state === 'restarting') {
    return (
      <div className="ix-core-failure" role="alertdialog" aria-modal="true">
        <div className="ix-core-failure__card">
          <h1>Background services restarting{status.attempt ? ` (attempt ${status.attempt})` : ''}...</h1>
          <p>
            The core process stopped and is being brought back automatically. Running sessions
            are marked interrupted; each terminal offers its own recovery action once services
            are back.
          </p>
          <p className="ix-core-failure__reason">{status.message ?? 'Unknown failure.'}</p>
        </div>
      </div>
    )
  }

  if (status.state !== 'failed') return null
  return (
    <div className="ix-core-failure" role="alertdialog" aria-modal="true">
      <div className="ix-core-failure__card">
        <h1>Background services stopped</h1>
        <p>
          Intersect&apos;s core process is not running and automatic recovery gave up, so
          sessions, projects, and settings are unavailable.
        </p>
        <p className="ix-core-failure__reason">{status.message ?? 'Unknown failure.'}</p>
        <div className="ix-core-failure__actions">
          <button type="button" onClick={() => void ipc().system.retryCore()}>
            Retry
          </button>
          <button type="button" onClick={() => void ipc().system.quitApp()}>
            Quit Intersect
          </button>
          <button type="button" onClick={() => void ipc().system.restartApp()}>
            Restart Intersect
          </button>
        </div>
      </div>
    </div>
  )
}
