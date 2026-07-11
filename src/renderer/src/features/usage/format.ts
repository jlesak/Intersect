const pad = (n: number): string => String(n).padStart(2, '0')
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "HH:mm" in local time - the 5h session window resets same-day, so no date is needed. */
export function formatFiveHourReset(resetsAtSeconds: number): string {
  const d = new Date(resetsAtSeconds * 1000)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "Wkd DD.MM HH:mm" in local time - the weekly window resets days out, so the date matters. */
export function formatWeeklyReset(resetsAtSeconds: number): string {
  const d = new Date(resetsAtSeconds * 1000)
  return `${WEEKDAYS[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "HH:mm" in local time from an epoch-ms timestamp, for the panel's "as of" staleness hint. */
export function formatCapturedAt(capturedAtMs: number): string {
  const d = new Date(capturedAtMs)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Meter fill color: calm below 70% used, the accent hue through 90%, danger above it. */
export function usageMeterColor(usedPercent: number): string {
  if (usedPercent > 90) return 'var(--danger)'
  if (usedPercent >= 70) return 'var(--accent)'
  return 'var(--status-done)'
}
