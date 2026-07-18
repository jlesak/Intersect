import { useEffect, useState } from 'react'
import type { CoreStatus } from '@common/ipc'
import { ipc } from '@renderer/shared/ipc/client'

/**
 * Blocking recovery overlay for a dead core process. Every feature talks to the core, so
 * once it has failed nothing in the app can work - surface the reason and offer the one
 * safe action (a full restart) instead of leaving dead buttons and hanging spinners.
 * Invisible in the normal starting -> ready flow.
 */
export function CoreStatusOverlay({ initialStatus }: { initialStatus?: CoreStatus }) {
  const [status, setStatus] = useState<CoreStatus>(initialStatus ?? { state: 'ready' })

  useEffect(() => ipc().system.onCoreStatus(setStatus), [])

  if (status.state !== 'failed') return null
  return (
    <div className="ix-core-failure" role="alertdialog" aria-modal="true">
      <div className="ix-core-failure__card">
        <h1>Background services stopped</h1>
        <p>
          Intersect&apos;s core process is not running, so sessions, projects, and settings are
          unavailable.
        </p>
        <p className="ix-core-failure__reason">{status.message ?? 'Unknown failure.'}</p>
        <button type="button" onClick={() => void ipc().system.restartApp()}>
          Restart Intersect
        </button>
      </div>
    </div>
  )
}
