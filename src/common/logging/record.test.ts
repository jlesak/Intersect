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
      sentence: 'Request https://h/a?api-version=7.1&token=abc, status 401',
      bracketed: '(see https://h/a?token=x)',
      final: 'Failed at https://h/a?token=x.',
      quoted: '"https://h/a?token=x"'
    }) as Record<string, string>
    expect(out.pair).toBe(`two https://h/a?token=${REDACTED};https://h/b?token=${REDACTED} done`)
    expect(out.sentence).toBe(`Request https://h/a?api-version=7.1&token=${REDACTED}, status 401`)
    expect(out.bracketed).toBe(`(see https://h/a?token=${REDACTED})`)
    expect(out.final).toBe(`Failed at https://h/a?token=${REDACTED}.`)
    expect(out.quoted).toBe(`"https://h/a?token=${REDACTED}"`)
  })

  it('loses trailing text rather than leaking, when a URL runs into it without a space', () => {
    // The run has no whitespace to end it, so `,b=2` is absorbed into the token value and goes with
    // it. Losing that is the price of never cutting the run short, and it is the right way round.
    expect(redactValue({ text: 'a=https://h?token=x,b=2 end' })).toEqual({
      text: `a=https://h/?token=${REDACTED} end`
    })
  })

  it('redacts a credential carried in the authority rather than the query', () => {
    expect(redactUrl('https://user:PAT123@h.example/a')).toBe(
      `https://${REDACTED}:${REDACTED}@h.example/a`
    )
    expect(redactUrl('https://:PAT123@h.example/a')).toBe(`https://:${REDACTED}@h.example/a`)
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

  it('redacts a credential delivered in the fragment', () => {
    expect(redactUrl('https://h.example/a#access_token=abc123&expires_in=3600')).toBe(
      `https://h.example/a#access_token=${REDACTED}&expires_in=3600`
    )
    expect(redactUrl('https://h.example/a#/board?token=abc123')).toBe(
      `https://h.example/a#/board?token=${REDACTED}`
    )
  })

  it('leaves a fragment carrying no credential exactly as it arrived', () => {
    // A single-page application keeps its route here, so rewriting an innocent fragment would
    // corrupt the one part of the URL that says which view the user was looking at.
    for (const raw of [
      'https://h.example/a#section-3',
      'https://h.example/a#L42',
      'https://h.example/a#a=1&b=2',
      'https://h.example/a#/dashboard?filter=open'
    ]) {
      expect(redactUrl(raw)).toBe(raw)
    }
  })
})

/**
 * The redaction vocabulary, pinned in both directions.
 *
 * Both halves matter, for opposite reasons. A name that should redact and does not is a leak. A name
 * that should not redact and does is silent destruction of the values the log exists to record - and
 * because paths are the primary domain object of a workspace and terminal manager, that half is not
 * cosmetic either.
 */
describe('the names that mean a credential', () => {
  const redacted = [
    'pat',
    'PAT',
    'Pat',
    'savedPat',
    'adoPat',
    'ado_pat',
    'ado-pat',
    'ado.pat',
    'AZURE_DEVOPS_PAT',
    'patToken',
    'pat2',
    // The longer names are recognised anywhere inside a key, including run together without any
    // separator, which is how they arrive from a third party.
    'token',
    'access_token',
    'ACCESS_TOKEN',
    'authtoken',
    'sessionCookie',
    'clientSecret',
    'clientsecret',
    'userPassword',
    'Authorization',
    'bearerToken',
    'apiKey',
    'inputTokens',
    'tokenCount'
  ]

  const kept = [
    'path',
    'Path',
    'filePath',
    'folderPath',
    'repoPath',
    'targetPath',
    'worktreePath',
    'vttPath',
    'backupPath',
    'originalPath',
    'resolvePath',
    'revealPath',
    'patch',
    'patches',
    'patchSet',
    'pattern',
    'dispatch',
    'dispatcher',
    'dispatchEvent',
    'compatible',
    'compatibility',
    'participants',
    'status',
    'update',
    'pid',
    'api-version',
    'jql',
    'fields',
    'ids'
  ]

  for (const name of redacted) {
    it(`redacts ${name}`, () => {
      expect(redactValue({ [name]: 'CREDENTIAL' })).toEqual({ [name]: REDACTED })
    })
  }

  for (const name of kept) {
    it(`keeps ${name}`, () => {
      expect(redactValue({ [name]: 'ordinary' })).toEqual({ [name]: 'ordinary' })
    })
  }

  it('applies one vocabulary to URL parameter names as well as object keys', () => {
    expect(redactUrl('https://h/a?pat=x&path=/tmp/y')).toBe(
      `https://h/a?pat=${REDACTED}&path=%2Ftmp%2Fy`
    )
  })
})

/**
 * The one invariant this module cannot be allowed to break, whatever shape the text arrives in. Each
 * entry has been a real bypass or a plausible one: the separators here are the documented batch-read
 * forms of Azure DevOps and Jira, and every character ever excluded from the URL run in order to
 * preserve surrounding text became a point where the credential after it escaped.
 */
describe('no shape leaves a secret in the output', () => {
  const SECRET = 'SECRETVALUE'
  const shapes: Record<string, string> = {
    'comma-separated ids before the token': `GET https://dev.azure.com/o/_apis/wit/workitems?ids=297,299,300&api-version=7.1&access_token=${SECRET} failed`,
    'comma-separated fields before the token': `https://jira.example/rest/api/2/search?fields=summary,status&token=${SECRET}`,
    'comma in the path': `https://h/a,b?token=${SECRET}`,
    'semicolon in an earlier parameter': `https://h/a?x=1;2&token=${SECRET}`,
    'both separators before the token': `https://h/a?ids=1;2,3&pat=${SECRET}&more=1`,
    'two URLs run together': `two https://h/a?token=${SECRET};https://h/b?token=${SECRET} done`,
    'a URL nested in a parameter': `https://h/redirect?url=https://other/a?token=${SECRET}`,
    'a comma inside the secret value': `https://h/a?token=${SECRET},x`,
    'double quotes in an earlier parameter': `https://h/a?q="x"&token=${SECRET}`,
    'single quotes in an earlier parameter': `https://h/a?q='y'&pat=${SECRET}`,
    'angle brackets around the URL': `<https://h/a?token=${SECRET}>`,
    'quoted URL': `"https://h/a?token=${SECRET}"`,
    bracketed: `(see https://h/a?token=${SECRET})`,
    'sentence-final': `Failed at https://h/a?token=${SECRET}.`,
    'preceded by a comma': `prefix,https://h/a?token=${SECRET}`,
    'credential in the authority': `https://user:${SECRET}@h/a`,
    'credential as the password alone': `https://:${SECRET}@h/a`,
    'uppercased parameter name': `https://h/a?ids=1,2&ACCESS_TOKEN=${SECRET}`,
    'uppercased scheme': `HTTPS://h/a?ids=1,2&token=${SECRET}`,
    'credential in the fragment': `https://h/a#token=${SECRET}`,
    'an implicit-flow fragment': `https://h/a#access_token=${SECRET}&expires_in=3600`,
    'a fragment behind a query': `https://h/a?ids=1,2#token=${SECRET}`,
    'a fragment on a hash route': `https://h/a#/board?token=${SECRET}`,
    'a comma inside a fragment secret': `https://h/a#token=${SECRET},x`,
    'a sentence-final URL with a fragment': `Opened https://h/a#pat=${SECRET}.`,
    'a fragment on one of two glued URLs': `https://h/a#token=${SECRET};https://h/b?pat=${SECRET}`
  }

  for (const [name, shape] of Object.entries(shapes)) {
    it(`redacts it: ${name}`, () => {
      // Every route a string can take to disk: a payload value, the message, and an error's message
      // and stack, since a client quotes the failing request in all of them.
      expect(JSON.stringify(redactValue({ text: shape }))).not.toContain(SECRET)
      expect(serialize({ ...base, msg: shape })).not.toContain(SECRET)
      expect(serialize({ ...base, err: normalizeError(new Error(shape)) })).not.toContain(SECRET)
    })
  }
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
