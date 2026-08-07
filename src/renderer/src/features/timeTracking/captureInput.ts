import { parseDuration } from './time'

/** A Jira issue key: a project part of at least two alphanumerics, a dash, and a number. */
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9]+-\d+$/

/** What a quick-capture line asked to be logged. */
export interface TimeCapture {
  durationMs: number
  issueKey: string | null
  description: string
}

/**
 * Reads a one-line worklog - `30m FID-123 sprint review` - into the fields a manual entry needs.
 * Returns null when the line does not open with a duration, which is the one part a worklog
 * cannot be guessed without.
 *
 * The duration comes first because it is the only field with a shape distinctive enough to find
 * anywhere else in the line; an issue key is optional and everything after it is free text. A
 * duration written as two words (`1h 30m`) is read as one, so the space someone naturally types
 * does not turn half the duration into the description.
 */
export function parseTimeCapture(raw: string): TimeCapture | null {
  const words = raw.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return null

  // Try the two-word duration first. `1h` parses on its own, so reading one word at a time would
  // always stop there and hand `30m` to the description - the space is exactly what someone types.
  const pair = words.length > 1 ? parseDuration(`${words[0]} ${words[1]}`) : null
  const durationMs = pair ?? parseDuration(words[0])
  if (durationMs === null) return null
  const rest = words.slice(pair === null ? 1 : 2)

  const hasKey = rest.length > 0 && ISSUE_KEY.test(rest[0])
  return {
    durationMs,
    issueKey: hasKey ? rest[0].toUpperCase() : null,
    description: (hasKey ? rest.slice(1) : rest).join(' ')
  }
}
