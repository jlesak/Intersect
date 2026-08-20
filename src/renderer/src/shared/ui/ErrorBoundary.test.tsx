import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest'
import { captureRendererLog } from '../logging/testLog'
import {
  markUnrecoveredCrash,
  readUnrecoveredCrash,
  reloadWindow
} from '../recovery/bootRecovery'
import { ErrorBoundary, RENDERER_CRASH_LOG_MESSAGE } from './ErrorBoundary'

// The one thing a test cannot let run for real: a reload throws the document away. Everything
// else in the recovery module stays real, so the assertions below are about the bytes the escapes
// actually leave behind rather than about a mock of them.
vi.mock('../recovery/bootRecovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../recovery/bootRecovery')>()),
  reloadWindow: vi.fn()
}))

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
    window.localStorage.clear()
    vi.mocked(reloadWindow).mockClear()
    records = captureRendererLog()
    // React reports every caught render failure on the console itself. That output is not the
    // boundary's own diagnostic, and it is captured here only to keep it out of the test run.
    consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args)
    })
  })

  afterEach(() => {
    consoleError.mockRestore()
    delete (window as { intersect?: unknown }).intersect
    window.localStorage.clear()
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

/** Every button on screen, in DOM order - the order is the offer's ordering. */
function buttonLabels(): string[] {
  return [...document.querySelectorAll('button')].map((b) => b.textContent ?? '')
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent === label)
  if (!found) throw new Error(`no button labelled "${label}" (have: ${buttonLabels().join(', ')})`)
  return found as HTMLButtonElement
}

function click(label: string): void {
  act(() => {
    button(label).click()
  })
}

async function clickAsync(label: string): Promise<void> {
  await act(async () => {
    button(label).click()
  })
}

/** The system surface the two IPC-backed escapes reach for, on top of whatever else is bridged. */
function stubSystemIpc(
  overrides: Partial<{ resetViewState: () => Promise<void>; revealUserData: () => Promise<void> }> = {}
): { resetViewState: ReturnType<typeof vi.fn>; revealUserData: ReturnType<typeof vi.fn> } {
  const resetViewState = vi.fn(overrides.resetViewState ?? (async () => {}))
  const revealUserData = vi.fn(overrides.revealUserData ?? (async () => {}))
  const host = window as unknown as { intersect?: Record<string, unknown> }
  host.intersect = { ...host.intersect, system: { resetViewState, revealUserData } }
  return { resetViewState, revealUserData }
}

/**
 * The escalation, which is the whole point of the marker: a first crash still gets the honest but
 * dead-end offer, and a crash with no successful render behind it gets ways out.
 */
describe('a window crash that has already happened once', () => {
  let consoleError: MockInstance
  let records: Array<Record<string, unknown>>

  beforeEach(() => {
    window.localStorage.clear()
    vi.mocked(reloadWindow).mockClear()
    records = captureRendererLog()
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleError.mockRestore()
    delete (window as { intersect?: unknown }).intersect
    window.localStorage.clear()
  })

  test('the first crash offers nothing beyond reloading, and says so', () => {
    render(
      <ErrorBoundary scope="window">
        <AlwaysFails />
      </ErrorBoundary>
    )

    expect(buttonLabels()).toEqual(['Reload', 'Try again'])
    expect(document.querySelector('.ix-crash__escapes')).toBeNull()
  })

  test('a window crash records itself so the next one can be recognised as a repeat', () => {
    render(
      <ErrorBoundary scope="window">
        <AlwaysFails />
      </ErrorBoundary>
    )

    expect(readUnrecoveredCrash()).not.toBeNull()
  })

  test('a contained region crash records nothing, because the window did render', () => {
    render(
      <ErrorBoundary scope="region">
        <AlwaysFails />
      </ErrorBoundary>
    )

    expect(readUnrecoveredCrash()).toBeNull()
    expect(document.querySelector('.ix-crash__escapes')).toBeNull()
  })

  test('recording this crash does not escalate the card that is already on screen', () => {
    const { rerender } = render(
      <ErrorBoundary scope="window">
        <AlwaysFails />
      </ErrorBoundary>
    )
    // The boundary writes the marker after the fallback has rendered. A card that read storage
    // while rendering would find its own evidence on the next paint and call a first crash a repeat.
    expect(readUnrecoveredCrash()).not.toBeNull()
    rerender(
      <ErrorBoundary scope="window">
        <AlwaysFails />
      </ErrorBoundary>
    )

    expect(document.querySelector('.ix-crash__escapes')).toBeNull()
    expect(buttonLabels()).toEqual(['Reload', 'Try again'])
  })

  test('a repeat offers the ways out, least destructive first, with reload still in front', () => {
    markUnrecoveredCrash(Date.now())
    render(
      <ErrorBoundary scope="window">
        <AlwaysFails />
      </ErrorBoundary>
    )

    expect(buttonLabels()).toEqual([
      'Reload',
      'Try again',
      'Start in safe mode',
      'Reset view and layout state',
      'Reveal data folder'
    ])
    const card = document.querySelector('.ix-crash__card')?.textContent ?? ''
    // The claim is exactly what the marker proves, and nothing about frequency or a loop. It
    // speaks of ordinary launches because a safe-mode session in between keeps the marker.
    expect(card).toContain('no ordinary launch has stayed up since')
    expect(card).toContain('Intersect could not render')
  })

  test('the repeat is named in the log record, where a boot-deterministic crash is diagnosed', () => {
    markUnrecoveredCrash(Date.now())
    render(
      <ErrorBoundary scope="window">
        <AlwaysFails />
      </ErrorBoundary>
    )

    const entry = records.find((r) => r.msg === RENDERER_CRASH_LOG_MESSAGE)
    expect((entry?.data as { repeat: boolean }).repeat).toBe(true)
  })

  test('safe mode asks the next boot to skip the restore and reloads, touching no IPC', () => {
    markUnrecoveredCrash(Date.now())
    const { resetViewState, revealUserData } = stubSystemIpc()
    render(
      <ErrorBoundary scope="window">
        <AlwaysFails />
      </ErrorBoundary>
    )

    click('Start in safe mode')

    expect(window.localStorage.getItem('intersect.recovery.safeModeRequest')).toBe('1')
    expect(reloadWindow).toHaveBeenCalledOnce()
    expect(resetViewState).not.toHaveBeenCalled()
    expect(revealUserData).not.toHaveBeenCalled()
  })

  test('the reset never runs on the button alone: the confirmation states what goes and what stays', () => {
    markUnrecoveredCrash(Date.now())
    const { resetViewState } = stubSystemIpc()
    render(
      <ErrorBoundary scope="window">
        <AlwaysFails />
      </ErrorBoundary>
    )

    click('Reset view and layout state')

    // The window fallback covers the viewport, so a confirmation on the default stacking would
    // open behind the card that asked for it and the user would face a dead, dimmed screen.
    expect(document.querySelector('.ix-overlay')?.className).toContain('ix-overlay--topmost')
    const dialog = document.querySelector('.ix-dialog')?.textContent ?? ''
    expect(dialog).toContain('Cleared, permanently')
    expect(dialog).toContain('pane layout')
    expect(dialog).toContain('Kept')
    expect(dialog).toContain('every tab and every terminal')
    expect(resetViewState).not.toHaveBeenCalled()
    expect(reloadWindow).not.toHaveBeenCalled()
  })

  test('cancelling the confirmation changes nothing at all', () => {
    markUnrecoveredCrash(Date.now())
    const { resetViewState } = stubSystemIpc()
    render(
      <ErrorBoundary scope="window">
        <AlwaysFails />
      </ErrorBoundary>
    )

    click('Reset view and layout state')
    click('Cancel')

    expect(document.querySelector('.ix-dialog')).toBeNull()
    expect(resetViewState).not.toHaveBeenCalled()
    expect(reloadWindow).not.toHaveBeenCalled()
    expect(window.localStorage.getItem('intersect.recovery.viewStateReset')).toBeNull()
  })

  test('a confirmed reset clears the state, notes it for the next boot, and reloads', async () => {
    markUnrecoveredCrash(Date.now())
    const { resetViewState } = stubSystemIpc()
    render(
      <ErrorBoundary scope="window">
        <AlwaysFails />
      </ErrorBoundary>
    )

    click('Reset view and layout state')
    await clickAsync('Reset and reload')

    expect(resetViewState).toHaveBeenCalledOnce()
    // The note is what lets the fresh boot say the reset happened rather than leaving the user to
    // guess whether this launch simply worked.
    expect(window.localStorage.getItem('intersect.recovery.viewStateReset')).toBe('1')
    expect(reloadWindow).toHaveBeenCalledOnce()
    // The marker survives: if the reset did not cure it, the very next crash is still a repeat.
    expect(readUnrecoveredCrash()).not.toBeNull()
  })

  test('a reset the core refuses says so and leaves every other way out usable', async () => {
    markUnrecoveredCrash(Date.now())
    stubSystemIpc({
      resetViewState: async () => {
        throw new Error('core is not available')
      }
    })
    render(
      <ErrorBoundary scope="window">
        <AlwaysFails />
      </ErrorBoundary>
    )

    click('Reset view and layout state')
    await clickAsync('Reset and reload')

    expect(document.querySelector('.ix-crash__card')?.textContent).toContain('core is not available')
    expect(reloadWindow).not.toHaveBeenCalled()
    expect(window.localStorage.getItem('intersect.recovery.viewStateReset')).toBeNull()
    // The card is still the last surface the user has, and it still holds every option.
    expect(button('Start in safe mode').disabled).toBe(false)
    expect(button('Reload')).toBeTruthy()
  })

  test('revealing the profile directory asks main for it and stays on the card', async () => {
    markUnrecoveredCrash(Date.now())
    const { revealUserData } = stubSystemIpc()
    render(
      <ErrorBoundary scope="window">
        <AlwaysFails />
      </ErrorBoundary>
    )

    await clickAsync('Reveal data folder')

    expect(revealUserData).toHaveBeenCalledOnce()
    expect(reloadWindow).not.toHaveBeenCalled()
    expect(document.querySelector('.ix-crash--window')).toBeTruthy()
  })

  test('with no preload bridge the IPC escapes are refused up front and safe mode still works', () => {
    markUnrecoveredCrash(Date.now())
    // Nothing attached at all: `ipc()` throws on call, so the card must decide without calling it.
    delete (window as { intersect?: unknown }).intersect
    render(
      <ErrorBoundary scope="window">
        <AlwaysFails />
      </ErrorBoundary>
    )

    expect(button('Reset view and layout state').disabled).toBe(true)
    expect(button('Reveal data folder').disabled).toBe(true)
    expect(button('Start in safe mode').disabled).toBe(false)
    expect(document.querySelector('.ix-crash__card')?.textContent).toContain(
      'Safe mode still works'
    )

    click('Start in safe mode')
    expect(window.localStorage.getItem('intersect.recovery.safeModeRequest')).toBe('1')
    expect(reloadWindow).toHaveBeenCalledOnce()
  })

  test('a repeat crash in a region stays contained and offers no escapes', () => {
    markUnrecoveredCrash(Date.now())
    render(
      <ErrorBoundary scope="region">
        <AlwaysFails />
      </ErrorBoundary>
    )

    expect(document.querySelector('.ix-crash--region')).toBeTruthy()
    expect(document.querySelector('.ix-crash__escapes')).toBeNull()
    expect(buttonLabels()).toEqual(['Try again'])
  })
})
