import { hasAdoConnection } from '@common/ado'
import { usePrInboxStore } from '@renderer/features/prInbox'
import { useSettingsStore } from '@renderer/features/settings'

/**
 * How old the board's data may be before coming back to the window is worth a refresh.
 *
 * One sync is one Azure DevOps call per repository plus one thread fetch per open pull request, so
 * refreshing on every single focus regain would fire that whole fan-out each time the user glances
 * away at their editor. Five minutes is short enough that a board being read is effectively live,
 * and long enough that alt-tabbing costs nothing.
 */
const STALE_AFTER_MS = 5 * 60 * 1000

/**
 * Refresh the board when returning to it would otherwise show data worth doubting: Azure DevOps is
 * connected, the last refresh is old enough to matter (or never happened), and no refresh is
 * already running.
 *
 * Always quiet. The user did not ask for this sync, so a machine that is merely offline must not
 * interrupt them with a toast; the failure is recorded on the board itself instead.
 */
function syncWhenStale(): void {
  const settings = useSettingsStore.getState()
  // Settings that have not arrived look exactly like settings the user left blank, so an unloaded
  // form counts as no connection rather than as a reason to try.
  if (settings.status !== 'ready') return
  if (!hasAdoConnection(settings.ado, settings.adoFallback)) return

  const board = usePrInboxStore.getState()
  if (board.syncing) return
  if (board.syncedAt !== null && Date.now() - board.syncedAt < STALE_AFTER_MS) return

  void board.sync({ quiet: true })
}

/**
 * Keep the pull-request board fresh without the user pressing Sync: refresh at boot and whenever
 * the window regains focus, under the staleness guard above. The Sync button stays the loud,
 * unguarded path, so asking for data right now is always one click away.
 *
 * The settings load that decides whether Azure DevOps is connected runs asynchronously at boot, so
 * the boot attempt waits for it to finish rather than reading an empty form and concluding there is
 * nothing to sync. A settings load that fails outright means no automatic sync at all, and the next
 * focus regain re-evaluates.
 *
 * Returns the teardown so a test (or a future re-wire) can stop listening.
 */
export function wirePrSync(): () => void {
  window.addEventListener('focus', syncWhenStale)

  let stopWaitingForSettings: (() => void) | undefined
  if (useSettingsStore.getState().status === 'ready') {
    syncWhenStale()
  } else {
    stopWaitingForSettings = useSettingsStore.subscribe((state) => {
      if (state.status !== 'ready') return
      stopWaitingForSettings?.()
      stopWaitingForSettings = undefined
      syncWhenStale()
    })
  }

  return () => {
    window.removeEventListener('focus', syncWhenStale)
    stopWaitingForSettings?.()
    stopWaitingForSettings = undefined
  }
}
