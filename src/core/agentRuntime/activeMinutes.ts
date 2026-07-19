import { dayKeyOf } from '@common/week'

/** Gaps between consecutive activity pings longer than this count as idle and are capped here. */
export const IDLE_CAP_MS = 10 * 60 * 1000

/**
 * Capped-gap active minutes grouped by local calendar day. For each consecutive pair of pings
 * the elapsed time - capped at `idleCapMs` - is credited to the local day of the EARLIER ping;
 * a non-positive gap contributes nothing. Per-day milliseconds are summed and rounded to whole
 * minutes exactly once, so a day whose activity rounds to under a minute drops out entirely. A
 * lone or empty ping list has no measurable duration and yields an empty map.
 *
 * A gap that straddles midnight is credited whole to the earlier day; because gaps are capped at
 * ten minutes the misattribution is bounded and accepted. The cap is a default ceiling, not proof
 * of real human activity - this is agent runtime evidence, never a human worklog.
 */
export function activeMinutesByDate(pings: number[], idleCapMs: number): Map<string, number> {
  const sorted = [...pings].sort((a, b) => a - b)
  const msByDate = new Map<string, number>()
  for (let i = 1; i < sorted.length; i++) {
    const gap = Math.min(sorted[i] - sorted[i - 1], idleCapMs)
    if (gap <= 0) continue
    const date = dayKeyOf(sorted[i - 1])
    msByDate.set(date, (msByDate.get(date) ?? 0) + gap)
  }
  const minutesByDate = new Map<string, number>()
  for (const [date, ms] of msByDate) {
    const minutes = Math.round(ms / 60000)
    if (minutes >= 1) minutesByDate.set(date, minutes)
  }
  return minutesByDate
}
