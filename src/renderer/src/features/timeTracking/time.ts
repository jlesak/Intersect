import type { TimeEntry } from '@common/domain'
import { addDays, dateOfDayKey } from '@common/week'
import { formatDuration } from '@renderer/features/sessions'

/**
 * Parse a user-typed duration into milliseconds, or null when the input is not a duration.
 * Accepted forms: `1h 30m`, `1h30m`, `2h`, `90m`, `90` (bare minutes), and `1:30` (h:mm).
 * Zero is not a duration: a card that took no time is a card to delete, not to log.
 */
export function parseDuration(raw: string): number | null {
  const input = raw.trim().toLowerCase()
  if (!input) return null

  const colon = /^(\d+):([0-5]?\d)$/.exec(input)
  const minutes = colon
    ? Number(colon[1]) * 60 + Number(colon[2])
    : (() => {
        const parts = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m?)?$/.exec(input)
        if (!parts || (parts[1] === undefined && parts[2] === undefined)) return null
        return Number(parts[1] ?? 0) * 60 + Number(parts[2] ?? 0)
      })()
  if (minutes === null || minutes === 0) return null
  return minutes * 60_000
}

/**
 * Canonicalize a user-typed issue key: trimmed and uppercased (issue keys are canonically
 * uppercase), with an empty input meaning "no issue" (null).
 */
export function normalizeIssueKey(raw: string): string | null {
  const key = raw.trim().toUpperCase()
  return key === '' ? null : key
}

/** Entries grouped by their day key; days without entries are simply absent. */
export function groupByDay(entries: TimeEntry[]): Map<string, TimeEntry[]> {
  const byDay = new Map<string, TimeEntry[]>()
  for (const entry of entries) {
    const group = byDay.get(entry.day)
    if (group) group.push(entry)
    else byDay.set(entry.day, [entry])
  }
  return byDay
}

/** The summed duration of a list of entries. */
export function totalMs(entries: TimeEntry[]): number {
  return entries.reduce((sum, e) => sum + e.durationMs, 0)
}

/** A total for display: `0m` when nothing is logged, else the shared h/m form. */
export function formatTotal(ms: number): string {
  return ms === 0 ? '0m' : formatDuration(ms)
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** A day column's date label, `dd.mm`. */
export function formatDayDate(dayKey: string): string {
  const d = dateOfDayKey(dayKey)
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`
}

/** The topbar's week range label, `dd.mm – dd.mm.yyyy` (Monday through Sunday). */
export function formatWeekRange(weekStart: string): string {
  const end = dateOfDayKey(addDays(weekStart, 6))
  return `${formatDayDate(weekStart)} – ${formatDayDate(addDays(weekStart, 6))}.${end.getFullYear()}`
}
