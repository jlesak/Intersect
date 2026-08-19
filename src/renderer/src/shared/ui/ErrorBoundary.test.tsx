import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest'
import { captureRendererLog } from '../logging/testLog'
import { ErrorBoundary, RENDERER_CRASH_LOG_MESSAGE } from './ErrorBoundary'

/**
 * A child that throws until the cause is cleared. The flag lives outside the component because a
 * caught error unmounts the subtree, so its own state cannot survive to the retry.
 */
let childFails = true

function FailsUntilFixed({ label }: { label: string }) {
  if (childFails) throw new Error('boom')
  return <div className="ix-probe">{label}</div>
}

function AlwaysFails(): never {
  throw new Error('boom')
}

/** Not every throw carries an Error - a boundary that trusts the thrown value stops containing. */
function ThrowsNull(): never {
  throw null
}

describe('ErrorBoundary', () => {
  let consoleError: MockInstance
  let logged: unknown[][]
  let records: Array<Record<string, unknown>>

  beforeEach(() => {
    childFails = true
    logged = []
    records = captureRendererLog()
    // React reports every caught render failure on the console itself. That output is not the
    // boundary's own diagnostic, and it is captured here only to keep it out of the test run.
    consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args)
    })
  })

  afterEach(() => {
    consoleError.mockRestore()
  })

  test('a throwing child renders the region fallback instead of blanking the tree', () => {
    render(
      <ErrorBoundary scope="region">
        <AlwaysFails />
      </ErrorBoundary>
    )

    const fallback = document.querySelector('.ix-crash--region')
    expect(fallback).toBeTruthy()
    // The variant sizes itself from whatever slot it lands in, so it must not also claim the
    // shell's own main slot: one of those nested inside another is what left the card stranded
    // unsized at the top of a settings pane.
    expect(fallback?.classList.contains('ix-main')).toBe(false)
    expect(fallback?.querySelector('.ix-crash__reason')?.textContent).toBe('boom')
  })

  test('a region crash with no recovery line offers one that holds at any mount point', () => {
    render(
      <ErrorBoundary scope="region">
        <AlwaysFails />
      </ErrorBoundary>
    )

    const card = document.querySelector('.ix-crash__card')?.textContent ?? ''
    expect(card).toContain('everything around it is still working')
    // A boundary cannot see what surrounds it. Left to itself it names no navigation at all, so
    // that a caller who passes nothing gets a line that stays true wherever it is mounted.
    expect(card).not.toContain('sidebar')
    expect(card).not.toContain('category')
  })

  test('a caller-supplied recovery line replaces the default one', () => {
    render(
      <ErrorBoundary scope="region" recovery="Pick another tab in the strip above.">
        <AlwaysFails />
      </ErrorBoundary>
    )

    const card = document.querySelector('.ix-crash__card')?.textContent ?? ''
    expect(card).toContain('Pick another tab in the strip above.')
    expect(card).not.toContain('everything around it is still working')
  })

  test('the caught error and its component stack are logged under the greppable message', () => {
    render(
      <ErrorBoundary scope="region">
        <AlwaysFails />
      </ErrorBoundary>
    )

    const entry = records.find((r) => r.msg === RENDERER_CRASH_LOG_MESSAGE)
    expect(entry).toBeTruthy()
    expect(entry?.level).toBe('error')
    const data = entry?.data as { scope: string; componentStack: string }
    expect(data.scope).toBe('region')
    expect(String(data.componentStack)).toContain('AlwaysFails')
    expect((entry?.err as { message: string }).message).toBe('boom')
  })

  test('retrying re-mounts the subtree and recovers a child that no longer throws', () => {
    render(
      <ErrorBoundary scope="region">
        <FailsUntilFixed label="recovered" />
      </ErrorBoundary>
    )
    expect(document.querySelector('.ix-crash--region')).toBeTruthy()

    childFails = false
    const retry = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Try again'
    )
    act(() => {
      retry?.click()
    })

    expect(document.querySelector('.ix-crash--region')).toBeNull()
    expect(document.querySelector('.ix-probe')?.textContent).toBe('recovered')
  })

  test('the window fallback covers the viewport and offers a reload', () => {
    render(
      <ErrorBoundary scope="window">
        <AlwaysFails />
      </ErrorBoundary>
    )

    const fallback = document.querySelector('.ix-crash--window')
    expect(fallback).toBeTruthy()
    expect(fallback?.getAttribute('role')).toBe('alertdialog')
    const labels = [...document.querySelectorAll('button')].map((b) => b.textContent)
    expect(labels).toEqual(['Reload', 'Try again'])
  })

  test('a contained failure leaves its siblings mounted', () => {
    render(
      <div>
        <div className="ix-sibling">still here</div>
        <ErrorBoundary scope="region">
          <AlwaysFails />
        </ErrorBoundary>
      </div>
    )

    expect(document.querySelector('.ix-sibling')?.textContent).toBe('still here')
    expect(document.querySelector('.ix-crash--region')).toBeTruthy()
  })

  test('a falsy throw is contained too, and the fallback drops the unusable reason', () => {
    render(
      <ErrorBoundary scope="region">
        <ThrowsNull />
      </ErrorBoundary>
    )

    expect(document.querySelector('.ix-crash--region')).toBeTruthy()
    // Nothing quotable was thrown, so the reason line is left out rather than shown empty.
    expect(document.querySelector('.ix-crash__reason')).toBeNull()
    expect(document.querySelector('.ix-crash__card h1')?.textContent).toBe(
      'This view could not render'
    )
    expect(records.find((r) => r.msg === RENDERER_CRASH_LOG_MESSAGE)).toBeTruthy()
  })

  test('a healthy subtree renders untouched and logs nothing', () => {
    render(
      <ErrorBoundary scope="region">
        <div className="ix-probe">healthy</div>
      </ErrorBoundary>
    )

    expect(document.querySelector('.ix-probe')?.textContent).toBe('healthy')
    expect(document.querySelector('.ix-crash')).toBeNull()
    expect(records).toEqual([])
    expect(logged).toEqual([])
  })
})
