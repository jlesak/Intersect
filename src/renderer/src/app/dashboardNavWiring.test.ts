import { beforeEach, describe, expect, test, vi } from 'vitest'

const navigateMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('./attentionWiring', () => ({ navigateToSession: navigateMock }))

import { useDashboardNavStore } from '@renderer/features/dashboard'
import { PR_INBOX_SECTION_ID, usePrInboxStore } from '@renderer/features/prInbox'
import { SETTINGS_SECTION_ID } from '@renderer/features/settings'
import { wireDashboardNav } from './dashboardNavWiring'
import { useShellStore } from './shellStore'

let unwire: () => void

beforeEach(() => {
  unwire?.()
  vi.clearAllMocks()
  useDashboardNavStore.setState({
    pendingPrOpen: null,
    pendingSessionGo: null,
    pendingSettings: false
  })
  useShellStore.getState().setActiveSection('dashboard')
  unwire = wireDashboardNav()
})

describe('wireDashboardNav', () => {
  test('a pull-request row lands on that PR in the PR Inbox', () => {
    const openDetail = vi.spyOn(usePrInboxStore.getState(), 'openDetail').mockResolvedValue()
    try {
      useDashboardNavStore.getState().openPr('repo-a', 42)
      expect(useShellStore.getState().context).toEqual({
        kind: 'section',
        id: PR_INBOX_SECTION_ID
      })
      expect(openDetail).toHaveBeenCalledWith('repo-a', 42)
      // Spent, so nothing replays it on the next unrelated change.
      expect(useDashboardNavStore.getState().pendingPrOpen).toBeNull()
    } finally {
      openDetail.mockRestore()
    }
  })

  test('a session row reveals that session without touching the section', () => {
    useDashboardNavStore.getState().goToSession('ws-1:tab-7')
    expect(navigateMock).toHaveBeenCalledWith('ws-1:tab-7')
    expect(useShellStore.getState().context).toEqual({ kind: 'section', id: 'dashboard' })
    expect(useDashboardNavStore.getState().pendingSessionGo).toBeNull()
  })

  test('a setup-needed line lands on Settings', () => {
    useDashboardNavStore.getState().openSettings()
    expect(useShellStore.getState().context).toEqual({
      kind: 'section',
      id: SETTINGS_SECTION_ID
    })
    // Spent, so nothing replays it on the next unrelated change.
    expect(useDashboardNavStore.getState().pendingSettings).toBe(false)
  })

  test('Settings can be asked for again after the user has left it', () => {
    useDashboardNavStore.getState().openSettings()
    useShellStore.getState().setActiveSection('dashboard')
    useDashboardNavStore.getState().openSettings()
    expect(useShellStore.getState().context).toEqual({
      kind: 'section',
      id: SETTINGS_SECTION_ID
    })
  })

  test('the same session can be asked for twice in a row', () => {
    useDashboardNavStore.getState().goToSession('ws-1:tab-7')
    useDashboardNavStore.getState().goToSession('ws-1:tab-7')
    expect(navigateMock).toHaveBeenCalledTimes(2)
  })

  test('unwiring stops it from navigating again', () => {
    unwire()
    useDashboardNavStore.getState().goToSession('ws-1:tab-7')
    expect(navigateMock).not.toHaveBeenCalled()
  })
})
