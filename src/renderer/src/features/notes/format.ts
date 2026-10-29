import { dateOfDayKey } from '@common/week'

const pad = (n: number): string => String(n).padStart(2, '0')

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** An entry's local capture time, `HH:MM` on a 24-hour clock. */
export function formatNoteTime(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** A history day's heading, `Monday 02.03.2026`. */
export function formatNoteDay(dayKey: string): string {
  const d = dateOfDayKey(dayKey)
  return `${WEEKDAYS[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`
}
