import { describe, expect, test } from 'vitest'
import { issueKeyFromBranch } from './issueKey'

describe('issueKeyFromBranch', () => {
  test('extracts an uppercase key from a plain branch', () => {
    expect(issueKeyFromBranch('PROJ9-611')).toBe('PROJ9-611')
  })

  test('normalizes a lowercase key inside a feature branch to uppercase', () => {
    expect(issueKeyFromBranch('feature/proj9-611-lock-owner')).toBe('PROJ9-611')
  })

  test('matches mixed case and a prefix path', () => {
    expect(issueKeyFromBranch('bugfix/Proj-42')).toBe('PROJ-42')
  })

  test('takes the first key when several appear', () => {
    expect(issueKeyFromBranch('proj9-611-and-proj9-612')).toBe('PROJ9-611')
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
