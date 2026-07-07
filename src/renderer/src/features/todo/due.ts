import { addDays, dateOfDayKey } from '@common/week'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * Whether a due day is past. Due today is NOT overdue - the day is not over yet. Day keys are
 * `yyyy-mm-dd`, so plain string comparison is exact.
 */
export function isOverdue(dueDay: string, today: string): boolean {
  return dueDay < today
}

/**
 * The row label for a due day, relative to today: "today", "tomorrow", "yesterday", else the
 * short weekday plus `dd.mm` (e.g. "Fri 03.07").
 */
export function formatDueDay(dueDay: string, today: string): string {
  if (dueDay === today) return 'today'
  if (dueDay === addDays(today, 1)) return 'tomorrow'
  if (dueDay === addDays(today, -1)) return 'yesterday'
  const d = dateOfDayKey(dueDay)
  return `${WEEKDAYS[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}`
}
