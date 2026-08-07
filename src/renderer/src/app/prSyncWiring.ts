import { effectiveAdoOrgUrl, hasAdoConnection } from '@common/ado'
import { usePrInboxStore } from '@renderer/features/prInbox'
import { useSettingsStore } from '@renderer/features/settings'

/**
 * Tell the board whether Azure DevOps is reachable and which organisation it lives at, so its
 * refresh guard and its outbound pull-request links can consult those without reading another
 * feature's slice themselves.
 *
 * This crossing lives in the app layer because both directions of it are needed: the board's guard
 * needs the answer, and the settings form is where the answer changes. Having the board's store read
 * the settings barrel instead pulled the settings and projects UI into the board's module graph and
 * closed an import cycle back onto the store. Re-published on every settings change, so saving a
 * token switches automatic refreshing on without a restart.
 */
function publishConnection(): void {
  const settings = useSettingsStore.getState()
  // Settings that have not arrived look exactly like settings the user left blank, so an unloaded
  // form counts as no connection rather than as a reason to try.
  const ready = settings.status === 'ready'
  const board = usePrInboxStore.getState()
  board.setAdoConnected(ready && hasAdoConnection(settings.ado, settings.adoFallback))
  board.setAdoOrgUrl(ready ? effectiveAdoOrgUrl(settings.ado, settings.adoFallback) : '')
}

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
  publishConnection()
  const stopPublishingConnection = useSettingsStore.subscribe(publishConnection)

  window.addEventListener('focus', askForRefresh)
  // The connection is published again immediately before the boot ask rather than relied upon from
  // the subscription above, so the ask cannot depend on which of two subscribers a store notifies
  // first.
  const stopWaitingForBoot = onceBothStoresHaveLanded(() => {
    publishConnection()
    askForRefresh()
  })

  return () => {
    window.removeEventListener('focus', askForRefresh)
    stopWaitingForBoot()
    stopPublishingConnection()
  }
}
