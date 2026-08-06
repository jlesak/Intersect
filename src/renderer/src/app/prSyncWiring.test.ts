import { beforeEach, describe, expect, test, vi } from 'vitest'

// The PR-inbox barrel transitively imports monaco, which cannot initialise under jsdom. The sync
// action itself is stubbed here, so no editor is ever needed.
vi.mock('monaco-editor', () => ({ editor: {} }))

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
  usePrInboxStore.setState({ sync, syncing: false })
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
