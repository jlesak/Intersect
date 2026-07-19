import { describe, expect, test } from 'vitest'
import { createHookEventRepo } from './hookEventRepo'
import { makeTestDb, makeTestDeps } from './testkit'

describe('hookEventRepo', () => {
  test('append stores the payload verbatim with timestamp and instance id', () => {
    const repo = createHookEventRepo(makeTestDb(), makeTestDeps())
    repo.append('ws1:tab1', 'SessionStart', { session_id: 'uuid-1', cwd: '/repo' })

    const rows = repo.listBySession('ws1:tab1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      sessionId: 'ws1:tab1',
      eventName: 'SessionStart',
      payload: { session_id: 'uuid-1', cwd: '/repo' },
      receivedAt: 1001
    })
  })

  test('listBySession returns only that session, in arrival order', () => {
    const repo = createHookEventRepo(makeTestDb(), makeTestDeps())
    repo.append('a:1', 'Stop', {})
    repo.append('b:2', 'Stop', {})
    repo.append('a:1', 'UserPromptSubmit', {})

    expect(repo.listBySession('a:1').map((r) => r.eventName)).toEqual(['Stop', 'UserPromptSubmit'])
    expect(repo.listBySession('b:2')).toHaveLength(1)
  })

  test('listSessions returns each distinct session id once, sorted', () => {
    const repo = createHookEventRepo(makeTestDb(), makeTestDeps())
    expect(repo.listSessions()).toEqual([])
    repo.append('b:2', 'Stop', {})
    repo.append('a:1', 'Stop', {})
    repo.append('a:1', 'UserPromptSubmit', {})
    expect(repo.listSessions()).toEqual(['a:1', 'b:2'])
  })

  test('a non-JSON payload (raw truncated body) survives the round trip as a string', () => {
    const repo = createHookEventRepo(makeTestDb(), makeTestDeps())
    repo.append('a:1', 'Stop', '{"truncat')
    expect(repo.listBySession('a:1')[0].payload).toBe('{"truncat')
  })

  test('pruneOlderThan deletes only rows before the cutoff and reports the count', () => {
    const deps = makeTestDeps()
    const repo = createHookEventRepo(makeTestDb(), deps)
    repo.append('a:1', 'Stop', {}) // receivedAt 1001
    repo.append('a:1', 'Stop', {}) // receivedAt 1002
    repo.append('a:1', 'Stop', {}) // receivedAt 1003

    expect(repo.pruneOlderThan(1003)).toBe(2)
    const left = repo.listBySession('a:1')
    expect(left).toHaveLength(1)
    expect(left[0].receivedAt).toBe(1003)
  })

  test('pruning an empty table is a harmless no-op', () => {
    const repo = createHookEventRepo(makeTestDb(), makeTestDeps())
    expect(repo.pruneOlderThan(Date.now())).toBe(0)
  })
})
