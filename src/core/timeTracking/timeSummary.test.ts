import { describe, expect, test } from 'vitest'
import { buildSummaryInput, parseSummaryEnvelope, redactSecrets } from './timeSummary'

const accepted = (summary: string, isWork = true) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false,
  result: JSON.stringify({ summary, isWork })
})

describe('Haiku result validation', () => {
  test('accepts the exact successful outer and inner objects', () => {
    expect(parseSummaryEnvelope(accepted('Oprava validace vstupu a doplnění testů.')))
      .toEqual({ summary: 'Oprava validace vstupu a doplnění testů.', isWork: true })
  })

  test.each([
    '{',
    JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: '{}' }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{' }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
      result: JSON.stringify({ summary: 'Oprava testů.', isWork: true, extra: 1 }) }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
      result: JSON.stringify({ summary: 'Oprava testů.', isWork: 'true' }) }),
    accepted('Viz https://example.test'),
    accepted('Oprava souboru /tmp/secret.txt'),
    accepted('Oprava klíče ghp_12345678901234567890'),
    accepted('Oprava klíče sk-short'),
    accepted('Oprava klíče xoxc-FAKE_PLACEHOLDER'),
    accepted('Oprava klíče xoxd-FAKE_PLACEHOLDER'),
    accepted('Oprava souboru:/synthetic/private.txt'),
    accepted('Oprava souboru:src/core/file.ts'),
    accepted('Oprava src/core/file.ts'),
    accepted('Oprava ./src/core/file.ts'),
    accepted('Oprava ../src/core/file.ts'),
    accepted('Opravil soubor src/Makefile.'),
    accepted('Upravil package/README.'),
    accepted('Viz ftp://example.invalid/item'),
    accepted('Viz file:///synthetic/private.txt'),
    accepted('Oprava -----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'),
    accepted('Oprava\ntestů'),
    accepted('Oprava testů. Doplnění validace.'),
    accepted('ab'),
    accepted('X'.repeat(141)),
    accepted('<b>Oprava</b>')
  ])('rejects unsafe or malformed model result %#', raw => {
    expect(() => parseSummaryEnvelope(raw)).toThrow()
  })
})

test('redacts secrets before the complete input is capped and excludes tools and other days', () => {
  const input = buildSummaryInput({ title: 'Validace', cwd: '/private/work/project',
    gitBranch: 'feature/validation', day: '2026-07-06', lastTimestamp: Date.parse('2026-07-06T10:00:00Z') }, {
    id: 's1', title: 'Validace', cwd: '/private/work/project', entries: [
      { role: 'user', timestamp: Date.parse('2026-07-06T09:00:00Z'),
        text: 'Oprav validaci. Token ghp_12345678901234567890', tools: ['Bash: secret'] },
      { role: 'assistant', timestamp: Date.parse('2026-07-06T09:01:00Z'),
        text: 'Přidal jsem testy.\nDalší soukromý řádek.', tools: ['Read /secret'] },
      { role: 'user', timestamp: Date.parse('2026-07-07T09:00:00Z'),
        text: 'Jiný den', tools: [] }
    ]
  }, 'UTC')
  expect(input).toContain('project')
  expect(input).toContain('[redacted]')
  expect(input).not.toContain('/private/work')
  expect(input).not.toContain('ghp_')
  expect(input).not.toContain('Jiný den')
  expect(input).not.toContain('Bash')
  expect(input).not.toContain('Další soukromý')
  expect(input.length).toBeLessThanOrEqual(12_000)
  expect(redactSecrets('AKIA1234567890123456')).toBe('[redacted]')
  expect(redactSecrets('-----BEGIN PRIVATE KEY-----\nshort\n-----END PRIVATE KEY-----'))
    .toBe('[redacted]')
})

test.each(['xoxc-FAKE_PLACEHOLDER', 'xoxd-FAKE_PLACEHOLDER'])(
  'redacts synthetic %s token from model input', token => {
    const timestamp = Date.parse('2026-07-06T09:00:00Z')
    const input = buildSummaryInput({ title: 'Validace', cwd: '/synthetic/project',
      gitBranch: null, day: '2026-07-06', lastTimestamp: timestamp }, {
      id: 's1', title: 'Validace', cwd: '/synthetic/project',
      entries: [{ role: 'user', timestamp, text: `Oprava validace ${token}`, tools: [] }]
    }, 'UTC')
    expect(input).toContain('[redacted]')
    expect(input).not.toContain(token)
  }
)

test('keeps only entries in the saved local day, even before the timestamp cutoff', () => {
  const cutoff = Date.parse('2026-07-06T09:06:00Z')
  const input = buildSummaryInput({ title: 'Validace', cwd: '/synthetic/project',
    gitBranch: null, day: '2026-07-06', lastTimestamp: cutoff }, {
    id: 's1', title: 'Validace', cwd: '/synthetic/project', entries: [
      { role: 'user', timestamp: Date.parse('2026-07-06T06:59:00Z'),
        text: 'Předchozí místní den', tools: [] },
      { role: 'user', timestamp: Date.parse('2026-07-06T08:00:00Z'),
        text: 'Tento místní den', tools: [] }
    ]
  }, 'America/Los_Angeles')
  expect(input).toContain('Tento místní den')
  expect(input).not.toContain('Předchozí místní den')
})
