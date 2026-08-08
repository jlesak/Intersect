import { render } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import type { SessionSummary } from '@common/domain'
import { SessionRow } from './SessionRow'

const session = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 's1',
  filePath: '/p/s1.jsonl',
  cwd: '/repos/spot',
  folderName: 'spot',
  title: 'Nightly import',
  gitBranch: null,
  firstTimestamp: 1_000_000,
  lastTimestamp: 2_000_000,
  durationMs: 1_000_000,
  activeDurationMs: 500_000,
  messageCount: 4,
  userPrompts: ['please make the nightly importer idempotent'],
  ...over
})

/** The preview line's rendered text, and the substrings it highlighted, in order. */
function preview(query: string, over: Partial<SessionSummary> = {}): { text: string; marks: string[] } {
  const { container } = render(<SessionRow session={session(over)} active={false} query={query} focused onFocus={() => {}} />)
  const snip = container.querySelector('.ix-session-row__snip')
  return {
    text: snip?.textContent ?? '',
    marks: [...(snip?.querySelectorAll('.ix-session-row__mark') ?? [])].map((m) => m.textContent ?? '')
  }
}

describe('SessionRow preview', () => {
  test('marks the characters that earned the hit', () => {
    expect(preview('importer')).toEqual({
      text: 'please make the nightly importer idempotent',
      marks: ['importer']
    })
  })

  test('a half-typed query with a trailing space still marks the word already typed', () => {
    // The list keeps the row on the trimmed query, so the preview must explain it on the same terms.
    expect(preview('importer ').marks).toEqual(['importer'])
  })

  test('scattered matches are marked separately, adjacent ones as one run', () => {
    expect(preview('mkngh').marks).toEqual(['m', 'k', 'n', 'gh'])
  })

  test('a match far into a long prompt is wound into view', () => {
    const filler = 'x'.repeat(400)
    const { text, marks } = preview('idempotent', { userPrompts: [`${filler} idempotent`] })
    expect(marks).toEqual(['idempotent'])
    expect(text.startsWith('…')).toBe(true)
    // Only the lead-in survives, not the four hundred characters of filler before it.
    expect(text.length).toBeLessThan(50)
  })

  test('with no query the first prompt is shown plain', () => {
    expect(preview('')).toEqual({
      text: 'please make the nightly importer idempotent',
      marks: []
    })
  })

  test('a session kept on its title alone still previews its first prompt, unmarked', () => {
    // "zzq" matches no prompt, but the row must still read as a prompt rather than go blank.
    expect(preview('zzq').text).toBe('please make the nightly importer idempotent')
    expect(preview('zzq').marks).toEqual([])
  })

  test('a session with no prompts renders no preview line at all', () => {
    const { container } = render(
      <SessionRow session={session({ userPrompts: [] })} active={false} query="x" focused onFocus={() => {}} />
    )
    expect(container.querySelector('.ix-session-row__snip')).toBeNull()
  })
})
