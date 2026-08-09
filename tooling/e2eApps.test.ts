import { describe, expect, test } from 'vitest'
import {
  closeApps,
  closeRegisteredApps,
  hasExited,
  registerApp,
  type CloseableApp,
  type LaunchedApp
} from './e2eApps'

/**
 * The drain is the last thing that runs after a test the suite has already given up on, so every
 * case here is a way the app under it can be uncooperative: gone before it is reached, refusing to
 * close, closing without dying, or refusing to die at all. What the drain must never do in any of
 * them is throw, because a teardown that throws turns a passing test red for a reason that has
 * nothing to do with what it asserted.
 *
 * Timeouts arrive as parameters so the cases can be stated in milliseconds instead of waiting out
 * the real budget - the same reason `checkBundleFreshness` takes its repository root.
 */

const IMMEDIATE = { closeMs: 5, exitMs: 5 }

interface FakeApp {
  app: CloseableApp
  /** The pair the drain works on, as the register would have taken it at launch. */
  launched: LaunchedApp
  /** How many times the drain asked this app to close. */
  closeCalls: () => number
  /** The signals the drain sent to the process. */
  signalsSent: () => string[]
  /** Do to this app what a spec that closes its own does: the process goes, and so does the name. */
  closeItAsItsSpecWould: () => void
}

/**
 * A stand-in for a launched app.
 *
 * `close` says how the Playwright call behaves, and `exitsOnClose` whether the operating-system
 * process goes away when it does - the two are deliberately separable, because an app whose close
 * resolves while its process lives on is precisely the case a drain that trusted `close()` alone
 * would miss.
 */
function fakeApp(
  options: {
    close?: 'resolves' | 'rejects' | 'hangs'
    exitsOnClose?: boolean
    diesWhenKilled?: boolean
    exited?: 'no' | 'code' | 'signal'
  } = {}
): FakeApp {
  const { close = 'resolves', exitsOnClose = true, diesWhenKilled = true, exited = 'no' } = options

  const exitListeners: Array<() => void> = []
  const signalsSent: string[] = []
  let closeCalls = 0
  let namesItsProcess = true

  const announceExit = (): void => {
    while (exitListeners.length > 0) exitListeners.pop()?.()
  }

  const proc = {
    exitCode: exited === 'code' ? 0 : null,
    signalCode: exited === 'signal' ? 'SIGKILL' : null,
    kill(signal: 'SIGKILL'): void {
      signalsSent.push(signal)
      if (!diesWhenKilled) return
      proc.signalCode = signal
      announceExit()
    },
    once(_event: 'exit', listener: () => void): unknown {
      exitListeners.push(listener)
      return proc
    }
  }

  const app: CloseableApp = {
    async close(): Promise<void> {
      closeCalls += 1
      if (close === 'hangs') return new Promise<void>(() => {})
      if (close === 'rejects') throw new Error('the connection was already gone')
      if (!exitsOnClose) return
      proc.exitCode = 0
      announceExit()
    },
    process: () => {
      if (!namesItsProcess) throw new TypeError('the app no longer has a process to name')
      return proc
    }
  }

  return {
    app,
    launched: { app, proc },
    closeCalls: () => closeCalls,
    signalsSent: () => signalsSent,
    closeItAsItsSpecWould: () => {
      proc.exitCode = 0
      announceExit()
      namesItsProcess = false
    }
  }
}

describe('hasExited', () => {
  test('a process terminated by a signal counts as gone', () => {
    // A child killed by a signal keeps `exitCode === null` for the rest of its life, so an exit
    // check that reads only the code never sees the one departure the drain itself caused.
    expect(hasExited({ exitCode: null, signalCode: 'SIGKILL' })).toBe(true)
    expect(hasExited({ exitCode: 0, signalCode: null })).toBe(true)
    expect(hasExited({ exitCode: null, signalCode: null })).toBe(false)
  })
})

describe('closeApps', () => {
  test('closes every app it was handed', async () => {
    const first = fakeApp()
    const second = fakeApp()

    await closeApps([first.launched, second.launched], IMMEDIATE)

    expect(first.closeCalls()).toBe(1)
    expect(second.closeCalls()).toBe(1)
    expect(first.signalsSent()).toEqual([])
    expect(second.signalsSent()).toEqual([])
  })

  test('leaves an app that has already gone alone', async () => {
    const byCode = fakeApp({ exited: 'code' })
    const bySignal = fakeApp({ exited: 'signal' })

    await closeApps([byCode.launched, bySignal.launched], IMMEDIATE)

    expect(byCode.closeCalls()).toBe(0)
    expect(bySignal.closeCalls()).toBe(0)
  })

  test('a close that throws stops neither the kill that follows it nor the next app', async () => {
    const refuses = fakeApp({ close: 'rejects' })
    const healthy = fakeApp()

    await closeApps([refuses.launched, healthy.launched], IMMEDIATE)

    expect(refuses.signalsSent()).toEqual(['SIGKILL'])
    expect(healthy.closeCalls()).toBe(1)
  })

  test('a close that never returns is killed', async () => {
    const wedged = fakeApp({ close: 'hangs' })

    await closeApps([wedged.launched], IMMEDIATE)

    expect(wedged.signalsSent()).toEqual(['SIGKILL'])
  })

  test('a close that resolves while the process lives on is killed', async () => {
    // The profile directory is removed the moment the drain returns, so a still-running process is
    // still holding the very directory about to be deleted.
    const lingering = fakeApp({ exitsOnClose: false })

    await closeApps([lingering.launched], IMMEDIATE)

    expect(lingering.signalsSent()).toEqual(['SIGKILL'])
  })

  test('a process that survives being killed does not fail the drain', async () => {
    const immortal = fakeApp({ exitsOnClose: false, diesWhenKilled: false })
    const healthy = fakeApp()

    await expect(closeApps([immortal.launched, healthy.launched], IMMEDIATE)).resolves.toBeUndefined()

    expect(healthy.closeCalls()).toBe(1)
  })
})

describe('closeRegisteredApps', () => {
  test('closes what was registered and forgets it, so a second drain finds nothing', async () => {
    const first = fakeApp()
    const second = fakeApp()
    registerApp(first.app)
    registerApp(second.app)

    await closeRegisteredApps(IMMEDIATE)
    expect(first.closeCalls()).toBe(1)
    expect(second.closeCalls()).toBe(1)

    await closeRegisteredApps(IMMEDIATE)
    expect(first.closeCalls()).toBe(1)
    expect(second.closeCalls()).toBe(1)
  })

  test('an app its own spec closed is left alone, without being asked to name its process', async () => {
    // A closed app answers nothing about itself, so a drain that waited until teardown to ask which
    // process it had would throw over every spec that still closes its own - and a teardown that
    // throws fails a test that had already passed.
    const closedByItsSpec = fakeApp()
    registerApp(closedByItsSpec.app)
    closedByItsSpec.closeItAsItsSpecWould()

    await expect(closeRegisteredApps(IMMEDIATE)).resolves.toBeUndefined()

    expect(closedByItsSpec.closeCalls()).toBe(0)
  })
})
