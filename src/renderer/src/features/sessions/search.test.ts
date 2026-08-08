import { describe, expect, test } from 'vitest'
import type { SessionSummary } from '@common/domain'
import { bestPromptMatch, scoreSession } from './search'

const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 's',
  filePath: '/p/s.jsonl',
  cwd: '/repos/spot',
  folderName: 'spot',
  title: 'Lock owner on the reservation card',
  gitBranch: null,
  firstTimestamp: 0,
  lastTimestamp: 1000,
  durationMs: 1000,
  activeDurationMs: 1000,
  messageCount: 2,
  userPrompts: [],
  ...over
})

describe('scoreSession', () => {
  test('matches a title the query is not a substring of', () => {
    // "lockres" appears nowhere contiguously; only a subsequence matcher finds it.
    expect(scoreSession('lockres', summary())).not.toBeNull()
  })

  test('rejects a query no field contains as a subsequence', () => {
    expect(scoreSession('zzq', summary())).toBeNull()
  })

  test('matches on a prompt the title says nothing about', () => {
    const s = summary({ userPrompts: ['first', 'make the importer idempotent'] })
    expect(scoreSession('idempotent', s)).not.toBeNull()
  })

  test('a hit in the title outranks the same hit in a prompt', () => {
    const inTitle = summary({ title: 'reservation card', userPrompts: ['nothing here'] })
    const inPrompt = summary({ title: 'nothing here', userPrompts: ['reservation card'] })
    expect(scoreSession('reserv', inTitle)!).toBeGreaterThan(scoreSession('reserv', inPrompt)!)
  })

  test('a prompt buried deep in the conversation still matches as well as an early one', () => {
    const early = summary({ title: 'x', userPrompts: ['idempotent importer', ...Array(40).fill('filler')] })
    const late = summary({ title: 'x', userPrompts: [...Array(40).fill('filler'), 'idempotent importer'] })
    expect(scoreSession('idempotent', late)).toBe(scoreSession('idempotent', early))
  })

  test('a query cannot span two separate prompts', () => {
    const s = summary({ title: 'x', userPrompts: ['alpha', 'beta'] })
    expect(scoreSession('alphabeta', s)).toBeNull()
  })
})

describe('bestPromptMatch', () => {
  test('picks the prompt that matches, not merely the first', () => {
    const match = bestPromptMatch('idem', ['rename the column', 'make it idempotent'])
    expect(match?.text).toBe('make it idempotent')
    // The whole word wins over spending the "i" on "it" and scattering the rest.
    expect(match?.indices).toEqual([8, 9, 10, 11])
  })

  test('prefers the stronger of two matching prompts', () => {
    // "imp" is contiguous at a word start in the second, scattered in the first.
    const match = bestPromptMatch('imp', ['it is a simple map', 'importer rewrite'])
    expect(match?.text).toBe('importer rewrite')
  })

  test('falls back to the first prompt when nothing matches', () => {
    const match = bestPromptMatch('zzq', ['rename the column', 'make it idempotent'])
    expect(match?.text).toBe('rename the column')
    expect(match?.indices).toEqual([])
  })

  test('an empty query shows the first prompt unhighlighted', () => {
    const match = bestPromptMatch('', ['rename the column'])
    expect(match?.text).toBe('rename the column')
    expect(match?.indices).toEqual([])
  })

  test('a session with no prompts has nothing to show', () => {
    expect(bestPromptMatch('anything', [])).toBeNull()
  })
})
