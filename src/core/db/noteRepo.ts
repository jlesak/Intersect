import type { DatabaseSync } from 'node:sqlite'
import type { NoteDay, NoteEntry, NoteQuery } from '@common/domain'
import { noteSearchTerms } from '@common/noteSearch'
import { dayKeyOf } from '@common/week'
import type { RepoDeps } from './deps'

interface NoteRow {
  id: string
  day: string
  body: string
  created_at: number
  updated_at: number
}

function toEntry(row: NoteRow): NoteEntry {
  return {
    id: row.id,
    day: row.day,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** The only shape a date bound may have: a local calendar day key. */
const DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * The body as stored: NFC, because the index compares tokens byte for byte and the search always
 * sends composed words, so a decomposed `é` would never be found; and trimmed at the ends, with
 * the line breaks inside kept.
 */
function normalizeBody(body: string): string {
  const normalized = body.normalize('NFC').trim()
  if (!normalized) throw new Error('Note text must not be empty')
  return normalized
}

/**
 * The FTS5 MATCH expression for a search input: every word as a quoted prefix query, joined by
 * spaces, which FTS5 reads as AND. Quoting makes every word a literal string, so nothing the user
 * typed can act as an operator; the words already exclude `"`, and doubling it keeps that true even
 * if they ever did not.
 */
function matchExpression(terms: string[]): string {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(' ')
}

export interface NoteRepo {
  /** Add an entry to the note of the current local day. The body must not be empty when trimmed. */
  create(body: string): NoteEntry
  /** Replace an entry's body. Its day and capture time never change. */
  update(id: string, body: string): NoteEntry
  remove(id: string): void
  /**
   * The days with matching entries, newest day first, each day's entries in capture order. With no
   * search words, no bounds and no limit this is every entry. The cursor and the day limit page by
   * days: a day counts once however many entries match, and its matching entries all come back.
   */
  list(query: NoteQuery): NoteDay[]
}

export function createNoteRepo(db: DatabaseSync, deps: RepoDeps): NoteRepo {
  const mustGet = (id: string): NoteEntry => {
    const row = db.prepare('SELECT * FROM note_entry WHERE id = ?').get(id) as NoteRow | undefined
    if (!row) throw new Error(`Note not found: ${id}`)
    return toEntry(row)
  }

  return {
    create(body) {
      const normalized = normalizeBody(body)
      const now = deps.now()
      const id = deps.newId()
      db.prepare(
        'INSERT INTO note_entry (id, day, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(id, dayKeyOf(now), normalized, now, now)
      return mustGet(id)
    },

    update(id, body) {
      mustGet(id)
      const normalized = normalizeBody(body)
      db.prepare('UPDATE note_entry SET body = ?, updated_at = ? WHERE id = ?').run(
        normalized,
        deps.now(),
        id
      )
      return mustGet(id)
    },

    remove(id) {
      db.prepare('DELETE FROM note_entry WHERE id = ?').run(id)
    },

    list({ text, from, to, before, dayLimit }) {
      for (const bound of [from, to, before]) {
        if (bound !== null && !DAY.test(bound)) throw new Error(`Invalid day: ${bound}`)
      }
      if (dayLimit !== null && !(Number.isInteger(dayLimit) && dayLimit > 0)) {
        throw new Error(`Invalid day limit: ${dayLimit}`)
      }
      const terms = noteSearchTerms(text)
      const where: string[] = []
      const params: (string | number)[] = []
      let join = ''
      if (terms.length > 0) {
        join = 'JOIN note_entry_fts ON note_entry_fts.rowid = e.seq'
        where.push('note_entry_fts MATCH ?')
        params.push(matchExpression(terms))
      }
      if (from !== null) {
        where.push('e.day >= ?')
        params.push(from)
      }
      if (to !== null) {
        where.push('e.day <= ?')
        params.push(to)
      }
      if (before !== null) {
        where.push('e.day < ?')
        params.push(before)
      }
      // The page is the newest `dayLimit` matching days. Those days are the matching days from the
      // oldest of them upwards, so the page is the same query with that day as a lower bound.
      if (dayLimit !== null) {
        const edge = db
          .prepare(
            `SELECT DISTINCT e.day FROM note_entry e ${join}
             ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
             ORDER BY e.day DESC LIMIT ?`
          )
          .all(...params, dayLimit) as unknown as { day: string }[]
        if (edge.length === 0) return []
        where.push('e.day >= ?')
        params.push(edge[edge.length - 1].day)
      }
      const rows = db
        .prepare(
          `SELECT e.id, e.day, e.body, e.created_at, e.updated_at FROM note_entry e ${join}
           ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY e.day DESC, e.seq ASC`
        )
        .all(...params) as unknown as NoteRow[]

      const days: NoteDay[] = []
      for (const row of rows) {
        const last = days[days.length - 1]
        if (last?.day === row.day) last.entries.push(toEntry(row))
        else days.push({ day: row.day, entries: [toEntry(row)] })
      }
      return days
    }
  }
}
