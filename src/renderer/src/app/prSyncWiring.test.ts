import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AdoFallback, AdoSettings } from '@common/domain'
import { usePrInboxStore } from '@renderer/features/prInbox'
import { useSettingsStore } from '@renderer/features/settings'
import { wirePrSync } from './prSyncWiring'

const CONNECTED_ADO: AdoSettings = {
  orgUrl: 'https://dev.azure.com/acme',
  project: 'shop',
  repository: 'web',
  pat: 'token'
}
const BLANK_ADO: AdoSettings = { orgUrl: '', project: '', repository: '', pat: '' }
const NO_FALLBACK: AdoFallback = { orgUrl: '', project: '', hasPat: false }

/** Older than any staleness window the guard applies, so the board counts as out of date. */
const LONG_AGO_MS = 60 * 60 * 1000

const sync = vi.fn(async () => {})
let unwire: (() => void) | undefined

function settingsAre(status: 'idle' | 'loading' | 'ready' | 'error', ado: AdoSettings): void {
  useSettingsStore.setState({ status, ado, adoFallback: NO_FALLBACK })
}

/**
 * Put the board in the state a boot attempt has to judge: whether the cached board has been read
 * yet, and how fresh it turned out to be.
 */
function boardIs(status: 'idle' | 'loading' | 'ready' | 'error', syncedAgoMs: number | null): void {
  usePrInboxStore.setState({
    status,
    syncedAt: syncedAgoMs === null ? null : Date.now() - syncedAgoMs
  })
}

function focusWindow(): void {
  window.dispatchEvent(new Event('focus'))
}

/**
 * Wire with both stores loaded and a freshly synced board, so the boot attempt is a no-op and each
 * test can then set up exactly the state its focus event should be judged against.
 */
function wireWithAFreshBoard(): void {
  settingsAre('ready', CONNECTED_ADO)
  boardIs('ready', 0)
  unwire = wirePrSync()
  expect(sync).not.toHaveBeenCalled()
}

beforeEach(() => {
  unwire?.()
  unwire = undefined
  sync.mockClear()
  usePrInboxStore.setState({ sync, syncing: false, adoConnected: false, adoOrgUrl: '' })
})

describe('wirePrSync', () => {
  test('a focus event refreshes a board that has gone stale, quietly', () => {
    wireWithAFreshBoard()
    boardIs('ready', LONG_AGO_MS)
    focusWindow()
    expect(sync).toHaveBeenCalledTimes(1)
    expect(sync).toHaveBeenCalledWith({ quiet: true })
  })

  test('a focus event leaves a board that was just synced alone', () => {
    wireWithAFreshBoard()
    focusWindow()
    expect(sync).not.toHaveBeenCalled()
  })

  test('a boot with both stores loaded refreshes a stale board at once', () => {
    settingsAre('ready', CONNECTED_ADO)
    boardIs('ready', LONG_AGO_MS)
    unwire = wirePrSync()
    expect(sync).toHaveBeenCalledWith({ quiet: true })
  })

  test('a boot whose cached board is still fresh does not sync at all', () => {
    settingsAre('ready', CONNECTED_ADO)
    boardIs('idle', null)
    unwire = wirePrSync()
    expect(sync).not.toHaveBeenCalled()

    // Relaunching minutes after a sync must not repeat it, which is only decidable once the cache
    // has been read: the board reports ready and its stamp in one go.
    boardIs('ready', 8_700)
    expect(sync).not.toHaveBeenCalled()
  })

  test('the boot refresh waits for the settings instead of reading them empty', () => {
    settingsAre('idle', BLANK_ADO)
    boardIs('ready', LONG_AGO_MS)
    unwire = wirePrSync()
    expect(sync).not.toHaveBeenCalled()

    settingsAre('ready', CONNECTED_ADO)
    expect(sync).toHaveBeenCalledTimes(1)
    expect(sync).toHaveBeenCalledWith({ quiet: true })
  })

  test('the boot refresh waits for the cached board instead of reading it as never synced', () => {
    settingsAre('ready', CONNECTED_ADO)
    boardIs('idle', null)
    unwire = wirePrSync()
    expect(sync).not.toHaveBeenCalled()

    boardIs('ready', LONG_AGO_MS)
    expect(sync).toHaveBeenCalledTimes(1)
  })

  test('a cache that could not be read still gets its boot refresh', () => {
    settingsAre('ready', CONNECTED_ADO)
    boardIs('idle', null)
    unwire = wirePrSync()
    boardIs('error', null)
    expect(sync).toHaveBeenCalledTimes(1)
  })

  test('settings that failed to load mean no automatic sync', () => {
    settingsAre('idle', CONNECTED_ADO)
    boardIs('ready', LONG_AGO_MS)
    unwire = wirePrSync()
    settingsAre('error', CONNECTED_ADO)
    expect(sync).not.toHaveBeenCalled()
  })

  test('unwiring stops a later focus event from refreshing', () => {
    wireWithAFreshBoard()
    unwire?.()
    unwire = undefined
    boardIs('ready', LONG_AGO_MS)
    focusWindow()
    expect(sync).not.toHaveBeenCalled()
  })

  test('unwiring drops a boot refresh that is still waiting on the settings', () => {
    settingsAre('idle', CONNECTED_ADO)
    boardIs('ready', LONG_AGO_MS)
    unwire = wirePrSync()
    unwire()
    unwire = undefined
    settingsAre('ready', CONNECTED_ADO)
    expect(sync).not.toHaveBeenCalled()
  })

  test('unwiring drops a boot refresh that is still waiting on the cached board', () => {
    settingsAre('ready', CONNECTED_ADO)
    boardIs('idle', null)
    unwire = wirePrSync()
    unwire()
    unwire = undefined
    boardIs('ready', LONG_AGO_MS)
    expect(sync).not.toHaveBeenCalled()
  })
})

/**
 * The board's refresh guard asks its own state whether Azure DevOps is reachable, and this wiring is
 * what puts the answer there. Nothing else does, so a board left disconnected here never refreshes
 * itself however stale it gets.
 */
describe('the connection the board judges itself against', () => {
  const connected = (): boolean => usePrInboxStore.getState().adoConnected

  test('loaded settings that reach Azure DevOps mark the board connected', () => {
    settingsAre('ready', CONNECTED_ADO)
    boardIs('ready', 0)
    unwire = wirePrSync()
    expect(connected()).toBe(true)
  })

  test('settings that have not loaded leave the board disconnected', () => {
    settingsAre('loading', CONNECTED_ADO)
    boardIs('ready', 0)
    unwire = wirePrSync()
    expect(connected()).toBe(false)
  })

  test('loaded settings with nothing to connect with leave the board disconnected', () => {
    settingsAre('ready', BLANK_ADO)
    boardIs('ready', 0)
    unwire = wirePrSync()
    expect(connected()).toBe(false)
  })

  test('saving a token makes the board refresh on the next focus, with no restart', () => {
    settingsAre('ready', BLANK_ADO)
    boardIs('ready', LONG_AGO_MS)
    unwire = wirePrSync()
    focusWindow()
    expect(sync).not.toHaveBeenCalled()

    settingsAre('ready', CONNECTED_ADO)
    focusWindow()
    expect(sync).toHaveBeenCalledTimes(1)
  })

  test('unwiring stops the connection being republished', () => {
    settingsAre('ready', BLANK_ADO)
    boardIs('ready', LONG_AGO_MS)
    unwire = wirePrSync()
    unwire()
    unwire = undefined

    settingsAre('ready', CONNECTED_ADO)
    expect(connected()).toBe(false)
  })
})

/**
 * The detail's links out to Azure DevOps are built from the organisation URL, and this wiring is the
 * only thing that puts it in the board's reach. Without it every pull request would look like one
 * the app cannot address.
 */
describe('the organisation the board links out to', () => {
  const orgUrl = (): string => usePrInboxStore.getState().adoOrgUrl

  test('the saved organisation URL reaches the board', () => {
    settingsAre('ready', CONNECTED_ADO)
    boardIs('ready', 0)
    unwire = wirePrSync()
    expect(orgUrl()).toBe('https://dev.azure.com/acme')
  })

  test('a blank saved field takes the organisation from the fallback', () => {
    useSettingsStore.setState({
      status: 'ready',
      ado: BLANK_ADO,
      adoFallback: { orgUrl: 'https://devops.example.com/tfs/DefaultCollection', project: '', hasPat: true }
    })
    boardIs('ready', 0)
    unwire = wirePrSync()
    expect(orgUrl()).toBe('https://devops.example.com/tfs/DefaultCollection')
  })

  test('settings that have not loaded name no organisation at all', () => {
    settingsAre('loading', CONNECTED_ADO)
    boardIs('ready', 0)
    unwire = wirePrSync()
    expect(orgUrl()).toBe('')
  })

  test('pointing the app at another server takes effect without a restart', () => {
    settingsAre('ready', BLANK_ADO)
    boardIs('ready', 0)
    unwire = wirePrSync()
    expect(orgUrl()).toBe('')

    settingsAre('ready', CONNECTED_ADO)
    expect(orgUrl()).toBe('https://dev.azure.com/acme')
  })
})
