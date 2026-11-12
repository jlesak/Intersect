import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import { CURRENT_VERSION, runMigrations } from './migrations'

function snapshot(db: DatabaseSync) {
  return db.prepare(`SELECT id, text, description, due_day, priority, sort_order, done_at,
    todo_project_id, due_time, size, task_revision FROM todo_task ORDER BY id`).all()
}

describe('TODO migration 30', () => {
  test('preserves version 29 open, done, dated and undated rows and is repeatable', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db, 29)
    db.prepare(`INSERT INTO todo_task
      (id, text, description, due_day, priority, sort_order, done_at, created_at)
      VALUES ('a', 'old undated', 'details', NULL, 1, 7, NULL, 1),
        ('b', 'old dated', '', '2026-11-10', 3, 2, NULL, 2),
        ('c', 'old done', '', NULL, 4, 0, 123, 3)`).run()
    runMigrations(db)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      .toBe(CURRENT_VERSION)
    const rows = snapshot(db)
    expect(rows).toMatchObject([
      { id: 'a', text: 'old undated', description: 'details', due_day: null,
        priority: 1, sort_order: 7, done_at: null, todo_project_id: null,
        due_time: null, size: null, task_revision: 0 },
      { id: 'b', due_day: '2026-11-10', priority: 3, sort_order: 2 },
      { id: 'c', done_at: 123 }
    ])
    runMigrations(db)
    expect(snapshot(db)).toEqual(rows)
  })
})
