import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import { tx } from './tx'

function db(): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  d.exec('CREATE TABLE t (x INTEGER)')
  return d
}

function count(d: DatabaseSync): number {
  return (d.prepare('SELECT count(*) AS c FROM t').get() as { c: number }).c
}

describe('tx', () => {
  test('commits changes and returns the callback result', () => {
    const d = db()
    const result = tx(d, () => {
      d.prepare('INSERT INTO t VALUES (1)').run()
      d.prepare('INSERT INTO t VALUES (2)').run()
      return 'done'
    })
    expect(result).toBe('done')
    expect(count(d)).toBe(2)
  })

  test('rolls back every change when the callback throws', () => {
    const d = db()
    expect(() =>
      tx(d, () => {
        d.prepare('INSERT INTO t VALUES (1)').run()
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(count(d)).toBe(0)
  })
})
