import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ClaudeUsage, UsageLiveConsent, UsageLiveStatus } from '@common/domain'

vi.mock('../ipc')
import * as api from '../ipc'
import { useUsageStore } from '../store'
import { SidebarUsage } from './SidebarUsage'

const mocked = vi.mocked(api)

const snapshot: ClaudeUsage = {
  fiveHour: { usedPercent: 7, resetsAt: 1774933200 },
  sevenDay: { usedPercent: 53, resetsAt: 1780544400 },
  capturedAt: 1700000000000
}

/** Mount the panel with the store already in the state under test. */
function mounted(state: {
  usage?: ClaudeUsage | null
  consent?: UsageLiveConsent
  live?: UsageLiveStatus | null
}) {
  useUsageStore.setState(
    {
      usage: state.usage ?? null,
      consent: state.consent ?? 'unasked',
      live: state.live ?? null,
      refreshing: false
    },
    false
  )
  render(<SidebarUsage />)
}

const prompt = (): Element | null => document.querySelector('.ix-usage__consent')
const refreshBtn = (): Element | null => document.querySelector('.ix-usage__refresh')

beforeEach(() => {
  vi.clearAllMocks()
  mocked.setConsent.mockResolvedValue({ usage: snapshot, live: 'ok' })
  mocked.refresh.mockResolvedValue({ usage: snapshot, live: 'ok' })
})

describe('the consent question', () => {
  test('is up on a fresh install, before anything has been asked', () => {
    mounted({ consent: 'unasked' })
    expect(prompt()).toBeTruthy()
  })

  test('says what is read and warns that the OS will ask, so the dialog is expected', () => {
    mounted({ consent: 'unasked' })
    const text = prompt()?.textContent ?? ''
    expect(text).toMatch(/sign-in token/i)
    expect(text).toMatch(/keychain/i)
  })

  test('offers no refresh button while the question is unanswered', () => {
    mounted({ consent: 'unasked' })
    expect(refreshBtn()).toBeNull()
  })

  test('Allow records a yes, which is what lets the credential be read', () => {
    mounted({ consent: 'unasked' })
    fireEvent.click(screen.getByText('Allow'))
    expect(mocked.setConsent).toHaveBeenCalledWith(true)
  })

  test('Not now records a no', () => {
    mounted({ consent: 'unasked' })
    fireEvent.click(screen.getByText('Not now'))
    expect(mocked.setConsent).toHaveBeenCalledWith(false)
  })

  test('is gone once the question has been answered either way', () => {
    mounted({ consent: 'granted' })
    expect(prompt()).toBeNull()

    useUsageStore.setState({ consent: 'declined' }, false)
    expect(prompt()).toBeNull()
  })

  test('still shows the statusline snapshot underneath, so the panel is not empty', () => {
    mounted({ consent: 'unasked', usage: snapshot })
    expect(prompt()).toBeTruthy()
    expect(screen.getByText('5h session')).toBeTruthy()
  })
})

describe('after a no', () => {
  test('leaves a way back rather than hiding the feature for good', () => {
    mounted({ consent: 'declined' })
    const enable = document.querySelector('.ix-usage__enable')
    expect(enable).toBeTruthy()

    fireEvent.click(enable as Element)
    expect(mocked.setConsent).toHaveBeenCalledWith(true)
  })

  test('offers no refresh button, since the query is barred', () => {
    mounted({ consent: 'declined' })
    expect(refreshBtn()).toBeNull()
  })
})

describe('after a yes', () => {
  test('shows the refresh button, and clicking it queries', () => {
    mounted({ consent: 'granted', usage: snapshot })
    const button = refreshBtn()
    expect(button).toBeTruthy()

    fireEvent.click(button as Element)
    expect(mocked.refresh).toHaveBeenCalledTimes(1)
  })

  test('names the failure when the query was allowed but produced nothing', () => {
    mounted({ consent: 'granted', usage: snapshot, live: 'unavailable' })
    const note = document.querySelector('.ix-usage__note')
    expect(note?.textContent).toMatch(/live usage unavailable/i)
  })

  test('stays quiet while the query is working', () => {
    mounted({ consent: 'granted', usage: snapshot, live: 'ok' })
    expect(document.querySelector('.ix-usage__note')).toBeNull()
  })

  test('does not blame the user for a query that was never allowed', () => {
    // `not-allowed` is the core declining, not a failure - the panel has its own prompt for that.
    mounted({ consent: 'unasked', live: 'not-allowed' })
    expect(document.querySelector('.ix-usage__note')).toBeNull()
  })
})
