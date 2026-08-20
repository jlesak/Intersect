import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { RunningTimer } from '@common/domain'

vi.mock('../ipc')
import * as api from '../ipc'
import { useTimeTrackingStore } from '../store'
import { SidebarTimer, TimerRailBadge } from './SidebarTimer'

const mocked = vi.mocked(api)

const TIMER: RunningTimer = {
  startedAt: new Date(2026, 6, 28, 9, 35, 0).getTime(),
  description: 'Sprint review',
  issueKey: null
}

/**
 * The shell mounts these outside the Time Tracking section, so they are the app-wide answer to
 * "is something running": present and stoppable while a timer runs, absent otherwise.
 */
describe('the running timer in the app shell', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocked.getTimer.mockResolvedValue(null)
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 28, 10, 0, 0))
    useTimeTrackingStore.setState({ timer: null })
  })

  afterEach(() => {
    vi.useRealTimers()
    useTimeTrackingStore.setState({ timer: null })
  })

  test('an idle app carries no chip and no rail marker', async () => {
    await act(async () => {
      render(
        <>
          <SidebarTimer />
          <TimerRailBadge />
        </>
      )
    })
    expect(document.querySelector('.ix-sidebar__timer')).toBeNull()
    expect(document.querySelector('[data-testid="timer-badge"]')).toBeNull()
  })

  test('a running timer shows its elapsed span and a Stop, plus the rail marker', async () => {
    useTimeTrackingStore.setState({ timer: TIMER })
    await act(async () => {
      render(
        <>
          <SidebarTimer />
          <TimerRailBadge />
        </>
      )
    })
    expect(document.querySelector('.ix-sidebar__timer .ix-timer__elapsed')?.textContent).toBe(
      '25:00'
    )
    expect(document.querySelector('.ix-sidebar__timer .ix-timer__action')?.textContent).toBe('Stop')
    expect(document.querySelector('[data-testid="timer-badge"]')).not.toBeNull()
  })

  test('Stop from the shell stops the same timer the section owns', async () => {
    useTimeTrackingStore.setState({ timer: TIMER })
    mocked.stopTimer.mockResolvedValue(null)
    mocked.getWeek.mockResolvedValue([])
    await act(async () => {
      render(<SidebarTimer />)
    })
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.ix-sidebar__timer .ix-timer__action')?.click()
    })
    expect(mocked.stopTimer).toHaveBeenCalledOnce()
  })
})
