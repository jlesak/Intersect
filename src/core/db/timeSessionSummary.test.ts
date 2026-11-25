import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { runMigrations } from './migrations'
import { createTimeSessionDayRepo } from './timeSessionDayRepo'

const dbs: DatabaseSync[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })

test('migration preserves snapshots and summary state survives scans and failures', () => {
  const db = new DatabaseSync(':memory:')
  dbs.push(db)
  runMigrations(db, 31)
  db.prepare(`INSERT INTO time_session_day
    (session_id, day, title, cwd, git_branch, auto_description, first_timestamp,
      last_timestamp, active_duration_ms, updated_at)
    VALUES ('s1', '2026-07-06', 'Title', '/work', NULL, 'Fallback', 1, 2, 300000, 1)`).run()
  runMigrations(db)
  const repo = createTimeSessionDayRepo(db, () => 99)
  expect(repo.get('s1', '2026-07-06')).toMatchObject({
    summary: null, summaryStatus: 'pending', summarizedThrough: null,
    isWork: null, workConfirmed: false
  })
  repo.saveSummary('s1', '2026-07-06', 2, { summary: 'Oprava testů.', isWork: false })
  repo.upsert({ sessionId: 's1', day: '2026-07-06', title: 'New title', cwd: '/work',
    gitBranch: null, autoDescription: 'New fallback', firstTimestamp: 1,
    lastTimestamp: 4, activeDurationMs: 300000 })
  repo.failSummary('s1', '2026-07-06')
  expect(repo.get('s1', '2026-07-06')).toMatchObject({
    summary: 'Oprava testů.', summaryStatus: 'failed', summarizedThrough: 2, isWork: false
  })
  repo.confirmWork('s1', '2026-07-06')
  repo.saveSummary('s1', '2026-07-06', 4, { summary: 'Nová oprava testů.', isWork: false })
  expect(repo.get('s1', '2026-07-06')).toMatchObject({
    summary: 'Nová oprava testů.', summaryStatus: 'done', summarizedThrough: 4,
    isWork: true, workConfirmed: true
  })
})
