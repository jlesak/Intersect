import { describe, expect, test } from 'vitest'
import { parseJiraReport } from './jiraReport'

describe('parseJiraReport', () => {
  test('parses a well-formed success line', () => {
    const p = parseJiraReport(
      JSON.stringify({
        sessionId: 's1',
        ok: true,
        issues: [
          {
            key: 'FID2507-611',
            summary: 'Do the thing',
            status: 'In Progress',
            priority: 'High',
            updated: '2026-07-01T08:00:00Z'
          }
        ]
      })
    )
    expect(p.sessionId).toBe('s1')
    expect(p.ok).toBe(true)
    expect(p.issues).toEqual([
      {
        key: 'FID2507-611',
        summary: 'Do the thing',
        status: 'In Progress',
        priority: 'High',
        updated: '2026-07-01T08:00:00Z'
      }
    ])
  })

  test('parses a failure line and keeps the auth kind', () => {
    const p = parseJiraReport(
      JSON.stringify({ sessionId: 's1', ok: false, error: 'auth', message: 'Session expired' })
    )
    expect(p.ok).toBe(false)
    expect(p.kind).toBe('auth')
    expect(p.message).toBe('Session expired')
    expect(p.issues).toEqual([])
  })

  test('coerces an unknown error kind to other', () => {
    const p = parseJiraReport(JSON.stringify({ sessionId: 's1', ok: false, error: 'weird' }))
    expect(p.kind).toBe('other')
  })

  test('a missing priority becomes null; other fields are coerced to strings', () => {
    const p = parseJiraReport(
      JSON.stringify({ sessionId: 's1', ok: true, issues: [{ key: 7, summary: null, status: 'X' }] })
    )
    expect(p.issues[0]).toEqual({ key: '7', summary: '', status: 'X', priority: null, updated: '' })
  })

  test('non-array issues and non-object entries are dropped', () => {
    expect(parseJiraReport(JSON.stringify({ ok: true, issues: 'nope' })).issues).toEqual([])
    expect(parseJiraReport(JSON.stringify({ ok: true, issues: ['nope', 42] })).issues).toEqual([])
  })

  test('ok must be a literal true', () => {
    expect(parseJiraReport(JSON.stringify({ ok: 'true' })).ok).toBe(false)
  })

  test('throws on malformed json', () => {
    expect(() => parseJiraReport('{not json')).toThrow()
  })
})
