import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import { bootFailurePayload } from './bootFailure'
import { DatabaseSetAsideError, DatabaseStartupError } from './db/connection'

/** A genuine node:sqlite error, as a boot-time query against a damaged table raises it. */
function sqliteError(): unknown {
  try {
    new DatabaseSync(':memory:').exec('select * from nope')
  } catch (err) {
    return err
  }
  throw new Error('expected node:sqlite to throw')
}

describe('bootFailurePayload', () => {
  test('a database startup error is flagged as a database failure', () => {
    const err = new DatabaseStartupError(new Error('file is not a database'))
    expect(bootFailurePayload(err)).toEqual({
      message: 'could not open the database: file is not a database',
      databaseFailure: true
    })
  })

  test('a SQLite error raised anywhere in the boot is flagged as a database failure', () => {
    expect(bootFailurePayload(sqliteError())).toEqual({
      message: 'no such table: nope',
      databaseFailure: true
    })
  })

  test('any other boot error carries only its message', () => {
    expect(bootFailurePayload(new Error('x'))).toEqual({ message: 'x' })
    expect(bootFailurePayload('plain string')).toEqual({ message: 'plain string' })
  })

  test('a failed set-aside is marked as such and never offers another set-aside', () => {
    const payload = bootFailurePayload(new DatabaseSetAsideError('renaming intersect.db failed'))
    expect(payload).toEqual({
      message: 'could not set the database aside: renaming intersect.db failed',
      setAsideFailed: true
    })
  })
})
