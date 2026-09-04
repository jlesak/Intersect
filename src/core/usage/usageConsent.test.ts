import { describe, expect, it, vi } from 'vitest'
import { createUsageConsentStore, parseConsent, USAGE_LIVE_CONSENT_KEY } from './usageConsent'

describe('parseConsent', () => {
  it('reads back every answer it can store', () => {
    expect(parseConsent('granted')).toBe('granted')
    expect(parseConsent('declined')).toBe('declined')
    expect(parseConsent('unasked')).toBe('unasked')
  })

  it('treats an absent answer as unasked, so a fresh install gets the question', () => {
    expect(parseConsent(null)).toBe('unasked')
  })

  it('treats an unrecognized answer as unasked rather than as consent', () => {
    expect(parseConsent('yes')).toBe('unasked')
    expect(parseConsent('')).toBe('unasked')
    expect(parseConsent('GRANTED')).toBe('unasked')
  })
})

describe('createUsageConsentStore', () => {
  function fakeAppState(initial: string | null = null) {
    const rows = new Map<string, string | null>()
    if (initial !== null) rows.set(USAGE_LIVE_CONSENT_KEY, initial)
    return {
      get: vi.fn((key: string) => rows.get(key) ?? null),
      set: vi.fn((key: string, value: string | null) => void rows.set(key, value)),
      rows
    }
  }

  it('reads the answer off its own app_state key', () => {
    const appState = fakeAppState('granted')
    expect(createUsageConsentStore(appState).get()).toBe('granted')
    expect(appState.get).toHaveBeenCalledWith(USAGE_LIVE_CONSENT_KEY)
  })

  it('persists an answer under that key and reads it back', () => {
    const appState = fakeAppState()
    const store = createUsageConsentStore(appState)

    store.set('declined')

    expect(appState.set).toHaveBeenCalledWith(USAGE_LIVE_CONSENT_KEY, 'declined')
    expect(store.get()).toBe('declined')
  })

  it('reports unasked when nothing has been persisted yet', () => {
    expect(createUsageConsentStore(fakeAppState()).get()).toBe('unasked')
  })
})
