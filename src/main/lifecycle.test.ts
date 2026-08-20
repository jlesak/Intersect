import { describe, expect, test } from 'vitest'
import {
  activateAction,
  createUnattendedShutdown,
  isUserPresenceInput,
  quitDecision,
  shouldConfirmQuit,
  shouldQuitOnWindowAllClosed,
  shouldZeroDockBadge
} from './lifecycle'

describe('shouldQuitOnWindowAllClosed', () => {
  test('on macOS, closing the last window keeps the app (and core/PTYs) alive', () => {
    expect(shouldQuitOnWindowAllClosed({ platform: 'darwin', quitting: false })).toBe(false)
  })

  test('on macOS, a close racing an in-progress quit still quits', () => {
    expect(shouldQuitOnWindowAllClosed({ platform: 'darwin', quitting: true })).toBe(true)
  })

  test('on other platforms, closing the last window quits', () => {
    expect(shouldQuitOnWindowAllClosed({ platform: 'win32', quitting: false })).toBe(true)
    expect(shouldQuitOnWindowAllClosed({ platform: 'linux', quitting: false })).toBe(true)
  })
})

describe('activateAction', () => {
  test('focuses the live window when one exists', () => {
    expect(activateAction({ hasLiveWindow: true, quitting: false })).toBe('focus')
  })

  test('creates exactly one window when none exists', () => {
    expect(activateAction({ hasLiveWindow: false, quitting: false })).toBe('create')
  })

  test('never creates windows while the app is quitting', () => {
    expect(activateAction({ hasLiveWindow: false, quitting: true })).toBe('none')
    expect(activateAction({ hasLiveWindow: true, quitting: true })).toBe('none')
  })
})

describe('shouldConfirmQuit', () => {
  test('asks when live sessions exist and somebody is there to answer', () => {
    expect(shouldConfirmQuit({ liveCount: 1, unattended: false })).toBe(true)
    expect(shouldConfirmQuit({ liveCount: 7, unattended: false })).toBe(true)
  })

  test('an unattended shutdown proceeds to the suspend teardown without asking', () => {
    expect(shouldConfirmQuit({ liveCount: 1, unattended: true })).toBe(false)
    expect(shouldConfirmQuit({ liveCount: 7, unattended: true })).toBe(false)
  })

  test('with no live sessions there is nothing to confirm, attended or not', () => {
    expect(shouldConfirmQuit({ liveCount: 0, unattended: false })).toBe(false)
    expect(shouldConfirmQuit({ liveCount: 0, unattended: true })).toBe(false)
  })
})

describe('quitDecision', () => {
  test('with no live sessions the quit proceeds without a dialog', () => {
    expect(quitDecision(0, null)).toBe('quit')
  })

  test('Suspend & Quit (response 0) proceeds to teardown', () => {
    expect(quitDecision(2, 0)).toBe('quit')
  })

  test('Cancel (response 1) leaves the app and every session untouched', () => {
    expect(quitDecision(2, 1)).toBe('stay')
  })

  test('a dismissed dialog (any non-zero response) is treated as cancel', () => {
    expect(quitDecision(1, -1)).toBe('stay')
    expect(quitDecision(1, null)).toBe('stay')
  })
})

describe('shouldZeroDockBadge', () => {
  test('zeroes the badge the moment the core leaves ready', () => {
    expect(shouldZeroDockBadge({ state: 'restarting', message: 'x', attempt: 1 })).toBe(true)
    expect(shouldZeroDockBadge({ state: 'failed', message: 'x' })).toBe(true)
  })

  test('leaves the canonical badge alone in the healthy states', () => {
    expect(shouldZeroDockBadge({ state: 'starting' })).toBe(false)
    expect(shouldZeroDockBadge({ state: 'ready' })).toBe(false)
  })
})

describe('createUnattendedShutdown', () => {
  test('a fresh app has no shutdown in flight', () => {
    expect(createUnattendedShutdown().isUnattended()).toBe(false)
  })

  test('the power-off signal raises the claim for the quit that follows', () => {
    const shutdown = createUnattendedShutdown()
    shutdown.arm()
    expect(shutdown.isUnattended()).toBe(true)
  })

  test('evidence of a person withdraws a claim the shutdown never came back for', () => {
    const shutdown = createUnattendedShutdown()
    shutdown.arm()
    shutdown.disarm()
    expect(shutdown.isUnattended()).toBe(false)
  })

  test('disarm reports the transition, so a present user is logged once', () => {
    const shutdown = createUnattendedShutdown()
    expect(shutdown.disarm()).toBe(false)
    shutdown.arm()
    expect(shutdown.disarm()).toBe(true)
    expect(shutdown.disarm()).toBe(false)
  })

  test('a second power-off raises the claim again', () => {
    const shutdown = createUnattendedShutdown()
    shutdown.arm()
    shutdown.disarm()
    shutdown.arm()
    expect(shutdown.isUnattended()).toBe(true)
  })
})

describe('isUserPresenceInput', () => {
  test('a key or button going down takes a hand', () => {
    expect(isUserPresenceInput('keyDown')).toBe(true)
    expect(isUserPresenceInput('rawKeyDown')).toBe(true)
    expect(isUserPresenceInput('char')).toBe(true)
    expect(isUserPresenceInput('mouseDown')).toBe(true)
  })

  test('pointer traffic proves nothing, because closing windows produce it on their own', () => {
    expect(isUserPresenceInput('mouseMove')).toBe(false)
    expect(isUserPresenceInput('mouseEnter')).toBe(false)
    expect(isUserPresenceInput('mouseLeave')).toBe(false)
  })

  test('the tail of an interaction says nothing the press did not already say', () => {
    expect(isUserPresenceInput('keyUp')).toBe(false)
    expect(isUserPresenceInput('mouseUp')).toBe(false)
    expect(isUserPresenceInput('undefined')).toBe(false)
  })
})
