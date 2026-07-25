import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest'
import { ErrorBoundary, RENDERER_CRASH_LOG_PREFIX } from './ErrorBoundary'

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

  beforeEach(() => {
    childFails = true
    logged = []
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
    // It keeps the shell's main slot so the surrounding layout is unaffected.
    expect(fallback?.classList.contains('ix-main')).toBe(true)
    expect(fallback?.querySelector('.ix-crash__reason')?.textContent).toBe('boom')
  })

  test('the caught error and its component stack are logged under the greppable prefix', () => {
    render(
      <ErrorBoundary scope="region">
        <AlwaysFails />
      </ErrorBoundary>
    )

    const entry = logged.find(
      (args) => typeof args[0] === 'string' && args[0].startsWith(RENDERER_CRASH_LOG_PREFIX)
    )
    expect(entry).toBeTruthy()
    expect(entry?.[0]).toContain('(region)')
    expect(entry?.[0]).toContain('boom')
    expect(entry?.[1]).toBeInstanceOf(Error)
    expect(String(entry?.[2])).toContain('AlwaysFails')
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
    const entry = logged.find(
      (args) => typeof args[0] === 'string' && args[0].startsWith(RENDERER_CRASH_LOG_PREFIX)
    )
    expect(entry).toBeTruthy()
  })

  test('a healthy subtree renders untouched and logs nothing', () => {
    render(
      <ErrorBoundary scope="region">
        <div className="ix-probe">healthy</div>
      </ErrorBoundary>
    )

    expect(document.querySelector('.ix-probe')?.textContent).toBe('healthy')
    expect(document.querySelector('.ix-crash')).toBeNull()
    expect(logged).toEqual([])
  })
})
