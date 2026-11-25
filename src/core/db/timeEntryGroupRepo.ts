import type { DatabaseSync } from 'node:sqlite'
import type { RepoDeps } from './deps'

export type GroupMember = { source: 'auto' | 'manual'; id: string }
export interface TimeEntryGroupRow {
  id: string
  day: string
  description: string
  issueKey: string | null
  durationOverrideMs: number | null
  createdAt: number
  members: GroupMember[]
}

interface DbGroup {
  id: string
  day: string
  description: string
  issue_key: string | null
  duration_override_ms: number | null
  created_at: number
}
interface DbMember { entry_kind: 'auto' | 'manual'; entry_id: string }

export interface TimeEntryGroupRepo {
  get(id: string): TimeEntryGroupRow | undefined
  hasMember(member: GroupMember): boolean
  listByDays(days: string[]): TimeEntryGroupRow[]
  create(day: string, description: string, issueKey: string | null,
    members: GroupMember[]): TimeEntryGroupRow
  update(id: string, update: { description?: string; issueKey?: string | null;
    durationMs?: number }): TimeEntryGroupRow
  remove(id: string): void
  removeMember(member: GroupMember): void
}

export function createTimeEntryGroupRepo(db: DatabaseSync, deps: RepoDeps): TimeEntryGroupRepo {
  const toGroup = (row: DbGroup): TimeEntryGroupRow => ({
    id: row.id, day: row.day, description: row.description, issueKey: row.issue_key,
    durationOverrideMs: row.duration_override_ms, createdAt: row.created_at,
    members: (db.prepare('SELECT entry_kind, entry_id FROM time_entry_group_member WHERE group_id = ?')
      .all(row.id) as unknown as DbMember[]).map(member => ({
      source: member.entry_kind, id: member.entry_id
    }))
  })
  const get = (id: string): TimeEntryGroupRow | undefined => {
    const row = db.prepare('SELECT * FROM time_entry_group WHERE id = ?').get(id) as DbGroup | undefined
    return row && toGroup(row)
  }
  const remove = (id: string): void => {
    db.prepare('DELETE FROM time_entry_group_member WHERE group_id = ?').run(id)
    db.prepare('DELETE FROM time_entry_group WHERE id = ?').run(id)
  }
  return {
    get,
    hasMember(member) {
      return !!db.prepare(`SELECT 1 FROM time_entry_group_member
        WHERE entry_kind = ? AND entry_id = ?`).get(member.source, member.id)
    },
    listByDays(days) {
      if (!days.length) return []
      const rows = db.prepare(`SELECT * FROM time_entry_group WHERE day IN (${days.map(() => '?').join(',')})
        ORDER BY day, created_at, id`).all(...days) as unknown as DbGroup[]
      return rows.map(toGroup)
    },
    create(day, description, issueKey, members) {
      const id = deps.newId()
      db.prepare(`INSERT INTO time_entry_group
        (id, day, description, issue_key, duration_override_ms, created_at)
        VALUES (?,?,?,?,NULL,?)`).run(id, day, description, issueKey, deps.now())
      const insert = db.prepare(`INSERT INTO time_entry_group_member
        (group_id, entry_kind, entry_id) VALUES (?,?,?)`)
      for (const member of members) insert.run(id, member.source, member.id)
      return get(id)!
    },
    update(id, update) {
      if (!get(id)) throw new Error(`Time entry group not found: ${id}`)
      if (update.description !== undefined) db.prepare('UPDATE time_entry_group SET description = ? WHERE id = ?')
        .run(update.description, id)
      if (update.issueKey !== undefined) db.prepare('UPDATE time_entry_group SET issue_key = ? WHERE id = ?')
        .run(update.issueKey, id)
      if (update.durationMs !== undefined) db.prepare('UPDATE time_entry_group SET duration_override_ms = ? WHERE id = ?')
        .run(update.durationMs, id)
      return get(id)!
    },
    remove,
    removeMember(member) {
      const row = db.prepare(`SELECT group_id FROM time_entry_group_member
        WHERE entry_kind = ? AND entry_id = ?`).get(member.source, member.id) as
        { group_id: string } | undefined
      if (!row) return
      db.prepare(`DELETE FROM time_entry_group_member WHERE entry_kind = ? AND entry_id = ?`)
        .run(member.source, member.id)
      const left = db.prepare('SELECT count(*) AS n FROM time_entry_group_member WHERE group_id = ?')
        .get(row.group_id) as { n: number }
      if (left.n < 2) remove(row.group_id)
    }
  }
}
