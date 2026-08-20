import { useState } from 'react'
import { hasIpcBridge, ipc } from '@renderer/shared/ipc/client'
import {
  noteViewStateReset,
  reloadWindow,
  requestSafeMode,
  type UnrecoveredCrash
} from '@renderer/shared/recovery/bootRecovery'
import { Dialog } from './Dialog'

/**
 * The ways out of a failure that persisted state is causing, ordered least to most destructive.
 *
 * Safe mode is first because it destroys nothing and is also the better diagnostic: an app that
 * boots without its saved session and workspace state implicates that state, and an app that still
 * crashes has just saved the user from paying for a reset that would not have helped. Reset comes
 * second and is the only one that discards anything. Revealing the profile directory is last,
 * because it invites deleting everything.
 *
 * Nothing here happens on its own. The detection behind the crash card can prove only that
 * retrying has not worked; it cannot prove that persisted state is the cause, so every step is a
 * click and the one irreversible step is a click plus a confirmation that names what goes.
 *
 * The same list serves the crash card and the running safe-mode session. A user watching safe mode
 * come up holds the strongest evidence there is that the saved state is at fault, so that is the
 * moment the remedy has to be within reach - offering it only on a crash screen would mean
 * leaving safe mode and crashing again to act on what safe mode just proved. `offerSafeMode` is
 * what drops the first escape for the surface already running it.
 */
export function RecoveryEscapes({ offerSafeMode }: { offerSafeMode: boolean }) {
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [running, setRunning] = useState<'reset' | 'reveal' | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  // Asked without constructing a call: `ipc()` throws when preload never attached, and a throw
  // inside this render would take away the last surface the user has. Safe mode needs no bridge,
  // so it stays available even here - which is the reason it is the first thing offered.
  const bridged = hasIpcBridge()

  const startSafeMode = (): void => {
    requestSafeMode()
    reloadWindow()
  }

  /** Run an escape that needs the core or main, reporting a refusal in place of throwing. */
  const run = (which: 'reset' | 'reveal', op: () => Promise<void>): void => {
    setFailure(null)
    setRunning(which)
    try {
      void op()
        .then(() => {
          // A reset leaves every store holding the state it just replaced, so the only honest next
          // step is a fresh boot. The note is what lets that boot say the reset happened.
          if (which === 'reset') {
            noteViewStateReset()
            reloadWindow()
            return
          }
          setRunning(null)
        })
        .catch((err: unknown) => {
          setRunning(null)
          setFailure(describe(err))
        })
    } catch (err) {
      // The bridge can refuse synchronously. The other escapes have to survive that.
      setRunning(null)
      setFailure(describe(err))
    }
  }

  return (
    <>
      <ul className="ix-crash__escapes">
        {offerSafeMode && (
          <li>
            <button type="button" className="ix-btn" onClick={startSafeMode}>
              Start in safe mode
            </button>
            <span>
              Reloads without restoring the saved session or workspace state, and lands on Settings.
              Nothing is deleted, and the next launch is an ordinary one.
            </span>
          </li>
        )}
        <li>
          <button
            type="button"
            className="ix-btn"
            disabled={!bridged || running !== null}
            onClick={() => setConfirmingReset(true)}
          >
            Reset view and layout state
          </button>
          <span>
            Clears pane layouts, pane divider positions and the remembered workspace. Terminals,
            tabs, projects and settings are kept. This cannot be undone.
          </span>
        </li>
        <li>
          <button
            type="button"
            className="ix-btn"
            disabled={!bridged || running !== null}
            onClick={() => run('reveal', () => ipc().system.revealUserData())}
          >
            Reveal data folder
          </button>
          <span>
            Opens the folder holding the database and the logs, so the profile can be inspected or
            removed by hand.
          </span>
        </li>
      </ul>

      {!bridged && (
        <p className="ix-crash__reason">
          {offerSafeMode
            ? "The bridge to Intersect's background processes did not load, so the last two options cannot run. Safe mode still works."
            : "The bridge to Intersect's background processes did not load, so neither option can run."}
        </p>
      )}
      {failure && <p className="ix-crash__reason">{failure}</p>}

      {confirmingReset && (
        <Dialog
          title="Reset view and layout state?"
          overlayClass="ix-overlay--topmost"
          onClose={() => setConfirmingReset(false)}
          actions={
            <>
              <button
                type="button"
                className="ix-btn ix-btn--ghost"
                onClick={() => setConfirmingReset(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="ix-btn ix-btn--danger"
                onClick={() => {
                  setConfirmingReset(false)
                  run('reset', () => ipc().system.resetViewState())
                }}
              >
                Reset and reload
              </button>
            </>
          }
        >
          <p className="ix-crash__list-lead">Cleared, permanently:</p>
          <ul className="ix-crash__list">
            <li>every workspace&apos;s pane layout, back to a single pane</li>
            <li>every pane divider position, in every project</li>
            <li>the grouping of tabs across panes, collapsed into one group</li>
            <li>the workspace Intersect reopens at launch</li>
          </ul>
          <p className="ix-crash__list-lead">Kept:</p>
          <ul className="ix-crash__list">
            <li>every tab and every terminal, with its title and its resume point</li>
            <li>every workspace and every project</li>
            <li>settings, PR and Jira data, TODOs and time entries</li>
          </ul>
          <p className="ix-crash__list-lead">
            Nothing backs these up and nothing undoes this. Intersect reloads straight afterwards.
          </p>
        </Dialog>
      )}
    </>
  )
}

/**
 * The extra offer a window-scope crash earns once the app has failed twice with no successful
 * render in between. Reloading has demonstrably not worked by then, so the card stops being only
 * a report and starts being a way out.
 */
export function CrashEscapes({ previousCrash }: { previousCrash: UnrecoveredCrash }) {
  return (
    <>
      <p className="ix-crash__evidence">{evidenceLine(previousCrash)}</p>
      <RecoveryEscapes offerSafeMode />
    </>
  )
}

/**
 * What the marker actually proves, and no more: no ordinary launch has stayed up since that
 * failure, so reloading has already been tried. A safe-mode session in between keeps the marker,
 * because coming up without the saved state says nothing about coming up with it, so the line
 * speaks of ordinary launches. It says nothing about frequency or about a loop, because the marker
 * is evidence of neither.
 */
function evidenceLine(crash: UnrecoveredCrash): string {
  const at = clockTime(crash.at)
  const lead = at
    ? `The last failure was at ${at}, and no ordinary launch has stayed up since.`
    : 'No ordinary launch has stayed up since the last failure.'
  return `${lead} Reloading has already been tried. The ways out below run from harmless to permanent.`
}

/** The crash time as a wall clock, or null when the recorded value cannot be shown as one. */
function clockTime(at: number): string | null {
  try {
    const date = new Date(at)
    if (Number.isNaN(date.getTime())) return null
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return null
  }
}

/** A refused escape has to read as a refusal, whatever was thrown. */
function describe(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err)
  return detail ? `That did not run: ${detail}` : 'That did not run.'
}
