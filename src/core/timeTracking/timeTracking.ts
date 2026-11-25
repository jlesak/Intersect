import type {
  NewManualTimeEntry,
  RunningTimer,
  TimeEntry,
  TimeEntryRef,
  TimeEntryUpdate
} from '@common/domain'
import { dayKeyOf, weekdayKeys } from '@common/week'
import type {
  ManualTimeEntryRepo,
  RunningTimerRepo,
  TimeOverrideRepo
} from '../db/timeTrackingRepo'
import type { TimeTrackingSettings } from '@common/domain'
import type { TimeSessionDay, TimeSessionDayRepo } from '../db/timeSessionDayRepo'
import type { SessionSnapshots } from './sessionSnapshots'
import { insideAppData } from './exclusions'
import { issueKeyFromBranch } from './issueKey'
import type { GroupMember, TimeEntryGroupRepo } from '../db/timeEntryGroupRepo'

export interface TimeTrackingDeps {
  snapshots: TimeSessionDayRepo
  scanner: SessionSnapshots
  isResumable(sessionId: string): Promise<boolean>
  settings(): TimeTrackingSettings
  userDataDir: string
  manual: ManualTimeEntryRepo
  overrides: TimeOverrideRepo
  timer: RunningTimerRepo
  groups?: TimeEntryGroupRepo
  /** Injected so timer tests can advance the clock instead of sleeping. */
  now: () => number
  /**
   * Run several writes as one all-or-nothing unit. Stopping the timer both clears the running row
   * and logs the span, and a half-applied stop would destroy time the user actually worked.
   */
  atomically: <T>(fn: () => T) => T
}

/**
 * The weekly worklog board's read/write model. A week is the five weekdays starting at a Monday
 * day key; auto entries come from persisted daily snapshots with user edits applied on top.
 * Weekend snapshots remain stored but have no card or share in the weekday totals.
 */
export interface TimeTrackingService {
  getWeek(weekStart: string): Promise<TimeEntry[]>
  /** Force a session re-scan from disk, then return the fresh week. */
  refreshWeek(weekStart: string): Promise<TimeEntry[]>
  addManual(input: NewManualTimeEntry): TimeEntry
  updateEntry(ref: TimeEntryRef, update: TimeEntryUpdate): Promise<TimeEntry>
  deleteEntry(ref: TimeEntryRef): Promise<void>
  groupEntries(refs: TimeEntryRef[]): string
  groupDayByIssue(day: string): string[]
  updateGroup(id: string, update: Partial<TimeEntryUpdate>): void
  ungroup(id: string): void
  /** The timer currently running, or null. */
  getRunningTimer(): RunningTimer | null
  /** Begin timing now. Refuses when one is already running. */
  startTimer(description: string, issueKey: string | null): RunningTimer
  /** Re-attribute a running timer without disturbing what it has measured. */
  updateTimer(description: string, issueKey: string | null): RunningTimer
  /**
   * Stop timing and log the elapsed span as a manual entry on the day it was stopped. Returns
   * null when nothing was running, or when the span was too short to be real work.
   */
  stopTimer(): TimeEntry | null
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/
const validDay = (day: string): boolean => typeof day === 'string' && DAY_KEY.test(day) &&
  Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day

/**
 * The renderer form validates too, but persisted garbage would surface as wrong totals or as
 * rows on no visible day, so the write path enforces its own invariants.
 */
function assertDuration(durationMs: number): void {
  if (!Number.isInteger(durationMs) || durationMs <= 0) {
    throw new Error('The logged time must be a positive duration')
  }
}

/**
 * Below this, a start followed immediately by a stop is a misclick rather than work. Logging it
 * would put a zero-length row on the board for the user to hunt down and delete.
 */
const MIN_TIMED_MS = 1_000

/** A row is never logged unlabelled: the issue key stands in, and failing that a neutral label. */
function timedDescription(description: string, issueKey: string | null): string {
  const trimmed = description.trim()
  if (trimmed) return trimmed
  return issueKey ?? 'Timed work'
}

export function createTimeTracking(deps: TimeTrackingDeps): TimeTrackingService {
  const key = (sessionId: string, day: string) => `${sessionId}:${day}`
  const toEntry = async (row: TimeSessionDay): Promise<TimeEntry> => {
    const override = deps.overrides.get(row.sessionId, row.day)
    const resumable = await deps.isResumable(row.sessionId)
    return { id: key(row.sessionId, row.day), source: 'auto', day: row.day,
      sessionId: row.sessionId, cwd: row.cwd, resumable,
      isWork: row.isWork, workConfirmed: row.workConfirmed,
      firstTimestamp: row.firstTimestamp, lastTimestamp: row.lastTimestamp,
      description: override?.description ?? row.summary ?? row.autoDescription,
      issueKey: override ? override.issueKey : issueKeyFromBranch(row.gitBranch),
      durationMs: override ? override.durationMs : row.activeDurationMs }
  }

  function validateRef(ref: TimeEntryRef): void {
    if (!ref || typeof ref !== 'object') throw new Error('Invalid entry reference')
    if (ref.source === 'manual' && typeof ref.id === 'string' && ref.id) return
    if (ref.source === 'group' && typeof ref.id === 'string' && ref.id) return
    if (ref.source === 'auto' && typeof ref.sessionId === 'string' && ref.sessionId &&
      validDay(ref.day)) return
    throw new Error('Invalid entry reference')
  }

  async function findSnapshot(ref: Extract<TimeEntryRef, { source: 'auto' }>) {
    await deps.scanner.ready()
    const row = deps.snapshots.get(ref.sessionId, ref.day)
    if (!row) throw new Error(`Unknown session day: ${ref.sessionId}:${ref.day}`)
    return row
  }

  async function getDays(days: string[]): Promise<TimeEntry[]> {
    await deps.scanner.ready()
    const prefixes = deps.settings().excludedPathPrefixes
    const rows = deps.snapshots.listByDays(days).filter(row =>
      row.activeDurationMs >= 300_000 && !deps.overrides.get(row.sessionId, row.day)?.deleted &&
      !insideAppData(row.cwd, deps.userDataDir) && !prefixes.some(prefix => row.cwd.startsWith(prefix)))
    rows.sort((a, b) => a.day.localeCompare(b.day) || a.lastTimestamp - b.lastTimestamp ||
      a.sessionId.localeCompare(b.sessionId))
    const singles = [...await Promise.all(rows.map(toEntry)), ...deps.manual.listByDays(days)]
      .sort((a, b) => a.day.localeCompare(b.day))
    if (!deps.groups) return singles
    const byIdentity = new Map(singles.map(entry => [identity(entry), entry]))
    const hidden = new Set<string>()
    const grouped: TimeEntry[] = []
    for (const group of deps.groups.listByDays(days)) {
      const members = group.members.map(member => byIdentity.get(`${member.source}:${member.id}`))
      // An exclusion hides the whole group shell, including its stored description and totals.
      // Visible members appear as singles while membership remains intact for restoration.
      if (members.length < 2 || members.some(member => !member)) continue
      for (const member of group.members) hidden.add(`${member.source}:${member.id}`)
      grouped.push({ id: group.id, source: 'group', day: group.day,
        description: group.description, issueKey: group.issueKey,
        durationMs: group.durationOverrideMs ?? members.reduce((sum, member) =>
          sum + member!.durationMs, 0),
        members: members as Exclude<TimeEntry, { source: 'group' }>[] })
    }
    return [...singles.filter(entry => !hidden.has(identity(entry))), ...grouped]
      .sort((a, b) => a.day.localeCompare(b.day))
  }

  const getWeek = (weekStart: string): Promise<TimeEntry[]> => getDays(weekdayKeys(weekStart))

  function identity(entry: TimeEntry): string {
    return `${entry.source}:${entry.id}`
  }

  function memberRef(ref: TimeEntryRef): GroupMember {
    if (ref.source === 'group') throw new Error('A group cannot join another group')
    return { source: ref.source, id: ref.source === 'auto' ? key(ref.sessionId, ref.day) : ref.id }
  }

  function buildGroup(entries: TimeEntry[]): string {
    if (!deps.groups) throw new Error('Time entry groups unavailable')
    if (entries.length < 2 || entries.some(entry => entry.source === 'group')) {
      throw new Error('Select at least two ungrouped cards')
    }
    const day = entries[0].day
    if (entries.some(entry => entry.day !== day)) throw new Error('A group cannot span days')
    const description = [...new Set(entries.map(entry => entry.description))].join('; ').slice(0, 255)
    const issueKey = entries.every(entry => entry.issueKey === entries[0].issueKey)
      ? entries[0].issueKey : null
    const row = deps.groups.create(day, description, issueKey,
      entries.map(entry => ({ source: entry.source as 'auto' | 'manual', id: entry.id })))
    return row.id
  }

  function visibleEntry(ref: TimeEntryRef): TimeEntry | undefined {
    if (ref.source === 'group') throw new Error('A group cannot join another group')
    if (deps.groups?.hasMember(memberRef(ref))) throw new Error('A card is already grouped')
    if (ref.source === 'manual') return deps.manual.get(ref.id)
    const row = deps.snapshots.get(ref.sessionId, ref.day)
    const prefixes = deps.settings().excludedPathPrefixes
    if (!row || row.activeDurationMs < 300_000 ||
      deps.overrides.get(ref.sessionId, ref.day)?.deleted ||
      insideAppData(row.cwd, deps.userDataDir) ||
      prefixes.some(prefix => row.cwd.startsWith(prefix))) {
      return undefined
    }
    const override = deps.overrides.get(ref.sessionId, ref.day)
    return { id: key(ref.sessionId, ref.day), source: 'auto', day: ref.day,
      sessionId: ref.sessionId, cwd: row.cwd, resumable: false,
      isWork: row.isWork, workConfirmed: row.workConfirmed,
      firstTimestamp: row.firstTimestamp, lastTimestamp: row.lastTimestamp,
      description: override?.description ?? row.summary ?? row.autoDescription,
      issueKey: override ? override.issueKey : issueKeyFromBranch(row.gitBranch),
      durationMs: override ? override.durationMs : row.activeDurationMs }
  }

  return {
    getWeek,

    groupEntries(refs) {
      if (!Array.isArray(refs) || refs.length < 2) throw new Error('Select at least two cards')
      refs.forEach(validateRef)
      const wanted = refs.map(memberRef)
      if (new Set(wanted.map(member => `${member.source}:${member.id}`)).size !== wanted.length) {
        throw new Error('Duplicate group member')
      }
      return deps.atomically(() => {
        const entries = refs.map(visibleEntry)
        if (entries.some(entry => !entry)) throw new Error('A card is hidden or missing')
        return buildGroup(entries as TimeEntry[])
      })
    },

    groupDayByIssue(day) {
      if (!validDay(day)) throw new Error(`Not a day: ${day}`)
      return deps.atomically(() => {
        const refs: TimeEntryRef[] = [
          ...deps.snapshots.listByDays([day]).map(row => ({ source: 'auto' as const,
            sessionId: row.sessionId, day })),
          ...deps.manual.listByDays([day]).map(entry => ({ source: 'manual' as const,
            id: entry.id }))
        ]
        const byKey = new Map<string, TimeEntry[]>()
        for (const ref of refs) {
          if (deps.groups?.hasMember(memberRef(ref))) continue
          const entry = visibleEntry(ref)
          if (!entry) continue
          if (!entry.issueKey || entry.source === 'auto' && entry.isWork === false) continue
          byKey.set(entry.issueKey, [...byKey.get(entry.issueKey) ?? [], entry])
        }
        return [...byKey.values()].filter(group => group.length >= 2).map(buildGroup)
      })
    },

    updateGroup(id, update) {
      if (!deps.groups) throw new Error('Time entry groups unavailable')
      if (update.description !== undefined && !update.description.trim())
        throw new Error('A description is required')
      if (update.durationMs !== undefined) assertDuration(update.durationMs)
      deps.atomically(() => deps.groups!.update(id, update))
    },

    ungroup(id) {
      if (!deps.groups?.get(id)) throw new Error(`Time entry group not found: ${id}`)
      deps.atomically(() => deps.groups!.remove(id))
    },

    async refreshWeek(weekStart) {
      await deps.scanner.scan()
      return getWeek(weekStart)
    },

    addManual(input) {
      if (!validDay(input.day)) throw new Error(`Not a day: ${input.day}`)
      if (!input.description.trim()) throw new Error('A description is required')
      assertDuration(input.durationMs)
      return deps.manual.create(input)
    },

    async updateEntry(ref, update) {
      validateRef(ref)
      if (ref.source === 'group') {
        this.updateGroup(ref.id, update)
        const row = deps.groups?.get(ref.id)
        return (await getDays([row!.day])).find(entry => entry.source === 'group' &&
          entry.id === ref.id)!
      }
      assertDuration(update.durationMs)
      if (!update.description.trim()) throw new Error('A description is required')
      if (ref.source === 'manual') return deps.manual.update(ref.id, update)
      const row = await findSnapshot(ref)
      const existing = deps.overrides.get(ref.sessionId, ref.day)
      const shownDescription = existing?.description ?? row.summary ?? row.autoDescription
      deps.overrides.upsert(ref.sessionId, ref.day, { ...update,
        // A time/key edit carries the displayed text in its payload. It is not an owner edit.
        description: update.description === shownDescription ? existing?.description ?? null :
          update.description,
        deleted: false })
      return toEntry(row)
    },

    async deleteEntry(ref) {
      validateRef(ref)
      if (ref.source === 'group') { this.ungroup(ref.id); return }
      if (ref.source === 'manual') {
        deps.atomically(() => { deps.groups?.removeMember(memberRef(ref)); deps.manual.remove(ref.id) })
        return
      }
      const row = await findSnapshot(ref)
      const existing = deps.overrides.get(ref.sessionId, ref.day)
      deps.atomically(() => {
        deps.groups?.removeMember(memberRef(ref))
        deps.overrides.upsert(ref.sessionId, ref.day, existing ? { ...existing, deleted: true } : {
          description: null, issueKey: issueKeyFromBranch(row.gitBranch),
          durationMs: row.activeDurationMs, deleted: true
        })
      })
    },

    getRunningTimer() {
      return deps.timer.get()
    },

    startTimer(description, issueKey) {
      return deps.timer.start(deps.now(), description, issueKey)
    },

    updateTimer(description, issueKey) {
      return deps.timer.update(description, issueKey)
    },

    stopTimer() {
      const running = deps.timer.get()
      if (!running) return null
      // One reading of the clock for both the span and the day, so they can never disagree.
      const stoppedAt = deps.now()
      const durationMs = stoppedAt - running.startedAt
      // Clearing the running row and logging what it measured is one indivisible act: if the entry
      // cannot be written the timer must keep running, never be silently thrown away.
      return deps.atomically(() => {
        deps.timer.clear()
        if (durationMs < MIN_TIMED_MS) return null
        // Attributed to the day it was stopped, so a span crossing midnight lands on one day rather
        // than being split across two - manual entries and timers retain their single-day behavior.
        return deps.manual.create({
          day: dayKeyOf(stoppedAt),
          description: timedDescription(running.description, running.issueKey),
          issueKey: running.issueKey,
          durationMs
        })
      })
    }
  }
}
