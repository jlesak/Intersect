import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useNow } from './useNow'

function Probe({ intervalMs }: { intervalMs: number | null }) {
  return <span data-testid="now">{useNow(intervalMs)}</span>
}

const shown = (): string => document.querySelector('[data-testid="now"]')?.textContent ?? ''

describe('useNow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 28, 10, 0, 0))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('starts at the current time', () => {
    render(<Probe intervalMs={1000} />)
    expect(shown()).toBe(String(Date.now()))
  })

  test('advances on each interval', () => {
    render(<Probe intervalMs={1000} />)
    const first = shown()
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(Number(shown())).toBe(Number(first) + 3000)
  })

  test('a null interval never ticks, so an idle caller pays nothing', () => {
    render(<Probe intervalMs={null} />)
    const first = shown()
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(shown()).toBe(first)
  })

  test('unmounting clears the interval', () => {
    const clear = vi.spyOn(globalThis, 'clearInterval')
    const view = render(<Probe intervalMs={1000} />)
    view.unmount()
    expect(clear).toHaveBeenCalled()
    clear.mockRestore()
  })
})
