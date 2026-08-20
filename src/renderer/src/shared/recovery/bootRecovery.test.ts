import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  clearUnrecoveredCrash,
  consumeSafeModeRequest,
  consumeViewStateReset,
  markUnrecoveredCrash,
  noteViewStateReset,
  readUnrecoveredCrash,
  requestSafeMode
} from './bootRecovery'

describe('the crash marker', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  test('a profile that has never crashed reports nothing', () => {
    expect(readUnrecoveredCrash()).toBeNull()
  })

  test('a recorded crash survives to be read back with the moment it happened', () => {
    markUnrecoveredCrash(1_700_000_000_000)
    expect(readUnrecoveredCrash()).toEqual({ at: 1_700_000_000_000 })
  })

  test('clearing withdraws it, which is what a tree that stayed alive has earned', () => {
    markUnrecoveredCrash(1)
    clearUnrecoveredCrash()
    expect(readUnrecoveredCrash()).toBeNull()
  })

  test('a value that is not a crash record reads as no crash at all', () => {
    for (const junk of ['', 'not json', '[]', 'null', '{}', '{"at":"soon"}', '{"at":null}']) {
      window.localStorage.setItem('intersect.recovery.unrecoveredCrash', junk)
      expect(readUnrecoveredCrash()).toBeNull()
    }
  })
})

describe('storage that throws', () => {
  let getItem: typeof window.localStorage.getItem
  let setItem: typeof window.localStorage.setItem
  let removeItem: typeof window.localStorage.removeItem

  beforeEach(() => {
    getItem = window.localStorage.getItem
    setItem = window.localStorage.setItem
    removeItem = window.localStorage.removeItem
    const boom = (): never => {
      throw new Error('SecurityError: storage is unavailable')
    }
    window.localStorage.getItem = boom
    window.localStorage.setItem = boom
    window.localStorage.removeItem = boom
  })

  afterEach(() => {
    window.localStorage.getItem = getItem
    window.localStorage.setItem = setItem
    window.localStorage.removeItem = removeItem
  })

  /**
   * Every one of these runs inside the crash fallback's own render or inside componentDidCatch.
   * A throw from here would take away the last surface the user has, so a broken store has to
   * degrade to "nothing was recorded" rather than propagate.
   */
  test('every access degrades instead of throwing', () => {
    expect(() => markUnrecoveredCrash(1)).not.toThrow()
    expect(() => clearUnrecoveredCrash()).not.toThrow()
    expect(() => requestSafeMode()).not.toThrow()
    expect(() => noteViewStateReset()).not.toThrow()
    expect(readUnrecoveredCrash()).toBeNull()
    expect(consumeSafeModeRequest()).toBe(false)
    expect(consumeViewStateReset()).toBe(false)
  })
})

describe('the one-shot boot flags', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  test('safe mode is off unless it was asked for', () => {
    expect(consumeSafeModeRequest()).toBe(false)
  })

  test('a safe-mode request applies to exactly one boot', () => {
    requestSafeMode()
    expect(consumeSafeModeRequest()).toBe(true)
    // A flag that stuck would leave the user in a crippled app with no memory of asking for it.
    expect(consumeSafeModeRequest()).toBe(false)
  })

  test('the reset note applies to exactly one boot', () => {
    noteViewStateReset()
    expect(consumeViewStateReset()).toBe(true)
    expect(consumeViewStateReset()).toBe(false)
  })

  test('the two flags do not read each other', () => {
    requestSafeMode()
    expect(consumeViewStateReset()).toBe(false)
    expect(consumeSafeModeRequest()).toBe(true)
  })
})

describe('the marker across a relaunch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  test('it is read from storage on every call, so a fresh process still sees it', async () => {
    window.localStorage.clear()
    markUnrecoveredCrash(42)
    // A module re-evaluated from scratch is what a relaunch produces; the recorded crash has to
    // outlive it, because that is the whole evidence the escalation rests on.
    vi.resetModules()
    const fresh = await import('./bootRecovery')
    expect(fresh.readUnrecoveredCrash()).toEqual({ at: 42 })
  })
})
