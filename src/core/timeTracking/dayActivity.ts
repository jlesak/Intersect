import { IDLE_CAP_MS } from '../agentRuntime/activeMinutes'

export interface SessionDayActivity {
  day: string
  firstTimestamp: number
  lastTimestamp: number
  activeDurationMs: number
}

export function trackingDayKey(timeZone: string): (timestamp: number) => string {
  const format = new Intl.DateTimeFormat('en', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  })
  return timestamp => {
    const parts = format.formatToParts(timestamp)
    const part = (type: string) => parts.find(p => p.type === type)!.value
    return `${part('year')}-${part('month')}-${part('day')}`
  }
}

/** A capped gap belongs wholly to its earlier message, including across midnight. */
export function activityByDay(
  timestamps: number[],
  dayKey: (timestamp: number) => string
): SessionDayActivity[] {
  const sorted = timestamps.filter(t => Number.isFinite(t) && t > 0).sort((a, b) => a - b)
  const days = new Map<string, SessionDayActivity>()
  for (let i = 0; i < sorted.length; i++) {
    const timestamp = sorted[i]
    const day = dayKey(timestamp)
    let row = days.get(day)
    if (!row) {
      row = { day, firstTimestamp: timestamp, lastTimestamp: timestamp, activeDurationMs: 0 }
      days.set(day, row)
    }
    row.lastTimestamp = timestamp
    if (i + 1 < sorted.length) row.activeDurationMs += Math.min(sorted[i + 1] - timestamp, IDLE_CAP_MS)
  }
  return [...days.values()]
}
