import { describe, expect, test } from 'vitest'
import type { NewAgentRuntimeEvidence } from '@common/domain'
import { agentRuntimeExternalId, createAgentRuntimeRepo } from './agentRuntimeRepo'
import { makeTestDb } from './testkit'

function row(over: Partial<NewAgentRuntimeEvidence> = {}): NewAgentRuntimeEvidence {
  return {
    sessionId: 'ws1:tab1',
    localDate: '2026-07-06',
    minutes: 30,
    source: 'hook',
    confidence: 'high',
    projectId: null,
    workItemSource: null,
    workItemKey: null,
    computedAt: 1000,
    ...over
  }
}

describe('agentRuntimeRepo', () => {
  test('upsert on the same (session, day) updates in place - no duplicate row', () => {
    const repo = createAgentRuntimeRepo(makeTestDb())
    repo.upsert(row({ minutes: 30 }))
    const updated = repo.upsert(row({ minutes: 42, computedAt: 2000 }))
    expect(updated.minutes).toBe(42)
    expect(updated.externalId).toBe('hook:ws1:tab1:2026-07-06')
    expect(repo.listForSession('ws1:tab1')).toHaveLength(1)
  })

  test('external id follows the stable ${source}:${sessionId}:${localDate} shape', () => {
    expect(agentRuntimeExternalId(row({ source: 'jsonl', sessionId: 'jsonl:uuid-9' }))).toBe(
      'jsonl:jsonl:uuid-9:2026-07-06'
    )
  })

  test('listByDays returns only the requested days, ordered by day then session', () => {
    const repo = createAgentRuntimeRepo(makeTestDb())
    repo.upsert(row({ sessionId: 'b:2', localDate: '2026-07-07' }))
    repo.upsert(row({ sessionId: 'a:1', localDate: '2026-07-07' }))
    repo.upsert(row({ sessionId: 'a:1', localDate: '2026-07-06' }))
    repo.upsert(row({ sessionId: 'c:3', localDate: '2026-07-09' }))
    const got = repo.listByDays(['2026-07-06', '2026-07-07'])
    expect(got.map((r) => `${r.localDate}/${r.sessionId}`)).toEqual([
      '2026-07-06/a:1',
      '2026-07-07/a:1',
      '2026-07-07/b:2'
    ])
  })

  test('listForProject filters by project across the given days', () => {
    const db = makeTestDb()
    const insert = db.prepare(
      'INSERT INTO projects (id,name,sort_order,archived,created_at) VALUES (?,?,?,0,?)'
    )
    insert.run('p1', 'P1', 0, 1)
    insert.run('p2', 'P2', 1, 1)
    const repo = createAgentRuntimeRepo(db)
    repo.upsert(row({ sessionId: 'a:1', projectId: 'p1' }))
    repo.upsert(row({ sessionId: 'b:2', projectId: 'p2' }))
    repo.upsert(row({ sessionId: 'c:3', projectId: null }))
    const got = repo.listForProject('p1', ['2026-07-06'])
    expect(got.map((r) => r.sessionId)).toEqual(['a:1'])
  })

  test('replaceForSession converges: stale days drop, present days upsert, re-run is identical', () => {
    const repo = createAgentRuntimeRepo(makeTestDb())
    repo.replaceForSession('ws1:tab1', [
      row({ localDate: '2026-07-06', minutes: 10 }),
      row({ localDate: '2026-07-07', minutes: 20 })
    ])
    // A recompute that no longer sees the 7th and grows the 6th.
    repo.replaceForSession('ws1:tab1', [row({ localDate: '2026-07-06', minutes: 25 })])
    const first = repo.listForSession('ws1:tab1')
    expect(first.map((r) => `${r.localDate}=${r.minutes}`)).toEqual(['2026-07-06=25'])
    // Running the identical recompute again leaves the rows untouched.
    repo.replaceForSession('ws1:tab1', [row({ localDate: '2026-07-06', minutes: 25 })])
    expect(repo.listForSession('ws1:tab1')).toEqual(first)
  })

  test('replaceForSession with an empty set clears the session', () => {
    const repo = createAgentRuntimeRepo(makeTestDb())
    repo.upsert(row())
    repo.replaceForSession('ws1:tab1', [])
    expect(repo.listForSession('ws1:tab1')).toEqual([])
  })

  test('a project delete nulls the evidence project instead of deleting the row', () => {
    const db = makeTestDb()
    db.prepare(
      'INSERT INTO projects (id,name,sort_order,archived,created_at) VALUES (?,?,?,?,?)'
    ).run('p1', 'P', 0, 0, 1)
    const repo = createAgentRuntimeRepo(db)
    repo.upsert(row({ projectId: 'p1' }))
    db.prepare('DELETE FROM projects WHERE id = ?').run('p1')
    expect(repo.listForSession('ws1:tab1')[0].projectId).toBeNull()
  })
})
