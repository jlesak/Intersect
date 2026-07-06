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

describe('nested tx (savepoints)', () => {
  test('an inner tx commits as part of the outer transaction', () => {
    const d = db()
    tx(d, () => {
      d.prepare('INSERT INTO t VALUES (1)').run()
      tx(d, () => d.prepare('INSERT INTO t VALUES (2)').run())
    })
    expect(count(d)).toBe(2)
  })

  test('an inner failure rolls back only the inner writes when caught', () => {
    const d = db()
    tx(d, () => {
      d.prepare('INSERT INTO t VALUES (1)').run()
      try {
        tx(d, () => {
          d.prepare('INSERT INTO t VALUES (2)').run()
          throw new Error('inner boom')
        })
      } catch {
        /* outer continues without the inner writes */
      }
    })
    expect(count(d)).toBe(1)
  })

  test('an outer rollback discards committed inner savepoints', () => {
    const d = db()
    expect(() =>
      tx(d, () => {
        tx(d, () => d.prepare('INSERT INTO t VALUES (1)').run())
        throw new Error('outer boom')
      })
    ).toThrow('outer boom')
    expect(count(d)).toBe(0)
  })
})
