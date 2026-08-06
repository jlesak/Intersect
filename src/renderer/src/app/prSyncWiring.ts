import { usePrInboxStore } from '@renderer/features/prInbox'
import { useSettingsStore } from '@renderer/features/settings'

/**
 * Ask the board to refresh itself if it needs to. Whether it needs to is the store's guard to
 * answer, never this wiring's: the same question is asked from elsewhere, and two copies of it are
 * how two automatic triggers come to disagree.
 */
function askForRefresh(): void {
  void usePrInboxStore.getState().syncIfStale()
}

/**
 * Whether the settings load has finished, one way or the other. A load that ended in failure is
 * still finished: waiting longer would never produce a connection, and the next focus regain
 * re-evaluates anyway.
 */
function settingsHaveLanded(): boolean {
  const status = useSettingsStore.getState().status
  return status === 'ready' || status === 'error'
}

/**
 * Whether the cached board has been read, so its freshness stamp is the real one rather than the
 * null it starts life as. A cache that could not be read counts as landed too - it will not arrive
 * later, and a board with no data is exactly the one worth syncing.
 */
function theCachedBoardHasLanded(): boolean {
  const status = usePrInboxStore.getState().status
  return status === 'ready' || status === 'error'
}

/**
 * Run `act` once both stores have finished loading, immediately when they already have. Returns a
 * cancel that also drops a wait which has not fired yet, so a wiring torn down before its stores
 * load cannot reach for the network afterwards.
 */
function onceBothStoresHaveLanded(act: () => void): () => void {
  const unsubscribes: Array<() => void> = []
  let waiting = true
  const stopWaiting = (): void => {
    waiting = false
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe()
  }
  const check = (): void => {
    if (!waiting || !settingsHaveLanded() || !theCachedBoardHasLanded()) return
    stopWaiting()
    act()
  }
  unsubscribes.push(useSettingsStore.subscribe(check), usePrInboxStore.subscribe(check))
  check()
  return stopWaiting
}

/**
 * Keep the pull-request board fresh without the user pressing Sync: ask for a refresh at boot and
 * whenever the window regains focus. The Sync button stays the loud, unguarded path, so asking for
 * data right now is always one click away.
 *
 * Two stores must have loaded before the first ask, for different reasons. Without the settings,
 * the connection check reads an empty form and concludes there is nothing to sync. Without the
 * cached board, its freshness stamp is still null and reads as never synced, so relaunching the app
 * would re-sync a cache that is seconds old. Both loads start asynchronously at boot, so the boot
 * ask waits for each of them.
 *
 * Returns the teardown so a test (or a future re-wire) can stop listening.
 */
export function wirePrSync(): () => void {
  window.addEventListener('focus', askForRefresh)
  const stopWaitingForBoot = onceBothStoresHaveLanded(askForRefresh)

  return () => {
    window.removeEventListener('focus', askForRefresh)
    stopWaitingForBoot()
  }
}
