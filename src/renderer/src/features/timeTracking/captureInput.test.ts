import { describe, expect, test } from 'vitest'
import { parseTimeCapture } from './captureInput'

describe('parseTimeCapture', () => {
  test('a bare duration is enough to log against no issue', () => {
    expect(parseTimeCapture('30m')).toEqual({ durationMs: 1_800_000, issueKey: null, description: '' })
  })

  test('an issue key after the duration is recognised and uppercased', () => {
    expect(parseTimeCapture('30m fid-123')).toEqual({
      durationMs: 1_800_000,
      issueKey: 'FID-123',
      description: ''
    })
  })

  test('whatever follows is the description', () => {
    expect(parseTimeCapture('30m FID-123 sprint review')).toEqual({
      durationMs: 1_800_000,
      issueKey: 'FID-123',
      description: 'sprint review'
    })
  })

  test('a description with no issue key is still a description', () => {
    expect(parseTimeCapture('45m team sync')).toEqual({
      durationMs: 2_700_000,
      issueKey: null,
      description: 'team sync'
    })
  })

  test('a two-token duration is read as one duration, not a duration and a description', () => {
    expect(parseTimeCapture('1h 30m FID-123 review')).toEqual({
      durationMs: 5_400_000,
      issueKey: 'FID-123',
      description: 'review'
    })
  })

  test('the single-token duration forms the board already accepts all work here', () => {
    expect(parseTimeCapture('1h30m x')?.durationMs).toBe(5_400_000)
    expect(parseTimeCapture('2h x')?.durationMs).toBe(7_200_000)
    expect(parseTimeCapture('90 x')?.durationMs).toBe(5_400_000)
    expect(parseTimeCapture('1:30 x')?.durationMs).toBe(5_400_000)
  })

  test('a bare number after an hour count is description, not minutes', () => {
    // "1 on 1 with Marek" opens with a number; reading it as minutes would both inflate the span
    // and eat the first word of what the time was spent on.
    expect(parseTimeCapture('1h 1 on 1 with Marek')).toEqual({
      durationMs: 3_600_000,
      issueKey: null,
      description: '1 on 1 with Marek'
    })
    expect(parseTimeCapture('2h 3 amigos session')).toEqual({
      durationMs: 7_200_000,
      issueKey: null,
      description: '3 amigos session'
    })
  })

  test('text that does not start with a duration is not a worklog entry', () => {
    expect(parseTimeCapture('sprint review')).toBeNull()
    expect(parseTimeCapture('')).toBeNull()
    expect(parseTimeCapture('FID-123 30m')).toBeNull()
  })

  test('a zero duration is refused - a card that took no time is not a card', () => {
    expect(parseTimeCapture('0m meeting')).toBeNull()
  })

  test('a word that merely looks issue-shaped is left in the description', () => {
    // No digits after the dash, so it is a hyphenated word, not a key.
    expect(parseTimeCapture('30m follow-up call')).toEqual({
      durationMs: 1_800_000,
      issueKey: null,
      description: 'follow-up call'
    })
  })

  test('extra whitespace never reaches the description', () => {
    expect(parseTimeCapture('  30m   FID-123   sprint   review  ')).toEqual({
      durationMs: 1_800_000,
      issueKey: 'FID-123',
      description: 'sprint review'
    })
  })
})
