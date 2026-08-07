import { describe, expect, test } from 'vitest'
import type { AdoFallback, AdoSettings } from './domain'
import { hasAdoConnection } from './ado'

const blank: AdoSettings = { orgUrl: '', project: '', repository: '', pat: '' }
const noFallback: AdoFallback = { orgUrl: '', project: '', hasPat: false }

describe('hasAdoConnection', () => {
  test('an org URL and a token the user saved are a connection', () => {
    expect(hasAdoConnection({ ...blank, orgUrl: 'https://ado', pat: 't' }, noFallback)).toBe(true)
  })

  test('an org URL and a token from the fallback alone are a connection', () => {
    expect(hasAdoConnection(blank, { orgUrl: 'https://ado', project: 'SPOT', hasPat: true })).toBe(
      true
    )
  })

  test('a blank saved field defers to the fallback rather than overriding it', () => {
    const orgUrlFallback: AdoFallback = { orgUrl: 'https://ado', project: '', hasPat: false }
    const patFallback: AdoFallback = { orgUrl: '', project: '', hasPat: true }
    expect(hasAdoConnection({ ...blank, pat: 't' }, orgUrlFallback)).toBe(true)
    expect(hasAdoConnection({ ...blank, orgUrl: 'https://ado' }, patFallback)).toBe(true)
  })

  test('either half missing is no connection', () => {
    expect(hasAdoConnection(blank, noFallback)).toBe(false)
    expect(hasAdoConnection({ ...blank, orgUrl: 'https://ado' }, noFallback)).toBe(false)
    expect(hasAdoConnection({ ...blank, pat: 't' }, noFallback)).toBe(false)
  })

  test('whitespace is not a value', () => {
    // The core trims before deciding the same thing, so a form holding only spaces is not a
    // connection here either.
    expect(hasAdoConnection({ ...blank, orgUrl: '  ', pat: '  ' }, noFallback)).toBe(false)
    const blankishFallback: AdoFallback = { orgUrl: '  ', project: '', hasPat: false }
    expect(hasAdoConnection({ ...blank, pat: 't' }, blankishFallback)).toBe(false)
  })
})
