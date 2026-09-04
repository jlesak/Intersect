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

const labelField = (): HTMLInputElement =>
  document.querySelector('.ix-timer__label') as HTMLInputElement

/** Set an input's value the way React tracks it, then fire the change React listens for. */
const typeLabel = async (value: string): Promise<void> => {
  const input = labelField()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    input.focus()
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const blurLabel = async (): Promise<void> => {
  await act(async () => {
    labelField().dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

const pressLabel = async (key: string): Promise<void> => {
  await act(async () => {
    labelField().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

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

  test('shows the elapsed span, the issue key and the label while running', async () => {
    useTimeTrackingStore.setState({ timer: TIMER })
    await act(async () => {
      render(<TimerControl />)
    })
    expect(text('.ix-timer__elapsed')).toBe('25:00')
    expect(text('.ix-timer__what')).toBe('FID2507-611')
    expect(labelField().value).toBe('Refactor validators')
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

  test('an unattributed timer shows the elapsed span and an empty label to fill in', async () => {
    useTimeTrackingStore.setState({ timer: { ...TIMER, description: '  ', issueKey: null } })
    await act(async () => {
      render(<TimerControl />)
    })
    expect(text('.ix-timer__elapsed')).toBe('25:00')
    expect(document.querySelector('.ix-timer__what')).toBeNull()
    expect(labelField().value).toBe('  ')
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
  test('a typed label is saved against the running timer on blur', async () => {
    useTimeTrackingStore.setState({ timer: TIMER })
    mocked.updateTimer.mockResolvedValue({ ...TIMER, description: 'Code review' })
    await act(async () => {
      render(<TimerControl />)
    })
    await typeLabel('Code review')
    // Nothing is sent while the user is still typing: a keystroke is not a decision.
    expect(mocked.updateTimer).not.toHaveBeenCalled()
    await blurLabel()
    expect(mocked.updateTimer).toHaveBeenCalledWith('Code review', 'FID2507-611')
  })

  test('Enter saves the label without waiting for the focus to move', async () => {
    useTimeTrackingStore.setState({ timer: TIMER })
    mocked.updateTimer.mockResolvedValue({ ...TIMER, description: 'Code review' })
    await act(async () => {
      render(<TimerControl />)
    })
    await typeLabel('Code review')
    await pressLabel('Enter')
    expect(mocked.updateTimer).toHaveBeenCalledWith('Code review', 'FID2507-611')
  })

  test('Escape drops the draft and leaves the timer as it was', async () => {
    useTimeTrackingStore.setState({ timer: TIMER })
    await act(async () => {
      render(<TimerControl />)
    })
    await typeLabel('Wrong label')
    await pressLabel('Escape')
    expect(mocked.updateTimer).not.toHaveBeenCalled()
    expect(labelField().value).toBe('Refactor validators')
  })

  test('leaving the label untouched is not an edit', async () => {
    useTimeTrackingStore.setState({ timer: TIMER })
    await act(async () => {
      render(<TimerControl />)
    })
    await blurLabel()
    expect(mocked.updateTimer).not.toHaveBeenCalled()
  })

  test('Stop saves a label still being typed before it stops the timer', async () => {
    useTimeTrackingStore.setState({ timer: TIMER })
    const order: string[] = []
    mocked.updateTimer.mockImplementation(async () => {
      order.push('update')
      return { ...TIMER, description: 'Code review' }
    })
    mocked.stopTimer.mockImplementation(async () => {
      order.push('stop')
      return null
    })
    await act(async () => {
      render(<TimerControl />)
    })
    // No blur first: the label the user was mid-way through typing when they hit Stop has to reach
    // the entry, and in this order - the core reads the description off the running row at stop.
    await typeLabel('Code review')
    await clickAction()
    expect(mocked.updateTimer).toHaveBeenCalledWith('Code review', 'FID2507-611')
    expect(order).toEqual(['update', 'stop'])
  })

  test('Start focuses the label, so naming the span is the next keystroke', async () => {
    mocked.startTimer.mockResolvedValue({ ...TIMER, description: '', issueKey: null })
    await act(async () => {
      render(<TimerControl />)
    })
    await clickAction()
    expect(document.activeElement).toBe(labelField())
  })

  test('a label the store rejected stays on screen for another try', async () => {
    useTimeTrackingStore.setState({ timer: TIMER })
    mocked.updateTimer.mockRejectedValue(new Error('No timer is running'))
    await act(async () => {
      render(<TimerControl />)
    })
    await typeLabel('Code review')
    await blurLabel()
    expect(labelField().value).toBe('Code review')
  })
})
