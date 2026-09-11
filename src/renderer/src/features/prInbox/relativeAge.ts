/**
 * Compact relative age (e.g. "3d ago", "2h ago", "just now") from an epoch-ms timestamp.
 *
 * Held to a number and a unit because it is read in a table column beside five other cells: a
 * calendar date would be wider than the column and would still have to be subtracted in the reader's
 * head. `now` is passed in rather than read from the clock, so every row of one render is dated
 * against the same instant.
 */
export function relativeAge(at: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - at) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}
