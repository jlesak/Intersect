import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { RunningTimer } from '@common/domain'

vi.mock('../ipc')
import * as api from '../ipc'
import { useTimeTrackingStore } from '../store'
import { TimerControl } from './TimerControl'

const mocked = vi.mocked(api)

const TIMER: RunningTimer = {
  startedAt: new Date(2026, 6, 28, 9, 35, 0).getTime(),
  description: 'Refactor validators',
  issueKey: 'FID2507-611'
}

const text = (selector: string): string =>
  document.querySelector(selector)?.textContent?.trim() ?? ''

const clickAction = async (): Promise<void> => {
  await act(async () => {
    document.querySelector<HTMLButtonElement>('.ix-timer__action')?.click()
  })
}

/**
 * Mounted client-side rather than as static markup: the control subscribes to the store, and only
 * a real root can expose a re-render loop from an unstable selector.
 */
describe('TimerControl', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocked.getWeek.mockResolvedValue([])
    mocked.getTimer.mockResolvedValue(null)
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 28, 10, 0, 0))
    useTimeTrackingStore.setState({ timer: null })
  })

  afterEach(() => {
    vi.useRealTimers()
    useTimeTrackingStore.setState({ timer: null })
  })

  test('offers a single Start when nothing runs, and settles without a render loop', async () => {
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })
    try {
      await act(async () => {
        render(<TimerControl />)
      })
      expect(logged).toEqual([])
      expect(text('.ix-timer__action')).toBe('Start')
      expect(document.querySelector('.ix-timer__elapsed')).toBeNull()
    } finally {
      consoleError.mockRestore()
    }
  })

  test('shows the elapsed span and the attribution while running', async () => {
    useTimeTrackingStore.setState({ timer: TIMER })
    await act(async () => {
      render(<TimerControl />)
    })
    expect(text('.ix-timer__elapsed')).toBe('25:00')
    expect(text('.ix-timer__what')).toContain('Refactor validators')
    expect(text('.ix-timer__what')).toContain('FID2507-611')
    expect(text('.ix-timer__action')).toBe('Stop')
  })

  test('the elapsed span advances a second at a time while it runs', async () => {
    useTimeTrackingStore.setState({ timer: TIMER })
    await act(async () => {
      render(<TimerControl />)
    })
    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    expect(text('.ix-timer__elapsed')).toBe('25:01')
    await act(async () => {
      vi.advanceTimersByTime(59_000)
    })
    expect(text('.ix-timer__elapsed')).toBe('26:00')
  })

  test('an unattributed timer shows the elapsed span and nothing else to read', async () => {
    useTimeTrackingStore.setState({ timer: { ...TIMER, description: '  ', issueKey: null } })
    await act(async () => {
      render(<TimerControl />)
    })
    expect(text('.ix-timer__elapsed')).toBe('25:00')
    expect(document.querySelector('.ix-timer__what')).toBeNull()
  })

  test('Start asks the store to start an unattributed timer', async () => {
    mocked.startTimer.mockResolvedValue(TIMER)
    await act(async () => {
      render(<TimerControl />)
    })
    await clickAction()
    expect(mocked.startTimer).toHaveBeenCalledWith('', null)
  })

  test('Stop asks the store to stop', async () => {
    useTimeTrackingStore.setState({ timer: TIMER })
    mocked.stopTimer.mockResolvedValue(null)
    await act(async () => {
      render(<TimerControl />)
    })
    await clickAction()
    expect(mocked.stopTimer).toHaveBeenCalled()
  })

  test('a double-clicked Start begins one timer, not two', async () => {
    let resolve!: (t: RunningTimer) => void
    mocked.startTimer.mockReturnValue(new Promise<RunningTimer>((r) => (resolve = r)))
    await act(async () => {
      render(<TimerControl />)
    })

    // Both clicks of a double-click land before React can re-render, which is exactly the gesture
    // that used to raise "Could not start the timer" for a perfectly ordinary bit of impatience.
    await act(async () => {
      const button = document.querySelector<HTMLButtonElement>('.ix-timer__action')
      button?.click()
      button?.click()
    })
    expect(mocked.startTimer).toHaveBeenCalledOnce()
    expect(document.querySelector<HTMLButtonElement>('.ix-timer__action')?.disabled).toBe(true)

    await act(async () => {
      resolve(TIMER)
    })
    expect(document.querySelector<HTMLButtonElement>('.ix-timer__action')?.disabled).toBe(false)
  })

  test('a double-clicked Stop stops once, so the logged span is not thrown away', async () => {
    useTimeTrackingStore.setState({ timer: TIMER })
    let resolve!: () => void
    mocked.stopTimer.mockReturnValue(new Promise<null>((r) => (resolve = () => r(null))))
    await act(async () => {
      render(<TimerControl />)
    })

    await act(async () => {
      const button = document.querySelector<HTMLButtonElement>('.ix-timer__action')
      button?.click()
      button?.click()
    })
    expect(mocked.stopTimer).toHaveBeenCalledOnce()

    await act(async () => {
      resolve()
    })
  })
})
