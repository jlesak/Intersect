import { useEffect, useState } from 'react'
import type { CoreStatus } from '@common/ipc'
import { ipc } from '@renderer/shared/ipc/client'
import { Dialog } from '@renderer/shared/ui/Dialog'

/**
 * Blocking recovery overlay for a dead core process. Every feature talks to the core, so
 * once it is gone nothing in the app can work - surface the state instead of leaving dead
 * buttons and hanging spinners. `restarting` is informational (recovery is automatic);
 * `failed` means automatic recovery gave up, so it offers the explicit ways out: retry the
 * core, quit, relaunch the whole app, or open the data folder. Invisible in the normal
 * starting -> ready flow.
 *
 * When the database itself stopped the core, every start repeats the same failing step, so
 * retrying cannot help. Only then does the card also offer to set the database aside and start
 * fresh, behind a confirmation that names what goes and how to undo it.
 */
export function CoreStatusOverlay({ initialStatus }: { initialStatus?: CoreStatus }) {
  const [status, setStatus] = useState<CoreStatus>(initialStatus ?? { state: 'ready' })
  const [confirmingFresh, setConfirmingFresh] = useState(false)
  const [running, setRunning] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(
    () =>
      ipc().system.onCoreStatus((next) => {
        setStatus(next)
        // A refusal belongs to the card it was raised on; a new state starts without it.
        setFailure(null)
      }),
    []
  )

  /** Run one action at a time, reporting a refusal in place of throwing. */
  const run = (op: () => Promise<void>): void => {
    setFailure(null)
    setRunning(true)
    try {
      void op()
        .then(() => setRunning(false))
        .catch((err: unknown) => {
          setRunning(false)
          setFailure(describe(err))
        })
    } catch (err) {
      setRunning(false)
      setFailure(describe(err))
    }
  }

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
  const database = status.databaseFailure === true
  return (
    <div className="ix-core-failure" role="alertdialog" aria-modal="true">
      <div className="ix-core-failure__card">
        {database ? (
          <>
            <h1>Intersect could not open its database</h1>
            <p>
              Every start runs the same step against the same database file, so Retry and Restart
              Intersect fail the same way until that file changes. Setting the database aside
              starts Intersect on an empty one and keeps the old files.
            </p>
          </>
        ) : (
          <>
            <h1>Background services stopped</h1>
            <p>
              Intersect&apos;s core process is not running and automatic recovery gave up, so
              sessions, projects, and settings are unavailable.
            </p>
          </>
        )}
        <p className="ix-core-failure__reason">{status.message ?? 'Unknown failure.'}</p>
        <div className="ix-core-failure__actions">
          <button type="button" disabled={running} onClick={() => run(() => ipc().system.retryCore())}>
            Retry
          </button>
          <button type="button" disabled={running} onClick={() => run(() => ipc().system.quitApp())}>
            Quit Intersect
          </button>
          <button
            type="button"
            disabled={running}
            onClick={() => run(() => ipc().system.restartApp())}
          >
            Restart Intersect
          </button>
          <button
            type="button"
            disabled={running}
            onClick={() => run(() => ipc().system.revealUserData())}
          >
            Reveal data folder
          </button>
          {database && (
            <button type="button" disabled={running} onClick={() => setConfirmingFresh(true)}>
              Set database aside and start fresh
            </button>
          )}
        </div>
        {failure && <p className="ix-core-failure__reason">{failure}</p>}
      </div>

      {confirmingFresh && (
        <Dialog
          title="Set the database aside and start fresh?"
          overlayClass="ix-overlay--topmost"
          onClose={() => setConfirmingFresh(false)}
          actions={
            <>
              <button
                type="button"
                className="ix-btn ix-btn--ghost"
                onClick={() => setConfirmingFresh(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="ix-btn ix-btn--danger"
                onClick={() => {
                  setConfirmingFresh(false)
                  run(() => ipc().system.startFreshDatabase())
                }}
              >
                Set aside and start fresh
              </button>
            </>
          }
        >
          <p className="ix-crash__list-lead">Renamed in the data folder, nothing deleted:</p>
          <ul className="ix-crash__list">
            <li>intersect.db to intersect-set-aside-&lt;date&gt;-&lt;time&gt;.db</li>
            <li>intersect.db-wal to intersect-set-aside-&lt;date&gt;-&lt;time&gt;.db-wal</li>
            <li>intersect.db-shm to intersect-set-aside-&lt;date&gt;-&lt;time&gt;.db-shm</li>
          </ul>
          <p className="ix-crash__list-lead">Intersect then starts without:</p>
          <ul className="ix-crash__list">
            <li>workspaces, tabs and the resume points of Claude sessions</li>
            <li>projects, their repositories and pane layouts</li>
            <li>settings</li>
            <li>TODOs, time entries and the running timer</li>
            <li>1:1 history</li>
            <li>PR and Jira caches, draft PR comments and work item links</li>
          </ul>
          <p className="ix-crash__list-lead">Kept:</p>
          <ul className="ix-crash__list">
            <li>the logs and every other file in the data folder</li>
            <li>Claude Code transcripts and everything outside the data folder</li>
          </ul>
          <p className="ix-crash__list-lead">To undo, in this order:</p>
          <ol className="ix-crash__list">
            <li>Quit Intersect.</li>
            <li>
              In the data folder, delete or move away the new intersect.db, intersect.db-wal and
              intersect.db-shm, whichever exist.
            </li>
            <li>
              Rename each set-aside file back with its exact suffix: ….db to intersect.db, ….db-wal
              to intersect.db-wal, and ….db-shm to intersect.db-shm.
            </li>
            <li>Start Intersect.</li>
          </ol>
          <p className="ix-crash__list-lead">
            Move all three back together: a companion file left over from one database is read as
            part of the other.
          </p>
        </Dialog>
      )}
    </div>
  )
}

/** A refused action has to read as a refusal, whatever was thrown. */
function describe(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err)
  return detail ? `That did not run: ${detail}` : 'That did not run.'
}
