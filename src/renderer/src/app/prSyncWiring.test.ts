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

/** Older than any staleness window the wiring applies, so the board counts as out of date. */
const LONG_AGO_MS = 60 * 60 * 1000

const sync = vi.fn(async () => {})
let unwire: (() => void) | undefined

function settingsAre(status: 'idle' | 'loading' | 'ready' | 'error', ado: AdoSettings): void {
  useSettingsStore.setState({ status, ado, adoFallback: NO_FALLBACK })
}

function boardWasSynced(agoMs: number | null): void {
  usePrInboxStore.setState({ syncedAt: agoMs === null ? null : Date.now() - agoMs })
}

function focusWindow(): void {
  window.dispatchEvent(new Event('focus'))
}

/**
 * Wire with a freshly synced, connected board, so the boot attempt is a no-op and each test can
 * then set up exactly the state its focus event should be judged against.
 */
function wireWithAFreshBoard(): void {
  settingsAre('ready', CONNECTED_ADO)
  boardWasSynced(0)
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
    boardWasSynced(LONG_AGO_MS)
    focusWindow()
    expect(sync).toHaveBeenCalledTimes(1)
    expect(sync).toHaveBeenCalledWith({ quiet: true })
  })

  test('a board that has never synced is refreshed on focus', () => {
    wireWithAFreshBoard()
    boardWasSynced(null)
    focusWindow()
    expect(sync).toHaveBeenCalledWith({ quiet: true })
  })

  test('a focus event leaves a board that was just synced alone', () => {
    wireWithAFreshBoard()
    focusWindow()
    expect(sync).not.toHaveBeenCalled()
  })

  test('a stale board is not refreshed without an Azure DevOps connection', () => {
    wireWithAFreshBoard()
    boardWasSynced(LONG_AGO_MS)
    settingsAre('ready', BLANK_ADO)
    focusWindow()
    expect(sync).not.toHaveBeenCalled()
  })

  test('a sync already in flight is never joined by a second one', () => {
    wireWithAFreshBoard()
    boardWasSynced(LONG_AGO_MS)
    usePrInboxStore.setState({ syncing: true })
    focusWindow()
    expect(sync).not.toHaveBeenCalled()
  })

  test('settings that have not arrived yet count as no connection', () => {
    settingsAre('idle', CONNECTED_ADO)
    boardWasSynced(LONG_AGO_MS)
    unwire = wirePrSync()
    focusWindow()
    expect(sync).not.toHaveBeenCalled()
  })

  test('the boot refresh waits for the settings instead of reading them empty', () => {
    settingsAre('idle', BLANK_ADO)
    boardWasSynced(LONG_AGO_MS)
    unwire = wirePrSync()
    expect(sync).not.toHaveBeenCalled()

    settingsAre('ready', CONNECTED_ADO)
    expect(sync).toHaveBeenCalledTimes(1)
    expect(sync).toHaveBeenCalledWith({ quiet: true })
  })

  test('a boot with the settings already loaded refreshes a stale board at once', () => {
    settingsAre('ready', CONNECTED_ADO)
    boardWasSynced(LONG_AGO_MS)
    unwire = wirePrSync()
    expect(sync).toHaveBeenCalledWith({ quiet: true })
  })

  test('settings that failed to load mean no automatic sync', () => {
    settingsAre('idle', CONNECTED_ADO)
    boardWasSynced(LONG_AGO_MS)
    unwire = wirePrSync()
    settingsAre('error', CONNECTED_ADO)
    expect(sync).not.toHaveBeenCalled()
  })

  test('unwiring stops a later focus event from refreshing', () => {
    wireWithAFreshBoard()
    unwire?.()
    unwire = undefined
    boardWasSynced(LONG_AGO_MS)
    focusWindow()
    expect(sync).not.toHaveBeenCalled()
  })

  test('unwiring drops a boot refresh that is still waiting on the settings', () => {
    settingsAre('idle', CONNECTED_ADO)
    boardWasSynced(LONG_AGO_MS)
    unwire = wirePrSync()
    unwire()
    unwire = undefined
    settingsAre('ready', CONNECTED_ADO)
    expect(sync).not.toHaveBeenCalled()
  })
})
