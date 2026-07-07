/**
 * Local-calendar day and week helpers for the Time Tracking board. A day is identified by its
 * `yyyy-mm-dd` key in the user's local timezone and weeks start on Monday. All arithmetic goes
 * through local Date fields (never fixed 24h offsets), so a DST transition cannot shift a day.
 */

const pad = (n: number): string => String(n).padStart(2, '0')

/** The local `yyyy-mm-dd` day key for an epoch-ms timestamp. */
export function dayKeyOf(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The Date at local noon of a day key. Noon keeps day arithmetic clear of DST edges. */
export function dateOfDayKey(dayKey: string): Date {
  const [y, m, d] = dayKey.split('-').map(Number)
  return new Date(y, m - 1, d, 12)
}

/** The day key `n` days after the given one (negative moves back). */
export function addDays(dayKey: string, n: number): string {
  const d = dateOfDayKey(dayKey)
  return dayKeyOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12).getTime())
}

/** The Monday day key of the local week containing the timestamp. */
export function weekStartOf(ts: number): string {
  const d = new Date(ts)
  const sinceMonday = (d.getDay() + 6) % 7
  return dayKeyOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() - sinceMonday, 12).getTime())
}

/** The five weekday keys (Monday through Friday) of the week starting at the given Monday. */
export function weekdayKeys(weekStart: string): string[] {
  return [0, 1, 2, 3, 4].map((i) => addDays(weekStart, i))
}
