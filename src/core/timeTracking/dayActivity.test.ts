import { expect, test } from 'vitest'
import { parseSession } from '../sessions/sessionParse'
import { activityByDay, trackingDayKey } from './dayActivity'

const dayKey = trackingDayKey('Europe/Prague')
const ms = (values: string[]) => values.map(Date.parse)

test.each([
  [['2026-07-06T23:58:00+02:00', '2026-07-07T00:03:00+02:00'], [['2026-07-06', 300000], ['2026-07-07', 0]]],
  [['2026-07-06T10:00:00+02:00', '2026-07-09T10:00:00+02:00'], [['2026-07-06', 600000], ['2026-07-09', 0]]],
  [['2026-03-29T01:58:00+01:00', '2026-03-29T03:03:00+02:00'], [['2026-03-29', 300000]]],
  [['2026-10-25T02:58:00+02:00', '2026-10-25T02:03:00+01:00'], [['2026-10-25', 300000]]]
])('elapsed gaps across midnight, idle and DST: %j', (timestamps, expected) => {
  const values = ms(timestamps as string[])
  const days = activityByDay(values, dayKey)
  expect(days.map(d => [d.day, d.activeDurationMs])).toEqual(expected)
  for (const day of days) {
    const real = values.filter(t => dayKey(t) === day.day)
    expect(day.firstTimestamp).toBe(Math.min(...real))
    expect(day.lastTimestamp).toBe(Math.max(...real))
  }
})

test('duplicates, unordered and invalid timestamps never inflate measurement', () => {
  const start = Date.parse('2026-07-06T10:00:00+02:00')
  expect(activityByDay([start + 300000, NaN, start, 0, -1, Infinity, start], dayKey)).toEqual([
    { day: '2026-07-06', firstTimestamp: start, lastTimestamp: start + 300000, activeDurationMs: 300000 }
  ])
})

test('raw parser counts meta/tool-only/empty assistant records but not system or title timestamps', () => {
  const at = (minute: number) => new Date(Date.parse('2026-07-06T10:00:00+02:00') + minute * 60000).toISOString()
  const raw = [
    { type: 'user', timestamp: at(0), message: { content: 'Work' } },
    { type: 'user', timestamp: at(3), isMeta: true },
    { type: 'user', timestamp: at(6), message: { content: [{ type: 'tool_result' }] } },
    { type: 'assistant', timestamp: at(9) },
    { type: 'system', timestamp: at(30) },
    { type: 'ai-title', timestamp: at(40), aiTitle: 'Title' },
    { type: 'user', timestamp: 'invalid' }
  ].map(r => JSON.stringify(r)).concat('partial {', '', 'null')
  const parsed = parseSession('/fixture/session.jsonl', raw)
  const days = activityByDay(parsed.timestamps, dayKey)
  expect(parsed.timestamps).toHaveLength(4)
  expect(days[0].activeDurationMs).toBe(540000)
  expect(days.reduce((sum, d) => sum + d.activeDurationMs, 0)).toBe(parsed.summary.activeDurationMs)
})
