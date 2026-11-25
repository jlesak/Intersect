import type { DatabaseSync } from 'node:sqlite'
import type {
  CalendarMeeting, MeetingProposal, MeetingRouteTarget, MeetingRoutingSettings, TimeEntry
} from '@common/domain'
import { dayKeyOf } from '@common/week'
import type { ManualTimeEntryRepo } from '../db/timeTrackingRepo'
import { tx } from '../db/tx'

export const DEFAULT_MEETING_ROUTING: MeetingRoutingSettings = {
  rules: [], defaultTarget: { kind: 'unassigned' }
}

export function validateMeetingRouting(value: unknown): MeetingRoutingSettings {
  if (!value || typeof value !== 'object') throw new Error('Meeting routing must be an object')
  const input = value as Record<string, unknown>
  if (!Array.isArray(input.rules) || input.rules.length > 100) {
    throw new Error('Meeting rules must be a list of at most 100 rules')
  }
  function target(raw: unknown): MeetingRouteTarget {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid meeting target')
    const t = raw as Record<string, unknown>
    if (t.kind === 'unassigned') return { kind: 'unassigned' }
    if (t.kind === 'issue' && typeof t.issueKey === 'string' &&
      /^[A-Z][A-Z0-9_]*-\d+$/i.test(t.issueKey.trim())) {
      return { kind: 'issue', issueKey: t.issueKey.trim().toUpperCase() }
    }
    if (t.kind === 'project' && typeof t.projectId === 'string' && t.projectId.trim()) {
      return { kind: 'project', projectId: t.projectId.trim() }
    }
    throw new Error('Invalid meeting target')
  }
  return {
    rules: input.rules.map((raw) => {
      if (!raw || typeof raw !== 'object') throw new Error('Invalid meeting rule')
      const rule = raw as Record<string, unknown>
      if (typeof rule.pattern !== 'string' || !rule.pattern.trim() ||
        rule.pattern.length > 200 || /[\x00-\x1f\x7f]/.test(rule.pattern)) {
        throw new Error('Meeting patterns must be nonempty literal text')
      }
      const routed = target(rule.target)
      if (routed.kind === 'unassigned') throw new Error('A meeting rule needs an issue or project target')
      return { pattern: rule.pattern.trim(), target: routed }
    }),
    defaultTarget: target(input.defaultTarget)
  }
}

export function routeMeeting(subject: string, settings: MeetingRoutingSettings): {
  issueKey: string | null; projectId: string | null
} {
  const match = settings.rules.find((rule) =>
    subject.toLocaleLowerCase().includes(rule.pattern.toLocaleLowerCase()))
  const target = match?.target ?? settings.defaultTarget
  if (target.kind === 'issue') return { issueKey: target.issueKey, projectId: null }
  if (target.kind === 'project') return { issueKey: null, projectId: target.projectId }
  return { issueKey: null, projectId: null }
}

interface ProposalRow {
  source: CalendarMeeting['source']
  external_id: string
  day: string
  description: string
  start_at: number
  duration_ms: number
  issue_key: string | null
  project_id: string | null
}

function proposal(row: ProposalRow): MeetingProposal {
  return {
    source: row.source, externalId: row.external_id, day: row.day,
    description: row.description, startAt: row.start_at, durationMs: row.duration_ms,
    issueKey: row.issue_key, projectId: row.project_id
  }
}

function eligible(event: CalendarMeeting, day: string): boolean {
  return event.day === day && dayKeyOf(event.startAt) === day &&
    !event.cancelled && !event.declined && !event.allDay &&
    event.externalId.trim() !== '' && event.subject.trim() !== '' &&
    Number.isFinite(event.startAt) && Number.isFinite(event.endAt) &&
    event.endAt > event.startAt && event.endAt - event.startAt <= 24 * 60 * 60_000
}

export interface MeetingProposals {
  reconcile(day: string, events: CalendarMeeting[], routing: MeetingRoutingSettings): MeetingProposal[]
  list(day: string): MeetingProposal[]
  accept(source: CalendarMeeting['source'], externalId: string): TimeEntry | null
  acceptAll(day: string): TimeEntry[]
  decline(source: CalendarMeeting['source'], externalId: string): void
}

/** The decision row and its accepted manual entry commit or roll back together. */
export function createMeetingProposals(
  db: DatabaseSync, manual: ManualTimeEntryRepo, now: () => number
): MeetingProposals {
  const list = (day: string): MeetingProposal[] => (
    db.prepare(`SELECT * FROM meeting_proposal WHERE day = ? AND status = 'pending'
      ORDER BY start_at, external_id`).all(day) as unknown as ProposalRow[]
  ).map(proposal)

  function one(source: CalendarMeeting['source'], externalId: string): ProposalRow | undefined {
    return db.prepare(`SELECT * FROM meeting_proposal WHERE source = ? AND external_id = ?
      AND status = 'pending'`).get(source, externalId) as ProposalRow | undefined
  }

  function acceptRow(row: ProposalRow): TimeEntry {
    const entry = manual.create({
      day: row.day, description: row.description, issueKey: row.issue_key,
      projectId: row.project_id, durationMs: row.duration_ms
    })
    db.prepare(`UPDATE meeting_proposal SET status = 'accepted', decided_at = ?
      WHERE source = ? AND external_id = ? AND status = 'pending'`
    ).run(now(), row.source, row.external_id)
    return entry
  }

  return {
    reconcile(day, events, routing) {
      return tx(db, () => {
        // A fresh, complete day fetch replaces only undecided proposals. Terminal decisions are
        // permanent tombstones, even if a meeting later vanishes or its accepted entry is deleted.
        db.prepare(`DELETE FROM meeting_proposal WHERE day = ? AND status = 'pending'`).run(day)
        const insert = db.prepare(`INSERT INTO meeting_proposal
          (source, external_id, day, description, start_at, duration_ms,
           issue_key, project_id, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
          ON CONFLICT(source, external_id) DO UPDATE SET
            day = excluded.day,
            description = excluded.description,
            start_at = excluded.start_at,
            duration_ms = excluded.duration_ms,
            issue_key = excluded.issue_key,
            project_id = excluded.project_id
          WHERE meeting_proposal.status = 'pending'`)
        for (const event of events) {
          if (!eligible(event, day)) continue
          const route = routeMeeting(event.subject, routing)
          insert.run(event.source, event.externalId, day, event.subject.trim(), event.startAt,
            event.endAt - event.startAt, route.issueKey, route.projectId)
        }
        return list(day)
      })
    },
    list,
    accept(source, externalId) {
      return tx(db, () => {
        const row = one(source, externalId)
        return row ? acceptRow(row) : null
      })
    },
    acceptAll(day) {
      return tx(db, () => {
        const rows = db.prepare(`SELECT * FROM meeting_proposal
          WHERE day = ? AND status = 'pending' ORDER BY start_at, external_id`
        ).all(day) as unknown as ProposalRow[]
        return rows.map(acceptRow)
      })
    },
    decline(source, externalId) {
      tx(db, () => {
        db.prepare(`UPDATE meeting_proposal SET status = 'declined', decided_at = ?
          WHERE source = ? AND external_id = ? AND status = 'pending'`
        ).run(now(), source, externalId)
      })
    }
  }
}
