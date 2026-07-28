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
  type LogRecord,
  type NormalizedError
} from './record'

const base: LogRecord = {
  ts: '2026-07-28T09:14:02.417Z',
  level: 'info',
  proc: 'core',
  pid: 4821,
  scope: 'jira',
  msg: 'board fetched'
}

/** Measured without Node's `Buffer`, so the assertions hold in the tests that take it away. */
const utf8Bytes = (line: string): number => new TextEncoder().encode(line).length

/** Every message in a cause chain, outermost first. */
function messages(err: NormalizedError): string[] {
  const out: string[] = []
  for (let node: NormalizedError | undefined = err; node; node = node.cause) out.push(node.message)
  return out
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
    const out = normalizeError(err)
    expect(out.message).toBe('loop')
    expect(out.cause).toBeUndefined()
  })

  it('describes non-errors without throwing', () => {
    expect(normalizeError('plain string').message).toBe('plain string')
    expect(normalizeError(null).message).toBe('null')
  })

  it('describes an error that refuses to be read', () => {
    const hostile = {
      get toString(): never {
        throw new Error('no')
      }
    }
    expect(normalizeError(hostile)).toEqual({ name: 'object', message: '[unprintable object]' })
  })

  it('takes no recursion state from its caller', () => {
    expect(normalizeError.length).toBe(1)
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
    expect(redactValue(cyclic)).toEqual({ name: 'x', self: '[circular]' })
  })

  it('reports a shared reference in full rather than calling it a cycle', () => {
    const shared = { id: 1 }
    expect(redactValue({ a: shared, b: shared })).toEqual({ a: { id: 1 }, b: { id: 1 } })
  })

  it('redacts a credential carried in a URL among the values', () => {
    expect(redactValue({ href: 'https://h.example/a?access_token=abc123' })).toEqual({
      href: `https://h.example/a?access_token=${REDACTED}`
    })
  })

  it('keeps the text that follows a redacted URL', () => {
    const out = redactValue({
      pair: 'two https://h/a?token=x;https://h/b?token=y done',
      assigned: 'a=https://h?token=x,b=2 end',
      sentence: 'Request https://h/a?api-version=7.1&token=abc, status 401',
      bracketed: '(see https://h/a?token=x)',
      final: 'Failed at https://h/a?token=x.'
    }) as Record<string, string>
    expect(out.pair).toBe(`two https://h/a?token=${REDACTED};https://h/b?token=${REDACTED} done`)
    expect(out.assigned).toBe(`a=https://h/?token=${REDACTED},b=2 end`)
    expect(out.sentence).toBe(
      `Request https://h/a?api-version=7.1&token=${REDACTED}, status 401`
    )
    expect(out.bracketed).toBe(`(see https://h/a?token=${REDACTED})`)
    expect(out.final).toBe(`Failed at https://h/a?token=${REDACTED}.`)
  })

  it('scans text that merely looks like a scheme in linear time', () => {
    // An unbounded scheme length makes the scan quadratic: `.` is not a word character, so a word
    // boundary opens a fresh start position after every one, and each rescans the whole run. The
    // dotted run is separated from the real URL here on purpose - run them together and the
    // unbounded pattern swallows the whole run in one greedy match and looks fast.
    const blob = `${'a.'.repeat(128000)} https://h/a?token=x`
    const startedAt = Date.now()
    const out = redactValue({ blob }) as { blob: string }
    expect(Date.now() - startedAt).toBeLessThan(1000)
    expect(out.blob).toContain(REDACTED)
    expect(out.blob).not.toContain('token=x')
  })

  it('keeps the content of the built-in types a caller is likely to log', () => {
    const out = redactValue({
      since: new Date(0),
      failure: new Error('disk full'),
      headers: new Map([
        ['token', 'abc'],
        ['accept', 'json']
      ]),
      tags: new Set(['a', 'b'])
    }) as {
      since: string
      failure: { name: string; message: string }
      headers: { token: string; accept: string }
      tags: string[]
    }
    expect(out.since).toBe('1970-01-01T00:00:00.000Z')
    expect(out.failure.message).toBe('disk full')
    expect(out.headers.token).toBe(REDACTED)
    expect(out.headers.accept).toBe('json')
    expect(out.tags).toEqual(['a', 'b'])
  })

  it('describes an invalid Date instead of throwing on it', () => {
    expect(redactValue({ at: new Date(Number.NaN) })).toEqual({ at: 'Invalid Date' })
  })

  it('loses one property, not the object, when a getter throws', () => {
    const hostile = {
      keep: 'kept',
      get boom(): never {
        throw new Error('getter')
      }
    }
    expect(redactValue(hostile)).toEqual({ keep: 'kept', boom: '[unreadable]' })
  })

  it('takes no recursion state from its caller', () => {
    expect(redactValue.length).toBe(1)
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

  it('survives a malformed escape instead of throwing', () => {
    expect(redactUrl('https://h.example/a%zz?token=secret')).toBe(
      `https://h.example/a%zz?token=${REDACTED}`
    )
  })

  it('leaves the escapes of innocent parameters intact', () => {
    expect(redactUrl('https://h.example/a?jql=project%20%3D%20FID')).toBe(
      'https://h.example/a?jql=project%20%3D%20FID'
    )
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

  it('bounds a record without Node globals, as the sandboxed renderer must', () => {
    const nodeGlobals = globalThis as unknown as { Buffer?: unknown }
    const restore = nodeGlobals.Buffer
    nodeGlobals.Buffer = undefined
    try {
      const line = serialize({ ...base, data: { blob: 'x'.repeat(MAX_RECORD_BYTES * 2) } })
      expect(utf8Bytes(line)).toBeLessThanOrEqual(MAX_RECORD_BYTES)
      expect(JSON.parse(line).data.truncated).toBe(true)
    } finally {
      nodeGlobals.Buffer = restore
    }
  })

  it('keeps the message and error when the stack alone is enormous', () => {
    const err = new Error('boom')
    err.stack = 'Error: boom\n' + '    at frame\n'.repeat(2000)
    const parsed = JSON.parse(serialize({ ...base, level: 'error', err: normalizeError(err) }))
    expect(parsed.err.message).toBe('boom')
    expect(parsed.err.stack.length).toBeLessThan(3000)
  })

  it('escapes the line breaks in every field, so one record stays one line', () => {
    const err = normalizeError(new Error('first line\nsecond line'))
    const line = serialize({ ...base, msg: 'a\nb', data: { note: 'c\r\nd' }, err })
    expect(line).not.toContain('\n')
    expect(line).not.toContain('\r')
    const parsed = JSON.parse(line)
    expect(parsed.msg).toBe('a\nb')
    expect(parsed.data.note).toBe('c\r\nd')
    expect(parsed.err.stack).toContain('second line')
  })

  it('renders a bigint rather than failing the record over it', () => {
    const parsed = JSON.parse(serialize({ ...base, data: { attempt: 1n } }))
    expect(parsed.data.attempt).toBe('1n')
    expect(parsed.msg).toBe('board fetched')
  })

  it('keeps the record when one of its values cannot be read', () => {
    const data = {
      status: 503,
      get boom(): never {
        throw new Error('getter')
      }
    }
    const parsed = JSON.parse(serialize({ ...base, data }))
    expect(parsed.msg).toBe('board fetched')
    expect(parsed.data.status).toBe(503)
    expect(parsed.data.boom).toBe('[unreadable]')
  })

  it('still emits an identifying line when the record cannot be rendered at all', () => {
    const err: NormalizedError = { name: 'Error', message: 'looping' }
    err.cause = err
    const line = serialize({ ...base, level: 'error', err })
    expect(utf8Bytes(line)).toBeLessThanOrEqual(MAX_RECORD_BYTES)
    const parsed = JSON.parse(line)
    expect(parsed.msg).toBe('board fetched')
    expect(parsed.ts).toBe(base.ts)
    expect(parsed.data.truncated).toBe(true)
    // Distinguishable from a record merely shed for size, or a defect here reads as sparse logging.
    expect(parsed.data.serializeFailed).toBe(true)
  })

  it('marks only a failure, never a record shed for its size', () => {
    const line = serialize({ ...base, ts: 'x'.repeat(20000) })
    const parsed = JSON.parse(line)
    expect(parsed.data.truncated).toBe(true)
    expect(parsed.data.serializeFailed).toBeUndefined()
  })

  it('redacts a credential quoted in an error message and its stack', () => {
    const err = normalizeError(new Error('401 for https://h.example/a?pat=abc123'))
    const line = serialize({ ...base, level: 'error', err })
    expect(line).not.toContain('abc123')
    expect(JSON.parse(line).err.message).toContain(REDACTED)
  })

  it('redacts a credential interpolated into the message', () => {
    const line = serialize({ ...base, msg: 'fetch failed for https://h.example/a?token=abc123' })
    expect(line).not.toContain('abc123')
  })

  it('keeps every message when a chain of wrapped errors is oversized', () => {
    const frames = '    at frame\n'.repeat(115)
    let err: NormalizedError = { name: 'Error', message: 'root', stack: `Error: root\n${frames}` }
    for (let i = 0; i < 5; i++) {
      err = { name: 'Error', message: `wrap${i}`, stack: `Error: wrap${i}\n${frames}`, cause: err }
    }
    const line = serialize({ ...base, level: 'error', err })
    expect(utf8Bytes(line)).toBeLessThanOrEqual(MAX_RECORD_BYTES)
    const parsed = JSON.parse(line)
    // A wrapped error must not log less than the bare error would have: the reported failure keeps
    // its own frames, and no message in the chain is lost, least of all the root cause's.
    expect(parsed.err.stack).toContain('at frame')
    expect(messages(parsed.err)).toEqual(['wrap4', 'wrap3', 'wrap2', 'wrap1', 'wrap0', 'root'])
  })

  it('bounds a record made oversized by a bare field, and keeps it parseable', () => {
    const line = serialize({ ...base, ts: 'x'.repeat(20000) })
    expect(utf8Bytes(line)).toBeLessThanOrEqual(MAX_RECORD_BYTES)
    expect(() => JSON.parse(line)).not.toThrow()
    expect(JSON.parse(line).msg).toBe('board fetched')
  })

  it('bounds a bare field by its bytes, not its characters', () => {
    const line = serialize({ ...base, ts: 'é'.repeat(20000) })
    expect(utf8Bytes(line)).toBeLessThanOrEqual(MAX_RECORD_BYTES)
    expect(JSON.parse(line).msg).toBe('board fetched')
  })

  it('bounds the failure line too, not only the one shed for size', () => {
    const huge = String.fromCharCode(1).repeat(20000)
    const err: NormalizedError = { name: 'Error', message: 'looping' }
    err.cause = err
    const hostile = { ts: huge, level: huge, proc: huge, pid: 4821, scope: huge, msg: huge, err }
    const line = serialize(hostile as unknown as LogRecord)
    expect(utf8Bytes(line)).toBeLessThanOrEqual(MAX_RECORD_BYTES)
    expect(JSON.parse(line).data.serializeFailed).toBe(true)
  })

  it('bounds a bare field of control characters, which escaping expands sixfold', () => {
    const line = serialize({ ...base, ts: '\u0001'.repeat(20000) })
    expect(utf8Bytes(line)).toBeLessThanOrEqual(MAX_RECORD_BYTES)
    expect(JSON.parse(line).msg).toBe('board fetched')
  })
})
