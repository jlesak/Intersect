import { beforeEach, describe, expect, test } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { equalShares, type GridShares } from '@common/terminalLayoutShares'
import { createTerminalLayoutRepo, type TerminalLayoutRepo } from './terminalLayoutRepo'
import { makeTestDb, makeTestDeps } from './testkit'

describe('terminalLayoutRepo', () => {
  let db: DatabaseSync
  let repo: TerminalLayoutRepo

  beforeEach(() => {
    db = makeTestDb()
    repo = createTerminalLayoutRepo(db, makeTestDeps())
  })

  test('round-trips pair and grid shares per layout', () => {
    const grid: GridShares = { columns: [60, 40], leftRows: [70, 30], rightRows: [20, 80] }
    repo.set('p1', 'columns', [70, 30])
    repo.set('p1', 'rows', [30, 70])
    repo.set('p1', 'grid', grid)
    expect(repo.getAll('p1')).toEqual({
      columns: [70, 30],
      rows: [30, 70],
      grid
    })
  })

  test('an unknown project key reads as empty', () => {
    expect(repo.getAll('nope')).toEqual({})
  })

  test('setting the same layout again overwrites the previous shares', () => {
    repo.set('p1', 'columns', [70, 30])
    repo.set('p1', 'columns', [40, 60])
    expect(repo.getAll('p1')).toEqual({ columns: [40, 60] })
  })

  test('shares are isolated per project key and per layout', () => {
    repo.set('p1', 'columns', [70, 30])
    repo.set('p2', 'columns', [20, 80])
    repo.set('other', 'rows', [60, 40])
    expect(repo.getAll('p1')).toEqual({ columns: [70, 30] })
    expect(repo.getAll('p2')).toEqual({ columns: [20, 80] })
    expect(repo.getAll('other')).toEqual({ rows: [60, 40] })
  })

  test('normalizes invalid shares before writing', () => {
    repo.set('p1', 'columns', [5, 95])
    expect(repo.getAll('p1')).toEqual({ columns: [10, 90] })
  })

  test('a corrupt persisted row reads as equal shares instead of failing', () => {
    db.prepare(
      `INSERT INTO project_terminal_layouts (project_key, layout, shares, updated_at)
       VALUES ('p1', 'columns', 'not json{', 1), ('p1', 'grid', '[70,30]', 1)`
    ).run()
    expect(repo.getAll('p1')).toEqual({
      columns: [50, 50],
      grid: equalShares('grid')
    })
  })

  test('a row for a layout that has no ratio is ignored on read', () => {
    db.prepare(
      `INSERT INTO project_terminal_layouts (project_key, layout, shares, updated_at)
       VALUES ('p1', 'single', '[50,50]', 1)`
    ).run()
    expect(repo.getAll('p1')).toEqual({})
  })

  test('rejects writes for layouts without shares and empty project keys', () => {
    expect(() => repo.set('p1', 'single' as never, [50, 50])).toThrow('no pane shares')
    expect(() => repo.set('', 'columns', [50, 50])).toThrow('must not be empty')
  })

  test('removeForProject drops exactly that project key', () => {
    repo.set('p1', 'columns', [70, 30])
    repo.set('p1', 'grid', equalShares('grid'))
    repo.set('p2', 'columns', [20, 80])
    repo.removeForProject('p1')
    expect(repo.getAll('p1')).toEqual({})
    expect(repo.getAll('p2')).toEqual({ columns: [20, 80] })
  })
})
