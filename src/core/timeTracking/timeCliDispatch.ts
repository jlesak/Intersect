import type { DatabaseSync } from 'node:sqlite'
import type { TimeEntry, TimeEntryRef, TimeEntryUpdate } from '@common/domain'
import { tx } from '../db/tx'
import type { TimeEntryGroupRepo } from '../db/timeEntryGroupRepo'
import type { TimeTrackingService } from './timeTracking'

export const TIME_CLI_ROUTES = ['list', 'add', 'edit', 'delete', 'group', 'ungroup'] as const
type Command = typeof TIME_CLI_ROUTES[number]
type Result = { code: number; value?: unknown; error?: string }
type Input = Record<string, unknown>

class CliError extends Error {
  constructor(readonly code: number, message: string) { super(message) }
}
const invalid = (message: string): never => { throw new CliError(2, message) }
const forbidden = (): never => { throw new CliError(4, 'This entry has already been synced.') }
const string = (value: unknown, name: string): string => {
  if (typeof value !== 'string') return invalid(`Invalid ${name}.`)
  return value
}
const DAY = /^\d{4}-\d{2}-\d{2}$/
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

function validDay(value: unknown, now: number, zone: string): string {
  const day = string(value, 'day')
  const parsed = new Date(`${day}T00:00:00Z`)
  if (!DAY.test(day) || !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== day) {
    return invalid('Day must be a real date in YYYY-MM-DD format.')
  }
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric',
    month: '2-digit', day: '2-digit' }).format(now)
  const oldest = new Date(`${today}T00:00:00Z`)
  oldest.setUTCDate(oldest.getUTCDate() - 31)
  if (day > today || day < oldest.toISOString().slice(0, 10)) {
    return invalid('Day must be within the past 31 days and not in the future.')
  }
  return day
}

function duration(value: unknown): number {
  const raw = string(value, 'duration')
  const match = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(raw)
  if (!match || !match[1] && !match[2]) return invalid('Duration must use hours and minutes.')
  const minutes = Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 720) {
    return invalid('Duration must be from one minute to twelve hours.')
  }
  return minutes * 60_000
}

function description(value: unknown): string {
  const raw = string(value, 'description')
  const text = raw.trim()
  if (!text || text.length > 255 || CONTROL.test(raw)) {
    return invalid('Description must contain 1 to 255 characters without controls.')
  }
  return text
}

function issue(value: unknown): string {
  const key = string(value, 'issue key').toUpperCase()
  if (!/^[A-Z][A-Z0-9]+-[1-9][0-9]*$/.test(key)) return invalid('Invalid issue key.')
  return key
}

function actor(value: unknown): 'claude' | 'codex' | 'user' {
  if (value !== 'claude' && value !== 'codex' && value !== 'user') return invalid('Invalid actor.')
  return value
}

export function parseTimeRef(value: unknown): TimeEntryRef {
  const raw = string(value, 'reference')
  if (raw.startsWith('manual:') && /^manual:[^:]+$/.test(raw)) {
    return { source: 'manual', id: raw.slice(7) }
  }
  if (raw.startsWith('group:') && /^group:[^:]+$/.test(raw)) {
    return { source: 'group', id: raw.slice(6) }
  }
  const match = /^auto:([^:]+):(\d{4}-\d{2}-\d{2})$/.exec(raw)
  if (match) return { source: 'auto', sessionId: match[1], day: match[2] }
  return invalid('Invalid entry reference.')
}

export function timeRef(entry: TimeEntry): string {
  return entry.source === 'auto' ? `auto:${entry.sessionId}:${entry.day}` :
    `${entry.source}:${entry.id}`
}

function card(entry: TimeEntry) {
  return { ref: timeRef(entry), source: entry.source, day: entry.day,
    description: entry.description, issueKey: entry.issueKey, durationMs: entry.durationMs }
}

export interface TimeCliDispatchDeps {
  service: TimeTrackingService
  db: DatabaseSync
  groups: TimeEntryGroupRepo
  now(): number
  zone(): string
  scannerReady(): Promise<void>
  changed(): void
  isSynced(ref: string): boolean
}

export function createTimeCliDispatcher(deps: TimeCliDispatchDeps) {
  const writes: number[] = []
  const dayFor = (ref: TimeEntryRef): string => {
    if (ref.source === 'auto') return ref.day
    if (ref.source === 'group') {
      const group = deps.groups.get(ref.id)
      if (!group) return invalid('Unknown group.')
      return group.day
    }
    const row = deps.db.prepare('SELECT day FROM time_entry_manual WHERE id = ?').get(ref.id) as
      { day: string } | undefined
    if (!row) return invalid('Unknown entry.')
    return row.day
  }
  const find = (entries: TimeEntry[], ref: string): TimeEntry => {
    const found = entries.flatMap(entry => entry.source === 'group'
      ? [entry, ...entry.members] : [entry]).find(entry => timeRef(entry) === ref)
    if (!found) return invalid('Entry is hidden or missing.')
    return found
  }
  const affected = (ref: string, entry: TimeEntry): void => {
    if (deps.isSynced(ref)) forbidden()
    if (entry.source === 'group') for (const member of entry.members) {
      if (deps.isSynced(timeRef(member))) forbidden()
    }
    // A member mutation also changes its enclosing group total.
    const parsed = parseTimeRef(ref)
    if (parsed.source !== 'group') {
      const identity = parsed.source === 'auto' ? `${parsed.sessionId}:${parsed.day}` : parsed.id
      for (const group of deps.groups.listByDays([entry.day])) {
        if (group.members.some(member => member.source === parsed.source && member.id === identity) &&
          (deps.isSynced(`group:${group.id}`) || group.members.some(member => {
            const memberRef = member.source === 'auto' ? `auto:${member.id}` : `manual:${member.id}`
            return deps.isSynced(memberRef)
          }))) forbidden()
      }
    }
  }
  return async (raw: unknown, alive: () => boolean = () => true): Promise<Result> => {
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('Invalid request.')
      const input = raw as Input
      const command = input.command
      if (!TIME_CLI_ROUTES.includes(command as Command)) invalid('Unknown command.')
      const cmd = command as Command
      if (cmd !== 'list') actor(input.actor)
      await deps.scannerReady()
      if (!alive()) return { code: 1, error: 'Request timed out.' }
      const now = deps.now()
      const zone = deps.zone()
      if (cmd === 'list') {
        const day = validDay(input.day, now, zone)
        const entries = await deps.service.getDay(day)
        if (!alive()) return { code: 1, error: 'Request timed out.' }
        return { code: 0, value: entries.map(card) }
      }
      const who = actor(input.actor)
      let refs: TimeEntryRef[] = []
      let day: string
      if (cmd === 'add') day = validDay(input.day, now, zone)
      else {
        refs = cmd === 'group' ? (Array.isArray(input.refs) ? input.refs :
          invalid('Group requires references.')).map(parseTimeRef) : [parseTimeRef(input.ref)]
        if (cmd === 'group' && refs.length < 2) invalid('Group requires two entries.')
        if (cmd === 'group' && (refs.some(ref => ref.source === 'group') ||
          new Set(input.refs as string[]).size !== refs.length)) invalid('Invalid group members.')
        if (cmd === 'ungroup' && refs[0].source !== 'group') invalid('Ungroup requires a group.')
        day = validDay(dayFor(refs[0]), now, zone)
        for (const ref of refs.slice(1)) {
          if (validDay(dayFor(ref), now, zone) !== day) invalid('Entries must share a day.')
        }
      }
      const beforeDay = await deps.service.getDay(day)
      if (!alive()) return { code: 1, error: 'Request timed out.' }
      const before = refs.map(ref => {
        const text = ref.source === 'auto' ? `auto:${ref.sessionId}:${ref.day}` :
          `${ref.source}:${ref.id}`
        const entry = find(beforeDay, text)
        affected(text, entry)
        return card(entry)
      })
      let next: TimeEntryUpdate | undefined
      if (cmd === 'add') next = { description: description(input.description),
        durationMs: duration(input.duration), issueKey: input.issue === undefined ? null : issue(input.issue) }
      if (cmd === 'edit') {
        if (input.duration === undefined && input.description === undefined &&
          input.issue === undefined && input.noIssue !== true) invalid('Edit needs a change.')
        if (input.issue !== undefined && input.noIssue === true) invalid('Choose one issue option.')
        next = { description: input.description === undefined ? before[0].description :
          description(input.description), durationMs: input.duration === undefined ?
            before[0].durationMs : duration(input.duration), issueKey: input.noIssue === true ?
            null : input.issue === undefined ? before[0].issueKey : issue(input.issue) }
      }
      if (cmd === 'group') {
        if (input.description !== undefined) description(input.description)
        if (input.issue !== undefined) issue(input.issue)
      }
      while (writes.length && writes[0] <= now - 60_000) writes.shift()
      if (writes.length >= 60) return { code: 4, error: 'Write limit reached.' }
      if (!alive()) return { code: 1, error: 'Request timed out.' }
      let ref = refs[0] ? (refs[0].source === 'auto' ?
        `auto:${refs[0].sessionId}:${refs[0].day}` : `${refs[0].source}:${refs[0].id}`) : ''
      let after: unknown = null
      tx(deps.db, () => {
        if (cmd === 'add') {
          const entry = deps.service.addManual({ day, ...next! })
          ref = timeRef(entry)
          after = card(entry)
        } else if (cmd === 'edit') {
          deps.service.updateEntryPrepared(refs[0], next!)
          after = { ref, ...next }
        } else if (cmd === 'delete') deps.service.deleteEntryPrepared(refs[0])
        else if (cmd === 'group') {
          const id = (() => {
            try { return deps.service.groupEntries(refs) }
            catch { return invalid('Cards cannot be grouped.') }
          })()
          ref = `group:${id}`
          if (input.description !== undefined || input.issue !== undefined) {
            deps.service.updateGroup(id, { description: input.description === undefined ? undefined :
              description(input.description), issueKey: input.issue === undefined ? undefined :
                issue(input.issue) })
          }
          const group = deps.groups.get(id)!
          after = { ref, source: 'group', day, description: group.description,
            issueKey: group.issueKey, durationMs: group.durationOverrideMs ??
              before.reduce((sum, entry) => sum + entry.durationMs, 0) }
        } else if (cmd === 'ungroup') {
          deps.service.ungroup((refs[0] as Extract<TimeEntryRef, { source: 'group' }>).id)
          const group = beforeDay.find(entry => timeRef(entry) === ref)
          after = group?.source === 'group' ? group.members.map(card) : null
        }
        deps.db.prepare(`INSERT INTO time_entry_audit
          (created_at, actor, action, ref, before_json, after_json) VALUES (?,?,?,?,?,?)`)
          .run(now, who, cmd === 'delete' && refs[0].source === 'group' ? 'delete-group' : cmd,
            ref, before.length ? JSON.stringify(before.length === 1 ? before[0] : before) : null,
            after === null ? null : JSON.stringify(after))
      })
      writes.push(now)
      deps.changed()
      return { code: 0, value: { ref } }
    } catch (error) {
      if (error instanceof CliError) return { code: error.code, error: error.message }
      return { code: 1, error: 'The time entry could not be changed.' }
    }
  }
}
