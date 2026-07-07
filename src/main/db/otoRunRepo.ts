import type { DatabaseSync } from 'node:sqlite'
import type { OtoRun, OtoRunStatus, OtoRunType } from '@common/domain'
import type { RepoDeps } from './deps'

interface OtoRunRow {
  id: string
  type: string
  person: string
  vtt_path: string | null
  status: string
  notion_url: string | null
  slack_draft_created: number | null
  slack_channel_link: string | null
  result_markdown: string | null
  error: string | null
  created_at: number
  finished_at: number | null
}

function toRun(row: OtoRunRow): OtoRun {
  return {
    id: row.id,
    type: row.type as OtoRunType,
    person: row.person,
    vttPath: row.vtt_path,
    status: row.status as OtoRunStatus,
    notionUrl: row.notion_url,
    slackDraftCreated: row.slack_draft_created === 1,
    slackChannelLink: row.slack_channel_link,
    resultMarkdown: row.result_markdown,
    error: row.error,
    createdAt: row.created_at,
    finishedAt: row.finished_at
  }
}

export type NewOtoRun = Pick<OtoRun, 'type' | 'person' | 'vttPath'>

/**
 * The successful outcome of one run, shaped per workflow type: a `process` run publishes to
 * Notion/Slack and only links back, a `prep` run's whole product is the markdown briefing.
 */
export type OtoDoneResult =
  | {
      type: 'process'
      notionUrl: string | null
      slackDraftCreated: boolean
      slackChannelLink: string | null
    }
  | { type: 'prep'; resultMarkdown: string }

export interface OtoRunRepo {
  /** Insert a new run in the `running` state. */
  create(input: NewOtoRun): OtoRun
  get(id: string): OtoRun | undefined
  /** The full run history, newest first. */
  listAll(): OtoRun[]
  /** Mark a run done and store its per-type result. */
  setDone(id: string, result: OtoDoneResult): OtoRun
  setFailed(id: string, error: string): OtoRun
  /**
   * Crash reconciliation: every run still marked `running` at boot belonged to a previous app
   * process whose hidden session died with it, so it can never finish - mark it failed.
   */
  reconcileOnBoot(): void
}

export function createOtoRunRepo(db: DatabaseSync, deps: RepoDeps): OtoRunRepo {
  const get = (id: string): OtoRun | undefined => {
    const row = db.prepare('SELECT * FROM oto_run WHERE id = ?').get(id) as OtoRunRow | undefined
    return row ? toRun(row) : undefined
  }

  const mustGet = (id: string): OtoRun => {
    const run = get(id)
    if (!run) throw new Error(`1:1 run not found: ${id}`)
    return run
  }

  return {
    create(input) {
      const id = deps.newId()
      db.prepare(
        `INSERT INTO oto_run (id, type, person, vtt_path, status, created_at)
         VALUES (?,?,?,?,'running',?)`
      ).run(id, input.type, input.person, input.vttPath, deps.now())
      return mustGet(id)
    },

    get,

    listAll() {
      const rows = db
        .prepare('SELECT * FROM oto_run ORDER BY created_at DESC')
        .all() as unknown as OtoRunRow[]
      return rows.map(toRun)
    },

    setDone(id, result) {
      mustGet(id)
      if (result.type === 'process') {
        db.prepare(
          `UPDATE oto_run
           SET status = 'done', notion_url = ?, slack_draft_created = ?, slack_channel_link = ?,
               error = NULL, finished_at = ?
           WHERE id = ?`
        ).run(
          result.notionUrl,
          result.slackDraftCreated ? 1 : 0,
          result.slackChannelLink,
          deps.now(),
          id
        )
      } else {
        db.prepare(
          `UPDATE oto_run
           SET status = 'done', result_markdown = ?, error = NULL, finished_at = ?
           WHERE id = ?`
        ).run(result.resultMarkdown, deps.now(), id)
      }
      return mustGet(id)
    },

    setFailed(id, error) {
      mustGet(id)
      db.prepare("UPDATE oto_run SET status = 'failed', error = ?, finished_at = ? WHERE id = ?").run(
        error,
        deps.now(),
        id
      )
      return mustGet(id)
    },

    reconcileOnBoot() {
      db.prepare(
        `UPDATE oto_run
         SET status = 'failed', error = 'Interrupted by app restart', finished_at = ?
         WHERE status = 'running'`
      ).run(deps.now())
    }
  }
}
