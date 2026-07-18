import { describe, expect, test } from 'vitest'
import { issueKeyFromBranch } from './issueKey'

describe('issueKeyFromBranch', () => {
  test('extracts an uppercase key from a plain branch', () => {
    expect(issueKeyFromBranch('FID2507-611')).toBe('FID2507-611')
  })

  test('normalizes a lowercase key inside a feature branch to uppercase', () => {
    expect(issueKeyFromBranch('feature/fid2507-611-lock-owner')).toBe('FID2507-611')
  })

  test('matches mixed case and a prefix path', () => {
    expect(issueKeyFromBranch('bugfix/Spot-42')).toBe('SPOT-42')
  })

  test('takes the first key when several appear', () => {
    expect(issueKeyFromBranch('fid2507-611-and-fid2507-612')).toBe('FID2507-611')
  })

  test('a branch without a key yields null', () => {
    expect(issueKeyFromBranch('feature/time-tracking')).toBeNull()
    expect(issueKeyFromBranch('main')).toBeNull()
  })

  test('a single-letter project prefix does not qualify', () => {
    expect(issueKeyFromBranch('a-123')).toBeNull()
  })

  test('the key needs digits after the dash', () => {
    expect(issueKeyFromBranch('feature/widget-factory')).toBeNull()
  })

  test('a null branch yields null', () => {
    expect(issueKeyFromBranch(null)).toBeNull()
  })

  test('an empty branch yields null', () => {
    expect(issueKeyFromBranch('')).toBeNull()
  })
})
