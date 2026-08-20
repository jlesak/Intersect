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

describe('parseDueFromText, "next <weekday>"', () => {
  test('it means the named day in the week after this one', () => {
    // 2026-08-03 is a Monday: bare "fri" is this week's, "next fri" is the one after.
    expect(parse('retro fri', '2026-08-03')).toEqual({ text: 'retro', dueDay: '2026-08-07' })
    expect(parse('retro next fri', '2026-08-03')).toEqual({ text: 'retro', dueDay: '2026-08-14' })
  })

  test('said on the named weekday itself, it agrees with the bare word', () => {
    // Both mean the Friday you have not had yet, so nothing surprising happens on a Friday.
    expect(parse('retro next fri')).toEqual({ text: 'retro', dueDay: '2026-08-14' })
  })

  test('the full weekday name works, whatever its case', () => {
    expect(parse('sync Next Tuesday', '2026-08-03')).toEqual({ text: 'sync', dueDay: '2026-08-11' })
  })

  test('Sunday lands at the end of that week, because weeks start on Monday', () => {
    expect(parse('rest next sun', '2026-08-03')).toEqual({ text: 'rest', dueDay: '2026-08-16' })
  })

  test('a trailing "next" no longer strands itself in the task text', () => {
    // The single-word rule alone would read "tue" and leave a task called "call the vendor next".
    expect(parse('call the vendor next tue', '2026-08-03')).toEqual({
      text: 'call the vendor',
      dueDay: '2026-08-11'
    })
  })

  test('"next" on its own is an ordinary word', () => {
    expect(parse('plan what comes next')).toEqual({ text: 'plan what comes next', dueDay: null })
  })

  test('a task that is only the phrase keeps both words and gets no due day', () => {
    expect(parse('next tue')).toEqual({ text: 'next tue', dueDay: null })
  })
})

describe('parseDueFromText, day and week offsets', () => {
  test('"Nd" is that many days out', () => {
    expect(parse('ship it 3d')).toEqual({ text: 'ship it', dueDay: '2026-08-10' })
  })

  test('"Nw" is that many weeks out', () => {
    expect(parse('follow up 2w')).toEqual({ text: 'follow up', dueDay: '2026-08-21' })
  })

  test('an offset is recognised whatever its case', () => {
    expect(parse('ship it 3D')).toEqual({ text: 'ship it', dueDay: '2026-08-10' })
    expect(parse('follow up 2W')).toEqual({ text: 'follow up', dueDay: '2026-08-21' })
  })

  test('an offset of zero or beyond the range names no day at all', () => {
    expect(parse('ship it 0d')).toEqual({ text: 'ship it 0d', dueDay: null })
    expect(parse('ship it 400d')).toEqual({ text: 'ship it 400d', dueDay: null })
    expect(parse('follow up 0w')).toEqual({ text: 'follow up 0w', dueDay: null })
    expect(parse('follow up 53w')).toEqual({ text: 'follow up 53w', dueDay: null })
  })

  test('an offset crossing the month boundary rolls the month', () => {
    expect(parse('ship it 3d', '2026-08-30')).toEqual({ text: 'ship it', dueDay: '2026-09-02' })
  })

  test('a task that is only an offset keeps its text and gets no due day', () => {
    expect(parse('3d')).toEqual({ text: '3d', dueDay: null })
  })

  test('a trailing "3d" is read as three days out even when it meant three dimensions', () => {
    // The known cost of the shorthand. The add box shows the resolved date before Enter is
    // pressed, so the reading is visible and another keystroke undoes it.
    expect(parse('render the logo in 3d')).toEqual({ text: 'render the logo in', dueDay: '2026-08-10' })
  })
})

describe('parseDueFromText, written-out dates', () => {
  test('an ISO day key is honoured exactly as typed', () => {
    expect(parse('launch 2026-09-01')).toEqual({ text: 'launch', dueDay: '2026-09-01' })
  })

  test('an ISO day key in the past is still honoured, because it cannot be a slip', () => {
    expect(parse('backfill 2026-01-05')).toEqual({ text: 'backfill', dueDay: '2026-01-05' })
  })

  test('an ISO-shaped string that names no real day is left in the text', () => {
    expect(parse('ticket 2026-13-45')).toEqual({ text: 'ticket 2026-13-45', dueDay: null })
  })

  test('the padded "dd.mm" the rows print means the coming occurrence of that day', () => {
    expect(parse('pay it 12.11')).toEqual({ text: 'pay it', dueDay: '2026-11-12' })
  })

  test('a written day already past this year rolls into the next one', () => {
    expect(parse('pay it 03.07')).toEqual({ text: 'pay it', dueDay: '2027-07-03' })
  })

  test('the trailing-dot form is accepted whether or not its parts are padded', () => {
    expect(parse('pay it 03.07.')).toEqual({ text: 'pay it', dueDay: '2027-07-03' })
    expect(parse('pay it 3.7.')).toEqual({ text: 'pay it', dueDay: '2027-07-03' })
  })

  test('today’s own date resolves to today rather than a year out', () => {
    expect(parse('pay it 07.08')).toEqual({ text: 'pay it', dueDay: FRIDAY })
  })

  test('a day that does not exist is left in the text', () => {
    expect(parse('pay it 31.02')).toEqual({ text: 'pay it 31.02', dueDay: null })
  })

  test('a bare two-part number is a version, and keeps both its digits and the title', () => {
    // Every one of these is a real day if the padding is ignored, which is why the padding is
    // not ignored: a trailing "1.2" is far more often a client version than the 1st of February.
    expect(parse('bump the client to 1.2')).toEqual({ text: 'bump the client to 1.2', dueDay: null })
    expect(parse('bump the client to 3.11')).toEqual({
      text: 'bump the client to 3.11',
      dueDay: null
    })
    expect(parse('bump the client to 22.4')).toEqual({
      text: 'bump the client to 22.4',
      dueDay: null
    })
    expect(parse('bump the client to 12.1')).toEqual({
      text: 'bump the client to 12.1',
      dueDay: null
    })
  })

  test('the same numbers name a day once they are written the way a date is', () => {
    expect(parse('bump the client to 1.2.')).toEqual({
      text: 'bump the client to',
      dueDay: '2027-02-01'
    })
    expect(parse('bump the client to 01.02')).toEqual({
      text: 'bump the client to',
      dueDay: '2027-02-01'
    })
  })

  test('the slash form is refused, because it means two different days', () => {
    expect(parse('pay it 3/7')).toEqual({ text: 'pay it 3/7', dueDay: null })
  })

  test('a task that is only a written date keeps its text and gets no due day', () => {
    expect(parse('2026-09-01')).toEqual({ text: '2026-09-01', dueDay: null })
    expect(parse('03.07')).toEqual({ text: '03.07', dueDay: null })
  })
})
