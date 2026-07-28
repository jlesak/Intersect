import { describe, expect, it } from 'vitest'
import {
  isLevelEnabled,
  MAX_RECORD_BYTES,
  normalizeError,
  redactUrl,
  redactValue,
  REDACTED,
  serialize,
  summarizeArgs,
  type LogRecord
} from './record'

const base: LogRecord = {
  ts: '2026-07-28T09:14:02.417Z',
  level: 'info',
  proc: 'core',
  pid: 4821,
  scope: 'jira',
  msg: 'board fetched'
}

describe('isLevelEnabled', () => {
  it('admits levels at or above the floor', () => {
    expect(isLevelEnabled('error', 'info')).toBe(true)
    expect(isLevelEnabled('info', 'info')).toBe(true)
    expect(isLevelEnabled('debug', 'info')).toBe(false)
  })
})

describe('normalizeError', () => {
  it('keeps name, message and stack', () => {
    const err = new TypeError('bad shape')
    const out = normalizeError(err)
    expect(out.name).toBe('TypeError')
    expect(out.message).toBe('bad shape')
    expect(out.stack).toContain('bad shape')
  })

  it('walks the cause chain', () => {
    const out = normalizeError(new Error('outer', { cause: new Error('inner') }))
    expect(out.cause?.message).toBe('inner')
  })

  it('stops a self-referential cause chain', () => {
    const err = new Error('loop') as Error & { cause?: unknown }
    err.cause = err
    expect(() => normalizeError(err)).not.toThrow()
  })

  it('describes non-errors without throwing', () => {
    expect(normalizeError('plain string').message).toBe('plain string')
    expect(normalizeError(null).message).toBe('null')
  })
})

describe('redactValue', () => {
  it('redacts secret-bearing keys at any depth', () => {
    const out = redactValue({ ado: { pat: 'abc' }, list: [{ Authorization: 'Bearer x' }] }) as {
      ado: { pat: string }
      list: Array<{ Authorization: string }>
    }
    expect(out.ado.pat).toBe(REDACTED)
    expect(out.list[0].Authorization).toBe(REDACTED)
  })

  it('leaves innocent keys alone', () => {
    expect(redactValue({ status: 503 })).toEqual({ status: 503 })
  })

  it('survives a cyclic object', () => {
    const cyclic: Record<string, unknown> = { name: 'x' }
    cyclic.self = cyclic
    expect(() => redactValue(cyclic)).not.toThrow()
  })
})

describe('redactUrl', () => {
  it('keeps origin and path', () => {
    expect(redactUrl('https://jira.example.com/rest/api/2/search?jql=x')).toBe(
      'https://jira.example.com/rest/api/2/search?jql=x'
    )
  })

  it('strips only the secret-bearing parameters', () => {
    expect(redactUrl('https://h.example/a?api-version=7.1&access_token=secret')).toBe(
      `https://h.example/a?api-version=7.1&access_token=${REDACTED}`
    )
  })

  it('returns a non-URL unchanged', () => {
    expect(redactUrl('not a url')).toBe('not a url')
  })
})

describe('summarizeArgs', () => {
  it('reports shapes and lengths, never values', () => {
    expect(summarizeArgs(['abc', [1, 2], null, 7, { a: 1 }])).toEqual([
      'string(3)',
      'array(2)',
      'null',
      'number',
      'object'
    ])
  })
})

describe('serialize', () => {
  it('emits exactly one line of valid JSON', () => {
    const line = serialize(base)
    expect(line).not.toContain('\n')
    expect(JSON.parse(line)).toMatchObject({ scope: 'jira', msg: 'board fetched' })
  })

  it('omits absent optional fields', () => {
    expect(Object.keys(JSON.parse(serialize(base)))).not.toContain('data')
  })

  it('redacts data on the way out', () => {
    const line = serialize({ ...base, data: { token: 'sensitive' } })
    expect(line).not.toContain('sensitive')
  })

  it('shrinks an oversized record instead of dropping it', () => {
    const line = serialize({ ...base, data: { blob: 'x'.repeat(MAX_RECORD_BYTES * 2) } })
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(MAX_RECORD_BYTES)
    const parsed = JSON.parse(line)
    expect(parsed.msg).toBe('board fetched')
    expect(parsed.data.truncated).toBe(true)
  })

  it('keeps the message and error when the stack alone is enormous', () => {
    const err = new Error('boom')
    err.stack = 'Error: boom\n' + '    at frame\n'.repeat(2000)
    const parsed = JSON.parse(serialize({ ...base, level: 'error', err: normalizeError(err) }))
    expect(parsed.err.message).toBe('boom')
    expect(parsed.err.stack.length).toBeLessThan(3000)
  })
})
