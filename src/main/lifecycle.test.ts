import { describe, expect, test } from 'vitest'
import { activateAction, shouldQuitOnWindowAllClosed, shouldZeroDockBadge } from './lifecycle'

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
