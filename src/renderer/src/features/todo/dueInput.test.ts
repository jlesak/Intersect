import { describe, expect, test } from 'vitest'
import { parseDueFromText } from './dueInput'

// 2026-08-07 is a Friday. Every case below is read against that day.
const FRIDAY = '2026-08-07'

const parse = (text: string, today = FRIDAY) => parseDueFromText(text, today)

describe('parseDueFromText', () => {
  test('text with no date word is left exactly as typed', () => {
    expect(parse('call the vendor')).toEqual({ text: 'call the vendor', dueDay: null })
  })

  test('"today" resolves to today and leaves the task text behind', () => {
    expect(parse('file the report today')).toEqual({ text: 'file the report', dueDay: FRIDAY })
  })

  test('"tomorrow" resolves to the next day', () => {
    expect(parse('call the vendor tomorrow')).toEqual({
      text: 'call the vendor',
      dueDay: '2026-08-08'
    })
  })

  test('a weekday later this week resolves inside the week', () => {
    // Friday -> Sunday is two days on.
    expect(parse('write it up sunday')).toEqual({ text: 'write it up', dueDay: '2026-08-09' })
  })

  test('a weekday abbreviation works like the full name', () => {
    expect(parse('write it up sun')).toEqual({ text: 'write it up', dueDay: '2026-08-09' })
  })

  test('naming today’s own weekday means next week, not today', () => {
    // Said on a Friday, "fri" is the Friday you have not had yet.
    expect(parse('retro fri')).toEqual({ text: 'retro', dueDay: '2026-08-14' })
  })

  test('a weekday already past this week rolls into the next one', () => {
    // Friday -> Monday is three days on, never three days back.
    expect(parse('standup mon')).toEqual({ text: 'standup', dueDay: '2026-08-10' })
  })

  test('the date word is recognised whatever its case', () => {
    expect(parse('call them TOMORROW')).toEqual({ text: 'call them', dueDay: '2026-08-08' })
    expect(parse('call them Tomorrow')).toEqual({ text: 'call them', dueDay: '2026-08-08' })
  })

  test('only a trailing date word counts, so ordinary words survive', () => {
    expect(parse('tomorrow is the deadline')).toEqual({
      text: 'tomorrow is the deadline',
      dueDay: null
    })
    expect(parse('friday retro prep')).toEqual({ text: 'friday retro prep', dueDay: null })
  })

  test('a task that is only a date word keeps its text and gets no due day', () => {
    // Stripping would leave nothing to add; a task called "tomorrow" is a real thing to write.
    expect(parse('tomorrow')).toEqual({ text: 'tomorrow', dueDay: null })
    expect(parse('  fri  ')).toEqual({ text: 'fri', dueDay: null })
  })

  test('surrounding whitespace never leaks into the task text', () => {
    expect(parse('   call the vendor   tomorrow  ')).toEqual({
      text: 'call the vendor',
      dueDay: '2026-08-08'
    })
  })

  test('a word merely ending in a date word is not a date', () => {
    expect(parse('plan the funday')).toEqual({ text: 'plan the funday', dueDay: null })
  })

  test('empty input is answered without inventing a task or a date', () => {
    expect(parse('   ')).toEqual({ text: '', dueDay: null })
  })

  test('crossing a month boundary produces the next month’s key', () => {
    // 2026-08-31 is a Monday; "tue" is the first of September.
    expect(parse('review tue', '2026-08-31')).toEqual({ text: 'review', dueDay: '2026-09-01' })
  })
})
