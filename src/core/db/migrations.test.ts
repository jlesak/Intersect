import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import { CURRENT_VERSION, runMigrations } from './migrations'

function userVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

describe('migrations', () => {
  test('a fresh database is migrated to the current version', () => {
    const db = new DatabaseSync(':memory:')
    expect(userVersion(db)).toBe(0)
    runMigrations(db)
    expect(userVersion(db)).toBe(CURRENT_VERSION)
  })

  test('creates the workspaces, tabs and app_state tables', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name)
    expect(names).toEqual(expect.arrayContaining(['workspaces', 'tabs', 'app_state']))
  })

  test('is idempotent - running again does not throw and keeps the version', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    expect(() => runMigrations(db)).not.toThrow()
    expect(userVersion(db)).toBe(CURRENT_VERSION)
  })

  test('pr_cache accepts my_vote and the pr_review_watermark table exists', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    db.prepare(
      `INSERT INTO pr_cache
         (repository_id, pr_id, project_id, repository_name, title, author_id, author_name,
          created_at, status, source_ref, target_ref, source_commit, target_commit, url,
          my_role, my_vote, reviewers_json, synced_at)
       VALUES ('r', 1, 'p', 'repo', 't', 'a', 'A', 1, 'active', 's', 't', 'sc', 'tc', 'u', 'reviewer', 'approved', '[]', 1)`
    ).run()
    expect(
      (db.prepare('SELECT my_vote AS v FROM pr_cache').get() as { v: string }).v
    ).toBe('approved')
    db.prepare(
      `INSERT INTO pr_review_watermark (repository_id, pr_id, voted_commit_id, updated_at)
       VALUES ('r', 1, 'sc', 1)`
    ).run()
    expect(
      (db.prepare('SELECT count(*) AS c FROM pr_review_watermark').get() as { c: number }).c
    ).toBe(1)
  })

  test('pr_cache accepts my_reviewer_id and rows written without it read as NULL', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    db.prepare(
      `INSERT INTO pr_cache
         (repository_id, pr_id, project_id, repository_name, title, author_id, author_name,
          created_at, status, source_ref, target_ref, source_commit, target_commit, url,
          my_role, my_vote, my_reviewer_id, reviewers_json, synced_at)
       VALUES ('r', 1, 'p', 'repo', 't', 'a', 'A', 1, 'active', 's', 't', 'sc', 'tc', 'u', 'reviewer', 'approved', 'me-uuid', '[]', 1)`
    ).run()
    // A legacy-shaped insert (as rows cached before the column existed) leaves the column NULL.
    db.prepare(
      `INSERT INTO pr_cache
         (repository_id, pr_id, project_id, repository_name, title, author_id, author_name,
          created_at, status, source_ref, target_ref, source_commit, target_commit, url,
          my_role, reviewers_json, synced_at)
       VALUES ('r', 2, 'p', 'repo', 't', 'a', 'A', 1, 'active', 's', 't', 'sc', 'tc', 'u', 'reviewer', '[]', 1)`
    ).run()
    expect(
      (db.prepare('SELECT my_reviewer_id AS v FROM pr_cache WHERE pr_id = 1').get() as { v: string }).v
    ).toBe('me-uuid')
    expect(
      (db.prepare('SELECT my_reviewer_id AS v FROM pr_cache WHERE pr_id = 2').get() as { v: string | null }).v
    ).toBeNull()
  })

  test('the time tracking tables accept manual entries and session overrides', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    db.prepare(
      `INSERT INTO time_entry_manual (id, day, description, issue_key, duration_ms, created_at)
       VALUES ('m1', '2026-07-06', 'Team sync', NULL, 1800000, 1)`
    ).run()
    db.prepare(
      `INSERT INTO time_entry_override (session_id, issue_key, duration_ms, updated_at)
       VALUES ('s1', 'FID2507-611', 3600000, 1)`
    ).run()
    expect(
      (db.prepare('SELECT deleted AS d FROM time_entry_override').get() as { d: number }).d
    ).toBe(0)
    expect(
      (db.prepare('SELECT count(*) AS c FROM time_entry_manual').get() as { c: number }).c
    ).toBe(1)
  })

  test('the todo table accepts open and done tasks with an optional due day', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    db.prepare(
      `INSERT INTO todo_task (id, text, due_day, sort_order, done_at, created_at)
       VALUES ('t1', 'Ask Marek about the review', '2026-07-10', 0, NULL, 1)`
    ).run()
    db.prepare(
      `INSERT INTO todo_task (id, text, due_day, sort_order, done_at, created_at)
       VALUES ('t2', 'Order a monitor', NULL, 1, 42, 2)`
    ).run()
    expect(
      (db.prepare('SELECT count(*) AS c FROM todo_task WHERE done_at IS NULL').get() as { c: number }).c
    ).toBe(1)
    expect(
      (db.prepare("SELECT due_day AS d FROM todo_task WHERE id = 't1'").get() as { d: string }).d
    ).toBe('2026-07-10')
  })

  test('pr_cache defaults active_thread_count to 0 for rows inserted without it', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    db.prepare(
      `INSERT INTO pr_cache
         (repository_id, pr_id, project_id, repository_name, title, author_id, author_name,
          created_at, status, source_ref, target_ref, source_commit, target_commit, url,
          my_role, reviewers_json, synced_at)
       VALUES ('r', 1, 'p', 'repo', 't', 'a', 'A', 1, 'active', 's', 't', 'sc', 'tc', 'u',
               'author', '[]', 1)`
    ).run()
    const row = db
      .prepare('SELECT active_thread_count AS c FROM pr_cache WHERE pr_id = 1')
      .get() as { c: number }
    expect(row.c).toBe(0)
  })

  test('the todo table defaults priority to 4 and description to empty for rows inserted without them', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    db.prepare(
      `INSERT INTO todo_task (id, text, due_day, sort_order, done_at, created_at)
       VALUES ('t1', 'Order a monitor', NULL, 0, NULL, 1)`
    ).run()
    const row = db
      .prepare("SELECT priority AS p, description AS d FROM todo_task WHERE id = 't1'")
      .get() as { p: number; d: string }
    expect(row.p).toBe(4)
    expect(row.d).toBe('')
  })

  test('priority-era TODO rows seed one exact manual order without losing content', () => {
    const db = new DatabaseSync(':memory:')
    // A database genuinely at the priority-era schema version.
    runMigrations(db, 11)
    const insert = db.prepare(
      `INSERT INTO todo_task
         (id, text, description, due_day, priority, sort_order, done_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    insert.run('p4', 'No priority', 'keep p4', null, 4, 0, null, 100)
    insert.run('p2-none', 'No due day', 'keep none', null, 2, 1, null, 101)
    insert.run('p2-later', 'Later', 'keep later', '2026-08-01', 2, 2, null, 102)
    insert.run('p1', 'Urgent', 'keep urgent', null, 1, 3, null, 103)
    insert.run('p2-sooner', 'Sooner', 'keep sooner', '2026-07-20', 2, 4, null, 104)
    insert.run('tie-b', 'Tie B', 'keep tie b', null, 3, 7, null, 105)
    insert.run('tie-a', 'Tie A', 'keep tie a', null, 3, 7, null, 105)
    insert.run('done', 'Completed', 'keep done', '2026-01-01', 1, 77, 999, 99)

    runMigrations(db)

    const open = db
      .prepare(
        `SELECT id, text, description, due_day AS dueDay, priority, sort_order AS sortOrder,
                done_at AS doneAt, created_at AS createdAt
         FROM todo_task WHERE done_at IS NULL ORDER BY sort_order`
      )
      .all() as unknown as Array<Record<string, unknown>>
    expect(open.map((row) => row.id)).toEqual([
      'p1',
      'p2-sooner',
      'p2-later',
      'p2-none',
      'tie-a',
      'tie-b',
      'p4'
    ])
    expect(open.map((row) => row.sortOrder)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(open.find((row) => row.id === 'p2-sooner')).toEqual({
      id: 'p2-sooner',
      text: 'Sooner',
      description: 'keep sooner',
      dueDay: '2026-07-20',
      priority: 2,
      sortOrder: 1,
      doneAt: null,
      createdAt: 104
    })
    expect(
      db.prepare("SELECT sort_order AS n, description AS d FROM todo_task WHERE id = 'done'").get()
    ).toEqual({ n: 77, d: 'keep done' })
    expect((db.prepare('SELECT count(*) AS n FROM todo_task').get() as { n: number }).n).toBe(8)

    const snapshot = db.prepare('SELECT * FROM todo_task ORDER BY id').all()
    runMigrations(db)
    expect(db.prepare('SELECT * FROM todo_task ORDER BY id').all()).toEqual(snapshot)
  })

  test('creates the project tables and links workspaces to projects', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name)
    expect(names).toEqual(expect.arrayContaining(['projects', 'project_repo', 'project_ado_repo']))
    db.prepare(
      'INSERT INTO projects (id,name,sort_order,archived,created_at) VALUES (?,?,?,?,?)'
    ).run('p1', 'P', 0, 0, 1)
    db.prepare(
      'INSERT INTO workspaces (id,name,folder_path,layout,active_tab_id,sort_order,created_at,project_id) VALUES (?,?,?,?,?,?,?,?)'
    ).run('w1', 'W', '/tmp', 'single', null, 0, 1, 'p1')
    expect(
      (db.prepare("SELECT project_id AS p FROM workspaces WHERE id='w1'").get() as { p: string }).p
    ).toBe('p1')
  })

  test('every pre-project workspace migrates into exactly one project preserving all state', () => {
    const db = new DatabaseSync(':memory:')
    // A database genuinely at the last pre-project schema version.
    // Two workspaces deliberately share a folder to prove duplicates survive without loss.
    runMigrations(db, 12)
    const insertWs = db.prepare(
      'INSERT INTO workspaces (id,name,folder_path,layout,active_tab_id,sort_order,created_at) VALUES (?,?,?,?,?,?,?)'
    )
    insertWs.run('w1', 'SPOT', '/repos/spot', 'grid', 't1', 0, 100)
    insertWs.run('w2', 'Intersect', '/repos/intersect', 'single', null, 1, 200)
    insertWs.run('w3', 'SPOT again', '/repos/spot', 'columns', null, 2, 300)
    db.prepare(
      'INSERT INTO tabs (id,workspace_id,title,preset,pane_slot,sort_order,created_at,resume_session_id) VALUES (?,?,?,?,?,?,?,?)'
    ).run('t1', 'w1', 'Claude', 'claude', 0, 0, 100, 'resume-uuid')

    runMigrations(db)

    const projects = db
      .prepare('SELECT id, name, sort_order AS s, archived AS a FROM projects ORDER BY sort_order')
      .all() as unknown as Array<Record<string, unknown>>
    expect(projects).toEqual([
      { id: 'w1', name: 'SPOT', s: 0, a: 0 },
      { id: 'w2', name: 'Intersect', s: 1, a: 0 },
      { id: 'w3', name: 'SPOT again', s: 2, a: 0 }
    ])
    expect(
      db.prepare('SELECT project_id AS p, path FROM project_repo ORDER BY project_id').all()
    ).toEqual([
      { p: 'w1', path: '/repos/spot' },
      { p: 'w2', path: '/repos/intersect' },
      { p: 'w3', path: '/repos/spot' }
    ])
    // Workspace state survives verbatim: layout, active tab, ordering, tabs, resume ids.
    expect(
      db
        .prepare("SELECT project_id AS p, layout, active_tab_id AS t FROM workspaces WHERE id='w1'")
        .get()
    ).toEqual({ p: 'w1', layout: 'grid', t: 't1' })
    expect(
      db.prepare("SELECT resume_session_id AS r, pane_slot AS s FROM tabs WHERE id='t1'").get()
    ).toEqual({ r: 'resume-uuid', s: 0 })

    const snapshot = {
      projects: db.prepare('SELECT * FROM projects ORDER BY id').all(),
      repos: db.prepare('SELECT * FROM project_repo ORDER BY project_id, path').all(),
      workspaces: db.prepare('SELECT * FROM workspaces ORDER BY id').all()
    }
    runMigrations(db)
    expect({
      projects: db.prepare('SELECT * FROM projects ORDER BY id').all(),
      repos: db.prepare('SELECT * FROM project_repo ORDER BY project_id, path').all(),
      workspaces: db.prepare('SELECT * FROM workspaces ORDER BY id').all()
    }).toEqual(snapshot)
  })

  test('deleting a project detaches its workspaces instead of deleting them', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    db.prepare(
      'INSERT INTO projects (id,name,sort_order,archived,created_at) VALUES (?,?,?,?,?)'
    ).run('p1', 'P', 0, 0, 1)
    db.prepare(
      'INSERT INTO project_repo (project_id,path,sort_order,created_at) VALUES (?,?,?,?)'
    ).run('p1', '/repos/spot', 0, 1)
    db.prepare(
      'INSERT INTO workspaces (id,name,folder_path,layout,active_tab_id,sort_order,created_at,project_id) VALUES (?,?,?,?,?,?,?,?)'
    ).run('w1', 'W', '/repos/spot', 'single', null, 0, 1, 'p1')
    db.prepare('DELETE FROM projects WHERE id=?').run('p1')
    expect((db.prepare('SELECT count(*) AS c FROM project_repo').get() as { c: number }).c).toBe(0)
    expect(
      db.prepare("SELECT project_id AS p FROM workspaces WHERE id='w1'").get()
    ).toEqual({ p: null })
  })

  test('deleting a workspace cascades to its tabs', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    db.prepare(
      'INSERT INTO workspaces (id,name,folder_path,layout,active_tab_id,sort_order,created_at) VALUES (?,?,?,?,?,?,?)'
    ).run('w1', 'W', '/tmp', 'single', null, 0, 1)
    db.prepare(
      'INSERT INTO tabs (id,workspace_id,title,preset,pane_slot,sort_order,created_at) VALUES (?,?,?,?,?,?,?)'
    ).run('t1', 'w1', 'T', 'shell', null, 0, 1)
    db.prepare('DELETE FROM workspaces WHERE id=?').run('w1')
    expect((db.prepare('SELECT count(*) AS c FROM tabs').get() as { c: number }).c).toBe(0)
  })

  test('hook_events accepts raw events keyed by instance id with a timestamp', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    db.prepare(
      `INSERT INTO hook_events (session_id, event_name, payload_json, received_at)
       VALUES ('ws1:tab1', 'SessionStart', '{"session_id":"u1"}', 1000)`
    ).run()
    expect(
      (db.prepare('SELECT event_name AS e FROM hook_events').get() as { e: string }).e
    ).toBe('SessionStart')
  })

  test('rejects a tab with an invalid preset (CHECK constraint)', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    db.prepare(
      'INSERT INTO workspaces (id,name,folder_path,layout,active_tab_id,sort_order,created_at) VALUES (?,?,?,?,?,?,?)'
    ).run('w1', 'W', '/tmp', 'single', null, 0, 1)
    expect(() =>
      db
        .prepare(
          'INSERT INTO tabs (id,workspace_id,title,preset,pane_slot,sort_order,created_at) VALUES (?,?,?,?,?,?,?)'
        )
        .run('t1', 'w1', 'T', 'browser', null, 0, 1)
    ).toThrow()
  })

  test('work_item_refs enforces one ref per tab and cascades away with the tab', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    db.prepare(
      'INSERT INTO workspaces (id,name,folder_path,layout,active_tab_id,sort_order,created_at) VALUES (?,?,?,?,?,?,?)'
    ).run('w1', 'W', '/tmp', 'single', null, 0, 1)
    db.prepare(
      'INSERT INTO tabs (id,workspace_id,title,preset,pane_slot,sort_order,created_at) VALUES (?,?,?,?,?,?,?)'
    ).run('t1', 'w1', 'T', 'claude', null, 0, 1)
    const insertRef = db.prepare(
      `INSERT INTO work_item_refs
         (tab_id, source, external_key, project_id, snapshot_key, snapshot_title, snapshot_type, assigned_at)
       VALUES ('t1', ?, 'FID-1', NULL, 'FID-1', 'Summary', 'issue', 1)`
    )
    insertRef.run('jira')
    // The tab-id primary key forbids a second primary ref on the same session.
    expect(() => insertRef.run('todo')).toThrow()
    // An unknown source is rejected by the CHECK constraint.
    expect(() =>
      db
        .prepare(
          `INSERT INTO work_item_refs
             (tab_id, source, external_key, project_id, snapshot_key, snapshot_title, snapshot_type, assigned_at)
           VALUES ('t1', 'github', 'x', NULL, 'x', 'x', 'x', 1)`
        )
        .run()
    ).toThrow()
    db.prepare('DELETE FROM tabs WHERE id=?').run('t1')
    expect(
      (db.prepare('SELECT count(*) AS c FROM work_item_refs').get() as { c: number }).c
    ).toBe(0)
  })

  test('agent_runtime_evidence enforces one row per session per day and constrains source/confidence', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    const insert = db.prepare(
      `INSERT INTO agent_runtime_evidence
         (session_id, local_date, minutes, source, confidence, project_id,
          work_item_source, work_item_key, external_id, computed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    insert.run('ws1:tab1', '2026-07-06', 30, 'hook', 'high', null, null, null, 'hook:ws1:tab1:2026-07-06', 1)
    // The (session, day) primary key forbids a second row for the same session and day.
    expect(() =>
      insert.run('ws1:tab1', '2026-07-06', 40, 'hook', 'high', null, null, null, 'x', 2)
    ).toThrow()
    // A row on a different day is allowed.
    insert.run('ws1:tab1', '2026-07-07', 12, 'jsonl', 'low', null, null, null, 'jsonl:ws1:tab1:2026-07-07', 3)
    expect(
      (db.prepare("SELECT count(*) AS c FROM agent_runtime_evidence WHERE session_id='ws1:tab1'").get() as { c: number }).c
    ).toBe(2)
    // Unknown source and confidence are rejected by the CHECK constraints.
    expect(() =>
      insert.run('s2', '2026-07-06', 1, 'toggl', 'high', null, null, null, 'x', 1)
    ).toThrow()
    expect(() =>
      insert.run('s2', '2026-07-06', 1, 'hook', 'medium', null, null, null, 'x', 1)
    ).toThrow()
  })

  test('deleting a project nulls agent_runtime_evidence.project_id instead of the row', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    db.prepare(
      'INSERT INTO projects (id,name,sort_order,archived,created_at) VALUES (?,?,?,?,?)'
    ).run('p1', 'P', 0, 0, 1)
    db.prepare(
      `INSERT INTO agent_runtime_evidence
         (session_id, local_date, minutes, source, confidence, project_id,
          work_item_source, work_item_key, external_id, computed_at)
       VALUES ('ws1:tab1','2026-07-06',30,'hook','high','p1',NULL,NULL,'hook:ws1:tab1:2026-07-06',1)`
    ).run()
    db.prepare('DELETE FROM projects WHERE id=?').run('p1')
    expect(
      db.prepare("SELECT project_id AS p FROM agent_runtime_evidence WHERE session_id='ws1:tab1'").get()
    ).toEqual({ p: null })
  })

  test('agent_runtime_evidence is created only at v19, not before', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db, 18)
    const before = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_runtime_evidence'")
        .all() as { name: string }[]
    ).length
    expect(before).toBe(0)
    runMigrations(db)
    const after = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_runtime_evidence'")
        .all() as { name: string }[]
    ).length
    expect(after).toBe(1)
  })

  test('work_item_ref_events has no tab foreign key so audit history survives tab deletion', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    db.prepare(
      `INSERT INTO work_item_ref_events (tab_id, action, source, external_key, snapshot_key, snapshot_title, at)
       VALUES ('gone-tab', 'assign', 'jira', 'FID-1', 'FID-1', 'Summary', 1)`
    ).run()
    expect(
      (db.prepare('SELECT count(*) AS c FROM work_item_ref_events').get() as { c: number }).c
    ).toBe(1)
    // An unknown action is rejected by the CHECK constraint.
    expect(() =>
      db
        .prepare(
          `INSERT INTO work_item_ref_events (tab_id, action, source, external_key, snapshot_key, snapshot_title, at)
           VALUES ('t', 'rename', NULL, NULL, NULL, NULL, 1)`
        )
        .run()
    ).toThrow()
  })

  test('time_entry_override gains a nullable description that survives on legacy rows', () => {
    const db = new DatabaseSync(':memory:')
    // A database genuinely at the pre-description-edit schema version.
    runMigrations(db, 20)
    db.prepare(
      `INSERT INTO time_entry_override (session_id, issue_key, duration_ms, deleted, updated_at)
       VALUES ('s1', 'FID2507-611', 3600000, 0, 1)`
    ).run()

    runMigrations(db)

    const row = db
      .prepare('SELECT description AS d FROM time_entry_override WHERE session_id = ?')
      .get('s1') as { d: string | null }
    expect(row.d).toBeNull()
  })

  test('tabs gains the suspend columns and the session_lifecycle_events audit table', () => {
    const db = new DatabaseSync(':memory:')
    runMigrations(db)
    const cols = (db.prepare('PRAGMA table_info(tabs)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(['session_status', 'suspend_reason', 'suspended_at']))

    // The audit table has no tab foreign key, so history survives tab deletion.
    db.prepare(
      `INSERT INTO session_lifecycle_events (tab_id, action, reason, at) VALUES ('gone', 'suspend', 'app-quit-suspend', 1)`
    ).run()
    expect(
      (db.prepare('SELECT count(*) AS c FROM session_lifecycle_events').get() as { c: number }).c
    ).toBe(1)
    // An unknown action is rejected by the CHECK constraint.
    expect(() =>
      db
        .prepare(`INSERT INTO session_lifecycle_events (tab_id, action, reason, at) VALUES ('t', 'pause', NULL, 1)`)
        .run()
    ).toThrow()
  })
})
