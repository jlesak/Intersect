import { addDays, dateOfDayKey, dayKeyOf, weekStartOf } from '@common/week'

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

const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * Whether a `yyyy-mm-dd` string names a day that exists. Date arithmetic rolls a made-up day into
 * a real one (the 31st of February becomes March), so the round trip is what catches it.
 */
function isRealDay(dayKey: string): boolean {
  return dayKeyOf(dateOfDayKey(dayKey).getTime()) === dayKey
}

/**
 * A relative offset: `3d` is three days out, `2w` is two weeks. Zero and negative values name no
 * day, because a due date silently set in the past or on nothing is worse than none at all, and
 * the ranges stop a stray number from pinning a task to the next century.
 *
 * There is no `Nm` and no `Ny`: month and year arithmetic has no honest answer at month ends.
 */
function dayOffsetOut(word: string, today: string): string | null {
  const days = /^(\d{1,3})d$/.exec(word)
  if (days) {
    const n = Number(days[1])
    return n >= 1 && n <= 365 ? addDays(today, n) : null
  }

  const weeks = /^(\d{1,2})w$/.exec(word)
  if (weeks) {
    const n = Number(weeks[1])
    return n >= 1 && n <= 52 ? addDays(today, n * 7) : null
  }

  return null
}

/**
 * A date written out rather than named.
 *
 * `yyyy-mm-dd` is the app's own day key and means exactly one day, so it is honoured as typed,
 * past days included. `d.m` (padding and a trailing dot optional) is the form the rows themselves
 * print, so a user can type back what they read; it means the coming occurrence of that day,
 * rolling into next year once it has passed.
 *
 * `d/m` is refused. The slash form reads as two different days depending on where the person
 * writing it grew up, and guessing wrong would set a deadline nobody typed.
 */
function dayWritten(word: string, today: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(word)) return isRealDay(word) ? word : null

  const dayMonth = /^(\d{1,2})\.(\d{1,2})\.?$/.exec(word)
  if (!dayMonth) return null

  const day = pad(Number(dayMonth[1]))
  const month = pad(Number(dayMonth[2]))
  const year = Number(today.slice(0, 4))
  const thisYear = `${year}-${month}-${day}`
  if (!isRealDay(thisYear)) return null
  if (thisYear >= today) return thisYear

  const nextYear = `${year + 1}-${month}-${day}`
  return isRealDay(nextYear) ? nextYear : null
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
  if (target !== undefined) {
    const current = dateOfDayKey(today).getDay()
    return addDays(today, ((target - current + 6) % 7) + 1)
  }

  return dayOffsetOut(word, today) ?? dayWritten(word, today)
}

/**
 * The day "next <weekday>" names: that weekday inside the week after the one containing today,
 * on the Monday-started week the rest of the app already runs on.
 *
 * It can never land earlier than the bare weekday, and on the named weekday itself the two agree.
 * Reading the phrase whole is also what keeps "call the vendor next tue" from leaving behind a
 * task called "call the vendor next".
 */
function dayNamedNextWeek(first: string, second: string, today: string): string | null {
  if (first !== 'next') return null
  const target = WEEKDAYS[second]
  if (target === undefined) return null

  const nextWeekStart = addDays(weekStartOf(dateOfDayKey(today).getTime()), 7)
  // Days into a Monday-started week: Monday is 0, Sunday its last day.
  return addDays(nextWeekStart, (target + 6) % 7)
}

/** A task's text and the due day its wording named, if any. */
export interface ParsedDue {
  text: string
  dueDay: string | null
}

/**
 * The task with its trailing date words removed. Text that is nothing but a date keeps every word
 * and gets no due day, because stripping would leave nothing to add and "tomorrow" is a real
 * thing to write down.
 */
function withoutTail(words: string[], tail: number, dueDay: string, text: string): ParsedDue {
  const kept = words.slice(0, words.length - tail).join(' ')
  return kept === '' ? { text, dueDay: null } : { text: kept, dueDay }
}

/**
 * Reads a due date off the end of typed task text - "call the vendor tomorrow", "retro next fri",
 * "ship it 3d", "pay it 12.11" - and hands back the task without it.
 *
 * Only a trailing date is treated as one, so "tomorrow is the deadline" stays a task about
 * tomorrow rather than a task called "is the deadline". The two-word phrase is tried before the
 * single word, so "next fri" wins over the bare "fri" inside it. Anything that matches nothing is
 * kept exactly as typed: this is a task box first, and it never refuses what it was given.
 */
export function parseDueFromText(raw: string, today: string): ParsedDue {
  const text = raw.trim().replace(/\s+/g, ' ')
  if (text === '') return { text: '', dueDay: null }

  const words = text.split(' ')
  const lower = words.map((word) => word.toLowerCase())
  const last = lower.length - 1

  const phrase = last >= 1 ? dayNamedNextWeek(lower[last - 1], lower[last], today) : null
  if (phrase !== null) return withoutTail(words, 2, phrase, text)

  const single = dayNamed(lower[last], today)
  if (single !== null) return withoutTail(words, 1, single, text)

  return { text, dueDay: null }
}
