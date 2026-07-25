import { describe, expect, test } from 'vitest'
import {
  extractText,
  parseSummary,
  parseTranscript,
  stripCommandWrappers,
  toolSummary
} from './sessionParse'

/** Build a `.jsonl` line from an object, as it appears on disk (one JSON per line). */
const line = (o: unknown): string => JSON.stringify(o)

const userLine = (
  content: unknown,
  over: Record<string, unknown> = {}
): string => line({ type: 'user', message: { content }, ...over })

const assistantLine = (
  content: unknown,
  over: Record<string, unknown> = {}
): string => line({ type: 'assistant', message: { content }, ...over })

describe('stripCommandWrappers', () => {
  test('removes command-name / command-message / command-args blocks and trims', () => {
    const raw =
      '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>'
    expect(stripCommandWrappers(raw)).toBe('')
  })

  test('keeps the real prompt text after the wrapper', () => {
    const raw = '<command-name>/model</command-name> please refactor the parser'
    expect(stripCommandWrappers(raw)).toBe('please refactor the parser')
  })

  test('leaves plain text untouched', () => {
    expect(stripCommandWrappers('just a question')).toBe('just a question')
  })
})

describe('extractText', () => {
  test('returns a plain string as-is', () => {
    expect(extractText('hello world')).toBe('hello world')
  })

  test('concatenates text parts from a parts array and ignores non-text parts', () => {
    const content = [
      { type: 'text', text: 'first' },
      { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } },
      { type: 'text', text: 'second' }
    ]
    expect(extractText(content)).toBe('first\nsecond')
  })

  test('returns empty string for a parts array with only tool calls', () => {
    expect(extractText([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }])).toBe('')
  })

  test('is defensive against nullish or unexpected content', () => {
    expect(extractText(undefined)).toBe('')
    expect(extractText(null)).toBe('')
    expect(extractText(42)).toBe('')
  })
})

describe('toolSummary', () => {
  test('summarizes file tools with their path', () => {
    expect(toolSummary('Read', { file_path: 'src/foo.ts' })).toBe('Read src/foo.ts')
    expect(toolSummary('Edit', { file_path: 'src/foo.ts' })).toBe('Edit src/foo.ts')
    expect(toolSummary('Write', { file_path: 'src/foo.ts' })).toBe('Write src/foo.ts')
  })

  test('summarizes Bash with its command', () => {
    expect(toolSummary('Bash', { command: 'npm test' })).toBe('Bash: npm test')
  })

  test('summarizes Grep with its quoted pattern', () => {
    expect(toolSummary('Grep', { pattern: 'lock owner' })).toBe('Grep "lock owner"')
  })

  test('falls back to just the tool name for unknown tools or missing input', () => {
    expect(toolSummary('MysteryTool', { whatever: 1 })).toBe('MysteryTool')
    expect(toolSummary('Read', {})).toBe('Read')
    expect(toolSummary('Bash', null)).toBe('Bash')
  })
})

describe('parseSummary', () => {
  test('derives id from the file basename without extension', () => {
    const s = parseSummary('/x/y/abc-123.jsonl', [])
    expect(s.id).toBe('abc-123')
  })

  test('prefers aiTitle over everything for the title', () => {
    const lines = [
      userLine('build the thing', { timestamp: '2026-01-01T00:00:00Z', cwd: '/a/b' }),
      line({ type: 'ai-title', aiTitle: 'Nice human title' })
    ]
    expect(parseSummary('/p/s.jsonl', lines).title).toBe('Nice human title')
  })

  test('falls back to the first non-meta user prompt when no aiTitle', () => {
    const lines = [
      userLine('meta noise', { isMeta: true }),
      userLine('<command-name>/clear</command-name>'),
      userLine('the real first prompt', { cwd: '/repo/spot' })
    ]
    expect(parseSummary('/p/s.jsonl', lines).title).toBe('the real first prompt')
  })

  test('falls back to folderName when there is no aiTitle and no usable prompt', () => {
    const lines = [
      assistantLine([{ type: 'text', text: 'hi' }], { cwd: '/home/me/my-repo' }),
      userLine('<command-name>/clear</command-name>')
    ]
    expect(parseSummary('/p/s.jsonl', lines).title).toBe('my-repo')
  })

  test('falls back to the id when nothing else is available', () => {
    expect(parseSummary('/p/lonely.jsonl', []).title).toBe('lonely')
  })

  test('reads cwd and folderName from the first line that has a cwd', () => {
    const lines = [userLine('hi', { cwd: '/Users/me/GC/SPOT' })]
    const s = parseSummary('/p/s.jsonl', lines)
    expect(s.cwd).toBe('/Users/me/GC/SPOT')
    expect(s.folderName).toBe('SPOT')
  })

  test('reads the first non-empty gitBranch, else null', () => {
    expect(parseSummary('/p/s.jsonl', [userLine('hi', { gitBranch: 'feature/x' })]).gitBranch).toBe(
      'feature/x'
    )
    expect(parseSummary('/p/s.jsonl', [userLine('hi')]).gitBranch).toBeNull()
  })

  test('computes first/last timestamps and non-negative duration', () => {
    const lines = [
      userLine('a', { timestamp: '2026-01-01T00:00:10Z' }),
      assistantLine([{ type: 'text', text: 'b' }], { timestamp: '2026-01-01T00:00:40Z' }),
      userLine('c', { timestamp: '2026-01-01T00:00:00Z' })
    ]
    const s = parseSummary('/p/s.jsonl', lines)
    expect(s.firstTimestamp).toBe(Date.parse('2026-01-01T00:00:00Z'))
    expect(s.lastTimestamp).toBe(Date.parse('2026-01-01T00:00:40Z'))
    expect(s.durationMs).toBe(40_000)
  })

  test('timestamps default to 0 and duration to 0 when none are present', () => {
    const s = parseSummary('/p/s.jsonl', [userLine('hi')])
    expect(s.firstTimestamp).toBe(0)
    expect(s.lastTimestamp).toBe(0)
    expect(s.durationMs).toBe(0)
  })

  test('messageCount counts non-meta user + assistant messages only', () => {
    const lines = [
      userLine('meta', { isMeta: true }),
      userLine('real'),
      assistantLine([{ type: 'text', text: 'reply' }]),
      line({ type: 'system', content: 'ignored' }),
      line({ type: 'ai-title', aiTitle: 'T' })
    ]
    expect(parseSummary('/p/s.jsonl', lines).messageCount).toBe(2)
  })

  test('userPrompts collects every stripped non-meta prompt and drops empties', () => {
    const lines = [
      userLine('meta', { isMeta: true }),
      userLine('<command-name>/clear</command-name>'),
      userLine('first question'),
      userLine([{ type: 'text', text: 'second question' }])
    ]
    expect(parseSummary('/p/s.jsonl', lines).userPrompts).toEqual([
      'first question',
      'second question'
    ])
  })

  test('never throws on garbage lines - it skips them', () => {
    const lines = [
      'not json at all',
      '{ broken',
      userLine('survives', { timestamp: '2026-01-01T00:00:00Z' })
    ]
    const s = parseSummary('/p/s.jsonl', lines)
    expect(s.userPrompts).toEqual(['survives'])
    expect(s.messageCount).toBe(1)
  })
})

describe('parseSummary activeDurationMs', () => {
  test('two messages five minutes apart credit the whole gap', () => {
    const s = parseSummary('/p/s.jsonl', [
      userLine('a', { timestamp: '2026-01-01T09:00:00Z' }),
      assistantLine([{ type: 'text', text: 'b' }], { timestamp: '2026-01-01T09:05:00Z' })
    ])
    expect(s.activeDurationMs).toBe(300_000)
    expect(s.activeDurationMs).toBe(s.durationMs)
  })

  test('an idle gap is capped while wall-clock duration is not', () => {
    const s = parseSummary('/p/s.jsonl', [
      userLine('a', { timestamp: '2026-01-01T09:00:00Z' }),
      assistantLine([{ type: 'text', text: 'b' }], { timestamp: '2026-01-01T09:05:00Z' }),
      userLine('c', { timestamp: '2026-01-01T17:00:00Z' })
    ])
    expect(s.activeDurationMs).toBe(900_000)
    expect(s.durationMs).toBe(8 * 60 * 60_000)
  })

  test('a multi-day gap contributes exactly one idle cap', () => {
    const s = parseSummary('/p/s.jsonl', [
      userLine('a', { timestamp: '2026-01-01T09:00:00Z' }),
      assistantLine([{ type: 'text', text: 'b' }], { timestamp: '2026-01-03T09:00:00Z' })
    ])
    expect(s.activeDurationMs).toBe(10 * 60 * 1000)
  })

  test('out-of-order timestamps are sorted before summing gaps', () => {
    const s = parseSummary('/p/s.jsonl', [
      userLine('c', { timestamp: '2026-01-01T17:00:00Z' }),
      userLine('a', { timestamp: '2026-01-01T09:00:00Z' }),
      assistantLine([{ type: 'text', text: 'b' }], { timestamp: '2026-01-01T09:05:00Z' })
    ])
    expect(s.activeDurationMs).toBe(900_000)
  })

  test('zero or one timestamp yields no active time', () => {
    expect(parseSummary('/p/s.jsonl', []).activeDurationMs).toBe(0)
    expect(
      parseSummary('/p/s.jsonl', [userLine('a', { timestamp: '2026-01-01T09:00:00Z' })])
        .activeDurationMs
    ).toBe(0)
  })

  test('untimestamped messages are ignored', () => {
    const s = parseSummary('/p/s.jsonl', [
      userLine('a', { timestamp: '2026-01-01T09:00:00Z' }),
      userLine('no timestamp here'),
      assistantLine([{ type: 'text', text: 'b' }], { timestamp: '2026-01-01T09:05:00Z' })
    ])
    expect(s.activeDurationMs).toBe(300_000)
  })
})

describe('parseTranscript', () => {
  test('builds one entry per non-meta user and assistant message, in file order', () => {
    const lines = [
      userLine('meta', { isMeta: true, timestamp: '2026-01-01T00:00:00Z' }),
      userLine('a prompt', { timestamp: '2026-01-01T00:00:01Z' }),
      assistantLine(
        [
          { type: 'text', text: 'some answer' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'src/foo.ts' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }
        ],
        { timestamp: '2026-01-01T00:00:02Z' }
      )
    ]
    const t = parseTranscript('sess-1', 'Title', '/cwd', lines)
    expect(t).toMatchObject({ id: 'sess-1', title: 'Title', cwd: '/cwd' })
    expect(t.entries).toHaveLength(2)

    expect(t.entries[0]).toEqual({
      role: 'user',
      text: 'a prompt',
      timestamp: Date.parse('2026-01-01T00:00:01Z'),
      tools: []
    })
    expect(t.entries[1]).toEqual({
      role: 'assistant',
      text: 'some answer',
      timestamp: Date.parse('2026-01-01T00:00:02Z'),
      tools: ['Read src/foo.ts', 'Bash: npm test']
    })
  })

  test('assistant text is empty when the turn is only tool calls', () => {
    const lines = [
      assistantLine([{ type: 'tool_use', name: 'Grep', input: { pattern: 'lock owner' } }])
    ]
    const t = parseTranscript('s', 'T', '/c', lines)
    expect(t.entries[0].text).toBe('')
    expect(t.entries[0].tools).toEqual(['Grep "lock owner"'])
  })

  test('user command wrappers are stripped for a readable transcript', () => {
    const t = parseTranscript('s', 'T', '/c', [
      userLine('<command-name>/model</command-name> resume where we left off')
    ])
    expect(t.entries[0].text).toBe('resume where we left off')
  })

  test('missing timestamps default to 0', () => {
    const t = parseTranscript('s', 'T', '/c', [userLine('no ts here')])
    expect(t.entries[0].timestamp).toBe(0)
  })

  test('skips unparseable lines without throwing', () => {
    const t = parseTranscript('s', 'T', '/c', ['garbage', userLine('ok')])
    expect(t.entries).toHaveLength(1)
    expect(t.entries[0].text).toBe('ok')
  })
})
