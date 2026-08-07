import { addDays, dateOfDayKey } from '@common/week'

/**
 * The day-of-week each accepted weekday word names, full form and the three-letter abbreviation
 * everyone actually types. Sunday is 0, matching `Date.getDay()`.
 */
const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6
}

/**
 * The day a single date word names, relative to today, or null when the word is not one.
 *
 * A weekday always means the next one still to come: said on a Friday, "fri" is the Friday you
 * have not had yet, not the one you are standing in. Someone writing a deadline is looking
 * forward, and a due date silently set in the past would be worse than no due date at all.
 */
function dayNamed(word: string, today: string): string | null {
  if (word === 'today') return today
  if (word === 'tomorrow') return addDays(today, 1)

  const target = WEEKDAYS[word]
  if (target === undefined) return null
  const current = dateOfDayKey(today).getDay()
  return addDays(today, ((target - current + 6) % 7) + 1)
}

/** A task's text and the due day its wording named, if any. */
export interface ParsedDue {
  text: string
  dueDay: string | null
}

/**
 * Reads a due date off the end of typed task text - "call the vendor tomorrow", "retro fri" -
 * and hands back the task without it.
 *
 * Only a trailing word is treated as a date, so "tomorrow is the deadline" stays a task about
 * tomorrow rather than a task called "is the deadline". Text consisting of nothing but a date
 * word is left alone for the same reason: stripping it would leave nothing to add.
 */
export function parseDueFromText(raw: string, today: string): ParsedDue {
  const text = raw.trim().replace(/\s+/g, ' ')
  const lastSpace = text.lastIndexOf(' ')
  if (lastSpace === -1) return { text, dueDay: null }

  const dueDay = dayNamed(text.slice(lastSpace + 1).toLowerCase(), today)
  return dueDay === null ? { text, dueDay: null } : { text: text.slice(0, lastSpace), dueDay }
}
