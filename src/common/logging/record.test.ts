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

  it('redacts a credential carried in a key, not only in a value', () => {
    // A cache keyed by request URL puts the credential in the key, where judging the value protects
    // nothing.
    expect(redactValue({ 'https://h/a?token=S3CR3T': 1 })).toEqual({
      [`https://h/a?token=${REDACTED}`]: REDACTED
    })
    const keyed = new Map([['https://h/a?pat=S3CR3T', 1]])
    expect(JSON.stringify(redactValue({ keyed }))).not.toContain('S3CR3T')
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
      sentence: 'Request https://h/a?api-version=7.1&token=abc, status 401',
      bracketed: '(see https://h/a?token=x)',
      final: 'Failed at https://h/a?token=x.',
      quoted: '"https://h/a?token=x"'
    }) as Record<string, string>
    expect(out.sentence).toBe(`Request https://h/a?api-version=7.1&token=${REDACTED}, status 401`)
    expect(out.bracketed).toBe(`(see https://h/a?token=${REDACTED})`)
    expect(out.final).toBe(`Failed at https://h/a?token=${REDACTED}.`)
    expect(out.quoted).toBe(`"https://h/a?token=${REDACTED}"`)
  })

  it('splits two glued URLs so each is redacted in its own right', () => {
    // Deleting this split was argued for once on the grounds that searching parameter values had
    // superseded it. That was wrong, and the shape below is why the split cannot go: a URL glued into
    // another one's path is reached by nothing else at all.
    const out = redactValue({
      pair: 'two https://h/a?token=x;https://h/b?token=y done',
      inPath: 'GET https://api.example.com/v1/https://alice:pw@internal/redirect 500'
    }) as Record<string, string>
    expect(out.pair).toBe(`two https://h/a?token=${REDACTED};https://h/b?token=${REDACTED} done`)
    expect(out.inPath).not.toContain('pw@')
    expect(out.inPath).toContain('api.example.com')
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

  it('keeps the meaning of the other built-ins a caller reaches for', () => {
    const out = redactValue({
      target: new URL('https://h/a?token=abc'),
      match: /^a.*z$/i,
      pending: Promise.resolve(1),
      bytes: new Uint8Array([1, 2, 3]),
      buffer: new ArrayBuffer(8)
    }) as Record<string, string>
    // A URL is the likeliest of these here, and it used to become `{}` - the request and any
    // credential in it gone.
    expect(out.target).toBe(`https://h/a?token=${REDACTED}`)
    expect(out.match).toBe('/^a.*z$/i')
    expect(out.pending).toBe('[promise]')
    // Described, not transcribed: enumerating a typed array yields a property per byte, which buries
    // the record and then costs the whole payload when the line is shrunk to fit.
    expect(out.bytes).toBe('Uint8Array(3 bytes)')
    expect(out.buffer).toBe('ArrayBuffer(8 bytes)')
  })

  it('describes a large binary payload instead of drowning the record in it', () => {
    const parsed = JSON.parse(serialize({ ...base, data: { blob: new Uint8Array(200000) } }))
    expect(parsed.data.blob).toBe('Uint8Array(200000 bytes)')
    expect(parsed.msg).toBe('board fetched')
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
      'https://h.example/a#/dashboard?filter=open',
      'https://h.example/a#/route?a=1&b=2',
      'https://h.example/a#L42-L50',
      'https://h.example/a#a.b.c',
      'https://h.example/a#/a/b/c'
    ]) {
      expect(redactUrl(raw)).toBe(raw)
    }
  })

  it('examines the whole fragment, not only what follows a question mark', () => {
    // A `?` inside a parameter value is not a route separator. Treating it as one left every
    // parameter ahead of it unexamined, which is where the credential sits.
    for (const raw of [
      'https://h/a#access_token=SEC&redirect=/a?b=1',
      'https://h/a#access_token=SEC&state=a?b',
      'https://h/a#a=1&token=SEC&u=/x?y=1',
      'https://h/a#token=SEC?x=1',
      'https://h/a#token=SEC1?token=SEC2'
    ]) {
      expect(redactUrl(raw)).not.toContain('SEC')
    }
  })

  it('scans a string that does not parse as a URL rather than trusting it', () => {
    // A malformed URL carries the same credentials as a well-formed one, and an out-of-range port
    // is all it takes: these five all make `new URL` throw.
    for (const raw of [
      'https://h:99999/a?token=S3CR3T',
      'https://h:port/a?token=S3CR3T',
      'https://[::1/a?token=S3CR3T',
      'https://h%/a?token=S3CR3T',
      'https:://h/a?token=S3CR3T'
    ]) {
      expect(() => new URL(raw)).toThrow()
      expect(redactUrl(raw)).not.toContain('S3CR3T')
    }
  })

  it('recognises a mistyped scheme separator in free text, so it reaches redaction', () => {
    // `https:://` never matched the URL scanner, so a malformed URL quoted in an error message was
    // never offered to redaction at all - which is where a client puts the request it failed on.
    const out = redactValue({ note: 'Request to https:://h/a?token=S3CR3T failed' }) as {
      note: string
    }
    expect(out.note).not.toContain('S3CR3T')
  })

  it('recognises a mistyped scheme separator in the authority it cannot parse', () => {
    // Three patterns recognise the start of a URL. Widening one and leaving the others left the
    // credential escaping through whichever of them still refused the extra colon.
    for (const raw of [
      'https:://user:S3CR3T@h/a',
      'https::://user:S3CR3T@h/a',
      'https:://:S3CR3T@h/a'
    ]) {
      expect(redactUrl(raw)).not.toContain('S3CR3T')
      expect(JSON.stringify(redactValue({ t: `Request to ${raw} failed` }))).not.toContain('S3CR3T')
      expect(serialize({ ...base, msg: `Request to ${raw} failed` })).not.toContain('S3CR3T')
    }
  })

  it('looks inside a parameter value for the credential it carries', () => {
    // A `?` is legal in a query, so the parser sees one parameter whose value happens to contain
    // another pair. Nothing above this reaches in there: the nested-scheme split needs a literal
    // `://`, and there is none here.
    expect(redactUrl('https://h/r?next=/x?token=S3CR3T')).not.toContain('S3CR3T')
    // The encoded form is what a correct client sends, and encoding hides both the `://` and the
    // `token=` from every pattern while hiding nothing from a reader of the log.
    expect(
      redactUrl(
        'https://h/oauth/authorize?client_id=1&redirect_uri=https%3A%2F%2Fapp%2Fcb%3Faccess_token%3DS3CR3T'
      )
    ).not.toContain('S3CR3T')
    // A whole URL under an innocently named parameter, which a direct caller used to be handed back
    // untouched.
    expect(redactUrl('https://h/redirect?url=https://other/a?token=S3CR3T')).not.toContain('S3CR3T')
    // The same, in the fragment and on the path that cannot be parsed at all.
    expect(redactUrl('https://h/a#next=/x?token=S3CR3T')).not.toContain('S3CR3T')
    expect(redactUrl('https://h/a#redirect_uri=https%3A%2F%2Fapp%3Ftoken%3DS3CR3T')).not.toContain(
      'S3CR3T'
    )
    expect(redactUrl('https://h:99999/r?next=/x?token=S3CR3T')).not.toContain('S3CR3T')
  })

  it('reaches a parameter nested two values deep', () => {
    const inner = encodeURIComponent('y?token=S3CR3T')
    expect(redactUrl(`https://h/a?u=${encodeURIComponent(`x?v=${inner}`)}`)).not.toContain('S3CR3T')
  })

  it('keeps every value of a repeated parameter, not only the one it redacted', () => {
    // Redacting used to be done with `set`, which drops every repeat of a name it touches, so a
    // second value under the same name vanished for being adjacent to a credential.
    const out = redactUrl('https://h/a?u=x?token=S3CR3T&u=keepme')
    expect(out).not.toContain('S3CR3T')
    expect(out).toContain('keepme')
  })

  it('leaves a parameter value carrying no credential exactly as it arrived', () => {
    // Examining a value must not rewrite it, or every innocent parameter would come back re-encoded
    // for having been looked at.
    for (const raw of [
      'https://h/a?ids=1,2&api-version=7.1',
      'https://h/a?jql=project%20%3D%20FID',
      'https://h/a?next=/board',
      'https://h/a?redirect_uri=https%3A%2F%2Fapp%2Fcb',
      'https://h/a?q=%zz',
      'https://h/a#/dashboard?filter=open'
    ]) {
      expect(redactUrl(raw)).toBe(raw)
    }
  })

  it('splits a nested URL whose scheme separator is mistyped', () => {
    // Splitting the run is one of two ways a nested URL is reached; searching the parameter value is
    // the other. Asserted through free text because that is the path every string takes to disk.
    const raw = 'https://h/redirect?url=https:://other/a?token=S3CR3T'
    expect(JSON.stringify(redactValue({ t: raw }))).not.toContain('S3CR3T')
    expect(serialize({ ...base, msg: raw })).not.toContain('S3CR3T')
    expect(serialize({ ...base, err: normalizeError(new Error(raw)) })).not.toContain('S3CR3T')
  })

  it('redacts the fragment and the authority of an unparseable URL too', () => {
    expect(redactUrl('https://h:99999/a#token=S3CR3T')).toBe(
      `https://h:99999/a#token=${REDACTED}`
    )
    expect(redactUrl('https://user:S3CR3T@h:99999/a')).toBe(
      `https://${REDACTED}:${REDACTED}@h:99999/a`
    )
  })

  it('leaves an unparseable URL that carries no credential alone', () => {
    expect(redactUrl('https://h:99999/a?ids=1,2&api-version=7.1')).toBe(
      'https://h:99999/a?ids=1,2&api-version=7.1'
    )
  })

  it('scans an unparseable URL in linear time', () => {
    // Without a delimiter in front of the name, every position in this run is a start position that
    // scans to the end looking for an `=` and backtracks from it.
    const raw = `https://h:99999/${'a'.repeat(160000)}?token=S3CR3T`
    const startedAt = Date.now()
    const out = redactUrl(raw)
    expect(Date.now() - startedAt).toBeLessThan(1000)
    expect(out).not.toContain('S3CR3T')
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
    'sig',
    'SIG',
    'adoSig',
    'ado_sig',
    'sigHash',
    'pats',
    'PATs',
    'adoPats',
    'sigs',
    'SIGs',
    'credential',
    'credentials',
    'azureCredentials',
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
    'ids',
    // The assignment family. An Azure storage signature is the credential name most likely to be
    // wanted next, and `sig` as a substring takes all of these with it - work item assignees and
    // workspace-to-project assignment being core domain concepts here. These are listed so that
    // adding `sig` the quick way fails loudly and points at the anchored way instead.
    'assign',
    'assigned',
    'assignee',
    'assignedAt',
    'assignProject',
    'assignToPane',
    'assignEntries',
    'assignments',
    'assignable',
    'signal',
    'signals',
    'signalled',
    'signature',
    'design',
    'designer',
    // Declined on evidence: a Jira issue key is this app's central identifier.
    'key',
    'keys',
    'issueKey',
    'sourceKey',
    'projectKey',
    'epicKey',
    'cacheKey'
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

  it('splits an acronym before a capitalised word', () => {
    // The rule that divides `PATPath` needs one capital of context and must not take more, so these
    // pin the shapes that would change if it were ever widened back to a run.
    expect(redactValue({ PATPath: 'CREDENTIAL' })).toEqual({ PATPath: REDACTED })
    for (const name of ['HTTPServer', 'XMLHttpRequest', 'IOError', 'ABCDef']) {
      expect(redactValue({ [name]: 'ordinary' })).toEqual({ [name]: 'ordinary' })
    }
  })

  it('reads a key of nothing but capitals in linear time', () => {
    // A run of capitals with no capital-then-lowercase in it: matching the run rather than one
    // character makes every start position rescan to the end and backtrack.
    const key = `${'A'.repeat(160000)}_PAT`
    const startedAt = Date.now()
    const out = redactValue({ [key]: 'CREDENTIAL' }) as Record<string, unknown>
    expect(Date.now() - startedAt).toBeLessThan(1000)
    expect(out[key]).toBe(REDACTED)
  })
})

/**
 * The redaction audit: every shape that has ever carried a credential past this module, and every
 * route a string can take to disk.
 *
 * This table is the only thing that knows what "covered" means, so it is maintained deliberately
 * rather than grown by accident. Twice the shapes it listed turned out to be a subset of the class
 * they were meant to represent - the nested URL was listed only in its unencoded form, and a
 * credential inside a parameter value was not listed at all - and both times the table was green
 * while the class leaked. A green audit proves the listed shapes are clean and nothing more, so a
 * shape belongs here the moment its class is understood, not once a defect is found.
 *
 * Each group states the class it stands for and the failure the group was written against, so a
 * reader can tell what a shape is guarding rather than guessing from its text. Accepted limits are
 * not here: they live in their own block below, asserted as limits, so nothing in this table is
 * ambiguous about whether it is supposed to pass.
 */
describe('the redaction audit', () => {
  const SECRET = 'SECRETVALUE'
  const enc = encodeURIComponent

  interface AuditGroup {
    /** The class of input, and the defect the group exists to keep closed. */
    covers: string
    was: string
    shapes: Record<string, string>
  }

  const audit: AuditGroup[] = [
    {
      covers: 'a separator inside the query, ahead of the credential',
      was: 'the URL run was cut at the separator, so everything past it - the credential included - was emitted without ever being examined',
      shapes: {
        'comma-separated ids': `GET https://dev.azure.com/o/_apis/wit/workitems?ids=297,299,300&api-version=7.1&access_token=${SECRET} failed`,
        'comma-separated fields': `https://jira.example/rest/api/2/search?fields=summary,status&token=${SECRET}`,
        'a comma in the path': `https://h/a,b?token=${SECRET}`,
        'a semicolon in an earlier parameter': `https://h/a?x=1;2&token=${SECRET}`,
        'both separators at once': `https://h/a?ids=1;2,3&pat=${SECRET}&more=1`,
        'double quotes in an earlier parameter': `https://h/a?q="x"&token=${SECRET}`,
        'single quotes in an earlier parameter': `https://h/a?q='y'&pat=${SECRET}`
      }
    },
    {
      covers: 'punctuation and quotation around a URL in prose',
      was: 'trimming what closes a sentence was done by ending the run early, which cut the credential off the end of it instead',
      shapes: {
        'angle brackets around it': `<https://h/a?token=${SECRET}>`,
        'quoted': `"https://h/a?token=${SECRET}"`,
        'bracketed': `(see https://h/a?token=${SECRET})`,
        'sentence-final': `Failed at https://h/a?token=${SECRET}.`,
        'preceded by a comma': `prefix,https://h/a?token=${SECRET}`,
        'a comma inside the secret value': `https://h/a?token=${SECRET},x`
      }
    },
    {
      covers: 'two URLs written into one whitespace-free run',
      was: 'the second URL was swallowed into a parameter value of the first, or ended the run and escaped - and then the split that separates them was deleted outright, on the strength of this group holding only the two query-parameter instances and none of the authority ones',
      shapes: {
        'separated by a semicolon': `two https://h/a?token=${SECRET};https://h/b?token=${SECRET} done`,
        'the second one in a fragment': `https://h/a#token=${SECRET};https://h/b?pat=${SECRET}`,
        // The instances this group was missing, and the reason the split cannot be deleted: a
        // credential in the second URL's authority is reached by the split and by nothing else, since
        // the path is never scanned and the authority pattern is anchored at the start of a string.
        'joined into the path': `https://api.example.com/v1/https://alice:${SECRET}@internal/redirect`,
        'joined into the path, in prose': `GET https://api.example.com/v1/https://alice:${SECRET}@internal/redirect 500`,
        'semicolon, credential in the authority': `two https://h/a?ids=1;https://user:${SECRET}@h/b done`,
        'comma, credential in the authority': `fatal: cannot access https://h/a?x=1,https://user:${SECRET}@h/b`,
        'a double join with no separator': `https://h/a/https://user:${SECRET}@h/b`
      }
    },
    {
      covers: 'a credential in the authority rather than the query',
      was: 'only the query was searched, so basic auth against Azure DevOps put the token somewhere nothing looked',
      shapes: {
        'a user and a password': `https://user:${SECRET}@h/a`,
        'a password alone': `https://:${SECRET}@h/a`,
        'alongside an unparseable port': `https://user:${SECRET}@h:99999/a`,
        'behind a doubled scheme colon': `https:://user:${SECRET}@h/a`,
        'behind a tripled scheme colon': `https::://user:${SECRET}@h/a`,
        'a password alone behind a doubled colon': `https:://:${SECRET}@h/a`,
        'quoted in prose behind a doubled colon': `Request to https:://user:${SECRET}@h/a failed`
      }
    },
    {
      covers: 'a credential in the fragment',
      was: 'the fragment was not searched at all, and then was searched only past the first question mark, leaving everything ahead of it unexamined',
      shapes: {
        'on its own': `https://h/a#token=${SECRET}`,
        'an implicit-flow response': `https://h/a#access_token=${SECRET}&expires_in=3600`,
        'behind a query': `https://h/a?ids=1,2#token=${SECRET}`,
        'on a hash route': `https://h/a#/board?token=${SECRET}`,
        'with a comma in the value': `https://h/a#token=${SECRET},x`,
        'at the end of a sentence': `Opened https://h/a#pat=${SECRET}.`,
        'ahead of a question mark in a later value': `https://h/a#access_token=${SECRET}&redirect=/a?b=1`,
        'ahead of a bare question mark': `https://h/a#access_token=${SECRET}&state=a?b`,
        'between two innocent parameters': `https://h/a#a=1&token=${SECRET}&u=/x?y=1`,
        'ahead of a question mark of its own': `https://h/a#token=${SECRET}?x=1`,
        'twice, either side of a question mark': `https://h/a#token=${SECRET}?token=${SECRET}`,
        'on a hash route with a later question mark': `https://h/a#/board?a=1&token=${SECRET}&r=/x?y=1`,
        'on a URL that cannot be parsed': `https://h:99999/a#token=${SECRET}`,
        'on a URL that cannot be parsed, past a question mark': `https://h:99999/a#access_token=${SECRET}&redirect=/a?b=1`
      }
    },
    {
      covers: 'a URL too malformed for the parser to accept',
      was: 'a string that failed to parse was handed back verbatim, on the belief that it could not be carrying a credential',
      shapes: {
        'an out-of-range port': `https://h:99999/a?token=${SECRET}`,
        'a non-numeric port': `https://h:port/a?token=${SECRET}`,
        'an unclosed IPv6 host': `https://[::1/a?token=${SECRET}`,
        'a stray percent': `https://h%/a?token=${SECRET}`,
        'a doubled scheme colon': `https:://h/a?token=${SECRET}`,
        'with an innocent parameter beside it': `https://h:99999/a?ids=1,2&pat=${SECRET}`,
        'quoted in prose': `Request to https://h:99999/a?token=${SECRET} failed with 400`
      }
    },
    {
      covers: 'a credential named inside a parameter value',
      was: 'a redirect target carries its own parameters, and nothing reached them - percent-encoding hid the scheme, and a question mark is legal in a query so the parser saw one value',
      shapes: {
        'a question mark in an earlier value': `https://h/r?next=/x?token=${SECRET}`,
        'a semicolon separating pairs': `https://h/a?x=1;token=${SECRET}`,
        'an encoded semicolon inside a value': `https://h/a?state=a%3D1%3Btoken%3D${SECRET}`,
        'an encoded redirect target': `https://h/oauth/authorize?client_id=1&redirect_uri=https%3A%2F%2Fapp%2Fcb%3Faccess_token%3D${SECRET}`,
        'a URL under an innocent name': `https://h/redirect?url=https://other/a?token=${SECRET}`,
        'a URL under an innocent name, doubled colon': `https://h/redirect?url=https:://other/a?token=${SECRET}`,
        'in the fragment': `https://h/a#next=/x?token=${SECRET}`,
        'encoded, in the fragment': `https://h/a#redirect_uri=https%3A%2F%2Fapp%3Ftoken%3D${SECRET}`,
        'on a URL that cannot be parsed': `https://h:99999/r?next=/x?token=${SECRET}`,
        'encoded, on a URL that cannot be parsed': `https://h:99999/r?redirect_uri=https%3A%2F%2Fapp%3Ftoken%3D${SECRET}`,
        'two values deep': `https://h/a?u=${enc(`x?v=${enc(`y?token=${SECRET}`)}`)}`,
        'encoded, quoted in prose': `GET https://h/oauth?redirect_uri=${enc(`https://app/cb?access_token=${SECRET}`)} 302`,
        'encoded, between innocent parameters': `https://h/r?a=1&next=%2Fx%3Ftoken%3D${SECRET}&b=2`
      }
    },
    {
      covers: 'a credential in the authority of a URL nested inside a parameter value',
      was: 'searching a value looked only for named parameters, never for userinfo, so basic auth inside an encoded redirect target went unexamined - the one surface the two scanners disagreed about',
      shapes: {
        'a user and a password, encoded': `https://h/r?next=${enc(`https://user:${SECRET}@other/a`)}`,
        'a password alone, encoded': `https://h/r?next=${enc(`https://:${SECRET}@other/a`)}`,
        'unencoded, under an innocent name': `https://h/r?next=https://user:${SECRET}@other/a`,
        'in the fragment, encoded': `https://h/a#next=${enc(`https://user:${SECRET}@other/a`)}`,
        'on a URL that cannot be parsed': `https://h:99999/r?next=${enc(`https://user:${SECRET}@other/a`)}`,
        'two values deep': `https://h/a?u=${enc(`v=${enc(`https://user:${SECRET}@other/a`)}`)}`,
        'quoted in prose': `GET https://h/r?next=${enc(`https://user:${SECRET}@other/a`)} 302`
      }
    },
    {
      covers: "a credential the value's own shape betrays, with no name to read",
      was: 'redaction worked only from names, so a token under a parameter name outside the vocabulary, inside a blob, or in an authorization header quoted in prose had nothing to be recognised by',
      shapes: {
        'a token under an innocent parameter name': `https://h/a?state=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.${SECRET}`,
        'a token inside a JSON blob': `response body {"id_token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.${SECRET}"}`,
        'a token in the fragment of an implicit flow': `https://app/cb#id_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.${SECRET}`,
        'an authorization header in prose': `Authorization: Basic ${SECRET}aaaaaaaaa`,
        'a bearer header in prose': `request failed with Bearer ${SECRET}aaaaaaaaa`,
        // The shape rules once ran on free text and on parameter values but never on a parsed URL's
        // own path or an `=`-less fragment, which meant a `URL` instance in the payload - routed
        // straight to URL redaction - kept its token.
        'a token in the path of a parsed URL': `https://h/reset/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.${SECRET}`,
        'a token in a fragment holding no parameters': `https://h/a#eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.${SECRET}`,
        // Scanning the path for the double-join closed this too, which used to be a documented gap on
        // the grounds that the path was never looked at.
        'a matrix parameter in the path': `https://h/a;token=${SECRET}?ids=1`
      }
    },
    {
      covers: 'how the credential is named',
      was: 'the name was matched with the wrong sensitivity to case, or the scheme was',
      shapes: {
        'an uppercased parameter name': `https://h/a?ids=1,2&ACCESS_TOKEN=${SECRET}`,
        'an uppercased scheme': `HTTPS://h/a?ids=1,2&token=${SECRET}`,
        // A shared access signature, reached by its name because its value cannot be told from any
        // other base64. Anchored as a word, so the assignment family is untouched by it.
        'a shared access signature': `https://h/a?sv=2021-08-06&sr=b&sig=${SECRET}`,
        'a signature nested in a parameter value': `https://h/r?next=${enc(`https://blob/x?sig=${SECRET}`)}`
      }
    },
    {
      covers: 'a credential named in free text, nowhere near a URL',
      was: 'the vocabulary was reachable only from inside a URL, so a settings line and a stringified configuration both went to disk intact - and those are the shapes a log line carrying raw file text actually takes',
      shapes: {
        'a settings line': `settings: pat=${SECRET} project=SPOT`,
        'a stringified configuration': `{"orgUrl":"https://dev.azure.com/o","pat":"${SECRET}"}`,
        'an environment dump': `AZURE_DEVOPS_PAT=${SECRET} HOME=/Users/x`,
        'a header written as a header': `set-cookie: session=${SECRET}`,
        'a credential named at the end of a sentence': `read pat=${SECRET}.`
      }
    },
    {
      covers: 'a URL used as a key rather than a value',
      was: 'a key was judged for whether its value was a credential and then written out as it stood, so a cache keyed by request URL logged its tokens as key names',
      shapes: {
        'a cache key quoted in prose': `cache miss for https://h/a?token=${SECRET}`
      }
    }
  ]

  /**
   * Every route a string can travel to reach the file. The first four are how a caller's own strings
   * arrive; the fifth is what an HTTP logger does, redacting a URL itself and putting the result in
   * the payload; the sixth is `redactUrl` judged alone, which is not a route to disk but is exported
   * and so must not be a trap.
   */
  function routes(shape: string): Record<string, string> {
    const err = { name: 'Error', message: shape, stack: `Error: ${shape}\n    at frame` }
    const taken: Record<string, string> = {
      'a payload value': JSON.stringify(redactValue({ text: shape })),
      'a payload key': JSON.stringify(redactValue({ [shape]: 1 })),
      'the message': serialize({ ...base, msg: shape }),
      'an error message and stack': serialize({ ...base, err }),
      'a payload value already passed through redactUrl': serialize({
        ...base,
        data: { url: redactUrl(shape) }
      })
    }
    // `redactUrl` is only ever asked about something that claims to be a URL. Prose is not one, and
    // neither is a stringified object that merely contains one - both reach disk by the routes above.
    if (/^[a-z][a-z0-9+.-]*:+\/\/\S+$/i.test(shape)) taken['redactUrl alone'] = redactUrl(shape)
    return taken
  }

  let counted = 0
  for (const group of audit) {
    for (const [name, shape] of Object.entries(group.shapes)) {
      counted += 1
      it(`${group.covers}: ${name}`, () => {
        for (const [route, output] of Object.entries(routes(shape))) {
          expect(output, `leaked through ${route}`).not.toContain(SECRET)
        }
        // Redaction reaches the same text twice by design: an HTTP logger redacts a URL itself and
        // `serialize` redacts the payload that result lands in. So a rule that treats a marker
        // already written as a value worth taking corrupts a line it had already made safe, and
        // corrupts it further on every pass. Stability is the property; the audit above measures
        // only whether the secret survived, which is why it read as green through this.
        const once = redactValue(shape) as string
        expect(redactValue(once), 'redacting an already-redacted shape changed it again').toBe(once)
      })
    }
  }

  it('covers every shape and route the audit claims', () => {
    // The counts are asserted so that deleting a shape is a visible change rather than a quiet one.
    expect(counted).toBe(86)
    expect(Object.keys(routes('https://h/a?token=x'))).toHaveLength(6)
    expect(Object.keys(routes('a https://h/a?token=x b'))).toHaveLength(5)
    expect(Object.keys(routes('{"pat":"x"}'))).toHaveLength(5)
  })
})

/**
 * Recognising a credential by the shape of its value, and - far more importantly - not recognising
 * anything else.
 *
 * The kept half is the dangerous half, and it is built from this repo's own value shapes rather than
 * from imagination. A false positive here destroys a git object name or a revision guard silently,
 * which is the unanchored-`pat` defect moved from key names to values, and this app's records are full
 * of long opaque strings that are not credentials.
 */
describe('the shapes that mean a credential', () => {
  const JWT =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0'
  // How this app actually sends its Azure DevOps credential: the token base64-encoded behind `Basic`.
  const BASIC = Buffer.from(':2sq5ixpgkhfmn7ptbxwzvcdjy4oearlu6t3i').toString('base64')

  it('redacts a JSON Web Token wherever it sits', () => {
    expect(redactValue({ state: JWT })).toEqual({ state: REDACTED })
    expect(redactValue({ note: `token was ${JWT} at the time` })).toEqual({
      note: `token was ${REDACTED} at the time`
    })
    // Under a parameter name that means nothing to the vocabulary, and inside a blob.
    expect(redactUrl(`https://h/a?state=${JWT}`)).not.toContain('eyJzdWIi')
    expect(serialize({ ...base, msg: `body {"data":"${JWT}"}` })).not.toContain('eyJzdWIi')
  })

  it('redacts the value of an authorization scheme quoted in prose', () => {
    // The limit an HTTP client is most likely to produce: no URL in the text, so nothing else here
    // ever looked at it.
    const out = redactValue({ note: `Authorization: Basic ${BASIC}` }) as { note: string }
    expect(out.note).toBe(`Authorization: Basic ${REDACTED}`)
    expect(redactValue({ h: `Bearer ${'a'.repeat(40)}` })).toEqual({ h: `Bearer ${REDACTED}` })
    // The scheme word is kept: which scheme failed is worth knowing and is not a secret.
    expect(out.note).toContain('Basic')
  })

  const kept: Record<string, string> = {
    'a git object name': '9f2a1c4e8b7d6a5f3e2c1b0a9d8c7f6e5a4b3c2d',
    'an abbreviated git object name': '9f2a1c4',
    'a ten-character git object name': '9f2a1c4e8b',
    'a revision guard, which is sha256 hex': 'a'.repeat(64),
    'a uuid, as every id here is': '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    'a composed session id': '3f2504e0-4f89-11d3-9a0c-0305e82c3301:2',
    'an absolute file path': '/Users/x/Projects/Intersect/src/common/logging/record.ts',
    'a worktree path': '/Users/x/Projects/Intersect-logging/src/core/pty/nodePtySpawn.ts',
    'a branch name': 'feature/gh43-dashboard-zones',
    'base64 image data': `iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB${'CAYAAAA'.repeat(40)}`,
    'a jql query': 'project = FID AND status != Done ORDER BY created DESC',
    'an api version': '7.1',
    'a semantic version': '1.24.3',
    'a dotted package identifier': 'lodash.merge-4.6.2',
    'prose mentioning basic authentication': 'Basic authentication failed for the project',
    'prose mentioning a bearer token': 'Bearer token missing from the request',
    'an attention marker payload': Buffer.from('waiting for your input').toString('base64'),
    'a terminal title': 'npm run dev - Intersect - zsh',
    'an iso timestamp': '2026-07-28T09:14:02.417Z'
  }

  for (const [name, value] of Object.entries(kept)) {
    it(`leaves ${name} alone`, () => {
      expect(redactValue({ v: value })).toEqual({ v: value })
      expect(redactValue({ note: `saw ${value} here` })).toEqual({ note: `saw ${value} here` })
    })
  }

  it('redacts what follows an authorization scheme even when it is not a credential', () => {
    // The kept table above varies the value and never the context, which hid this. An authorization
    // scheme word followed by twenty unbroken token characters is redacted whatever those characters
    // are, and four of them are rows in that table. The alternative is narrowing the value to exclude
    // `/`, which truncates a real base64 credential at its first slash and leaks the rest - so this is
    // the direction chosen, and it is recorded here so that widening the class fails loudly.
    for (const value of [
      '/Users/x/Projects/Intersect/src/common/logging/record.ts',
      'feature/gh43-dashboard-zones-and-more',
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
    ]) {
      expect(redactValue({ note: `Basic ${value}` }), value).toEqual({ note: `Basic ${REDACTED}` })
    }
    // Ordinary prose is unaffected, because it has no such run.
    expect(redactValue({ note: 'Basic authentication failed for the project' })).toEqual({
      note: 'Basic authentication failed for the project'
    })
  })

  it('rejects the shapes that cannot be told apart from an innocent value', () => {
    // Recorded as behaviour rather than as an aspiration. A hook token is thirty-two random bytes as
    // hex and a revision guard is sha256 hex: the same shape, one a credential and one logged in
    // dozens of places. Matching it would destroy the innocent one every time.
    const hookToken = 'b'.repeat(64)
    expect(redactValue({ v: hookToken })).toEqual({ v: hookToken })
    // A shared access signature is base64 of thirty-two bytes, which is also what an attention marker
    // payload looks like, so the value is not matched on its shape. That one is reached by its name
    // instead - under a name nothing recognises, the same bytes survive.
    const signature = Buffer.from('c'.repeat(32)).toString('base64')
    expect(redactUrl(`https://h/a?blob=${signature}`)).toContain(signature)
    expect(redactUrl(`https://h/a?sig=${signature}`)).not.toContain(signature)
  })
})

/**
 * The count of what redaction removed, which is what makes a miss visible.
 */
describe('the redaction count', () => {
  it('is absent when nothing was redacted, so an innocent line is unchanged', () => {
    const parsed = JSON.parse(serialize({ ...base, data: { status: 503 } }))
    expect(parsed).not.toHaveProperty('redactions')
  })

  it('reports how many markers were written', () => {
    const one = JSON.parse(serialize({ ...base, data: { token: 'x' } }))
    expect(one.redactions).toBe(1)
    const three = JSON.parse(
      serialize({ ...base, data: { token: 'x', pat: 'y', note: 'https://h/a?apikey=z' } })
    )
    expect(three.redactions).toBe(3)
    // A redacted authority writes two markers for one credential, which is what "markers" means.
    expect(JSON.parse(serialize({ ...base, msg: 'https://u:p@h/a' })).redactions).toBe(2)
  })

  it('survives the record being shrunk to fit', () => {
    const parsed = JSON.parse(
      serialize({ ...base, data: { token: 'x', blob: 'y'.repeat(MAX_RECORD_BYTES * 2) } })
    )
    expect(parsed.data.truncated).toBe(true)
    // Counted before shedding, so it still reports what redaction removed from the record as given.
    expect(parsed.redactions).toBe(1)
  })

  it('cannot be forged by text a caller wrote the marker into', () => {
    // Counted where each marker is written, not by searching the finished line, so upstream text
    // claiming to be redacted does not inflate the anomaly signal.
    const parsed = JSON.parse(serialize({ ...base, data: { note: `already ${REDACTED} elsewhere` } }))
    expect(parsed).not.toHaveProperty('redactions')
    const one = JSON.parse(
      serialize({ ...base, data: { note: `already ${REDACTED} elsewhere`, token: 'x' } })
    )
    expect(one.redactions).toBe(1)
  })

  it('survives a record degrading all the way to its identity', () => {
    // The count is the anomaly signal, so a record shrinking is no reason for it to disappear.
    const parsed = JSON.parse(serialize({ ...base, ts: 'x'.repeat(20000), data: { token: 'x' } }))
    expect(parsed.data.truncated).toBe(true)
    expect(parsed.redactions).toBe(1)
  })

  it('is left off a line that failed to serialise, where it would mean nothing', () => {
    const hostile = {
      ...base,
      get data(): never {
        throw new Error('unreadable record')
      }
    }
    const parsed = JSON.parse(serialize(hostile))
    expect(parsed.data.serializeFailed).toBe(true)
    expect(parsed).not.toHaveProperty('redactions')
  })

  it('keeps the line inside the cap even when it is what tips the balance', () => {
    // The field is added before the size stages run, so it is measured like everything else.
    const line = serialize({ ...base, data: { token: 'x', blob: 'y'.repeat(MAX_RECORD_BYTES) } })
    expect(utf8Bytes(line)).toBeLessThanOrEqual(MAX_RECORD_BYTES)
  })
})

/**
 * A marker written into the text redaction is about to read.
 *
 * Recognising one is what keeps redaction stable across the two passes it makes on the way to disk.
 * The danger is recognising it too loosely: a value that merely begins with the marker is a value, and
 * skipping it on the strength of its first ten characters hands a caller a way to hide a credential
 * behind text it chose. Both directions are asserted here because the first fix for the one broke the
 * other.
 */
describe('a marker already present in the text', () => {
  const SECRET = 'REALSECRETVALUE123456789'

  it('is left alone when it is the whole value', () => {
    expect(redactValue(`pat=${REDACTED}`)).toBe(`pat=${REDACTED}`)
    expect(redactValue(`pat="${REDACTED}"`)).toBe(`pat="${REDACTED}"`)
    expect(redactValue(`read pat=${REDACTED}.`)).toBe(`read pat=${REDACTED}.`)
    expect(redactValue(`{"pat":"${REDACTED}"}`)).toBe(`{"pat":"${REDACTED}"}`)
  })

  it('does not shield a credential written behind it', () => {
    for (const shape of [
      `pat=${REDACTED}${SECRET}`,
      `pat="${REDACTED}${SECRET}"`,
      `{"pat":"${REDACTED}${SECRET}"}`,
      `pat=${REDACTED}${REDACTED}${SECRET}`,
      `https://h/p?token=${REDACTED}${SECRET}`
    ]) {
      expect(redactValue(shape), `shielded by a marker in ${shape}`).not.toContain(SECRET)
      expect(serialize({ ...base, msg: shape }), `shielded by a marker in ${shape}`).not.toContain(
        SECRET
      )
    }
  })

  it('leaves a payload that has already been through redaction unchanged', () => {
    // A key naming a credential is marked whether or not it already held the marker, so what has to
    // hold here is that the value does not accumulate: this is the shape a re-logged payload takes.
    const once = redactValue({ pat: 'abcdefghijklmnopqrstuvwxyz012345', note: `at ${REDACTED}` })
    expect(redactValue(once)).toEqual(once)
  })
})

/**
 * What redaction does not reach, asserted rather than merely written down.
 *
 * These are limits of naming credentials instead of detecting them, not defects with a fix pending.
 * They are pinned here so the scope the comments claim and the scope the code has cannot drift apart,
 * and so that anyone who later makes one of them pass has to come here and say so deliberately.
 */
describe('the limits of a deny-list, held on purpose', () => {
  it('stops looking into parameter values at the bound', () => {
    // Two levels of nesting reach every shape seen in practice. Following the nesting as far as it
    // went would let a crafted value recurse as deep as it is long, so the bound is the point rather
    // than a shortfall - and the value beyond it is left exactly as it stands.
    const inner = encodeURIComponent('y?token=SECRETVALUE')
    const beyond = encodeURIComponent(`x?v=${encodeURIComponent(`y?w=${inner}`)}`)
    expect(redactUrl(`https://h/a?u=${beyond}`)).toContain('SECRETVALUE')
  })

  it('cannot see a credential written as a bare path segment', () => {
    // The path is scanned now, but only for things that are named or shaped. A segment that is just a
    // value has no name to be recognised by, and nothing distinguishes it from a work item id.
    expect(redactUrl('https://h/tokens/SECRETVALUE')).toContain('SECRETVALUE')
    // A session id in a matrix parameter is named, but not by a name this vocabulary holds.
    expect(redactUrl('https://h/a;jsessionid=SECRETVALUE?ids=1')).toContain('SECRETVALUE')
  })

  it('cannot see a credential whose name is outside the vocabulary', () => {
    // The vocabulary holds what there is evidence for. `hmac` and a bare `key` are credential names it
    // does not hold, and recognising every name that might be one means redacting every value of every
    // parameter, which costs the diagnostic value the log exists for. Adding a name needs evidence
    // that this app meets it, not the observation that it could exist.
    expect(redactUrl('https://h/a?hmac=SECRETVALUE')).toContain('SECRETVALUE')
    expect(redactValue({ hmac: 'SECRETVALUE' })).toEqual({ hmac: 'SECRETVALUE' })
    expect(redactUrl('https://h/a?key=SECRETVALUE')).toContain('SECRETVALUE')
  })

  it('cannot see a credential inside a value that is not a name and a value', () => {
    const blob = Buffer.from('{"token":"SECRETVALUE"}').toString('base64')
    expect(redactUrl(`https://h/a?state=${blob}`)).toContain(blob)
  })

  it('cannot see a credential in prose whose name it does not hold', () => {
    // Names and shapes both reach into free text now, so what survives is only a name the vocabulary
    // does not hold, carrying a value with no shape of its own. `session` and `x-request-signature`
    // are two; `set-cookie` is not, because it contains `cookie`.
    for (const line of ['session=SECRETVALUE', 'x-request-signature: SECRETVALUE']) {
      expect(redactValue({ note: line }), line).toEqual({ note: line })
    }
    expect(redactValue({ note: 'set-cookie: session=SECRETVALUE' })).toEqual({
      note: `set-cookie: ${REDACTED}`
    })
  })

  it('needs twenty characters behind an authorization scheme before it will act', () => {
    // Disclosed rather than left to be discovered: the floor is what keeps the rule off English, and
    // it means a short credential quoted this way survives.
    expect(redactValue({ note: 'Authorization: Bearer short' })).toEqual({
      note: 'Authorization: Bearer short'
    })
    expect(redactValue({ note: `Authorization: Bearer ${'a'.repeat(20)}` })).toEqual({
      note: `Authorization: Bearer ${REDACTED}`
    })
  })
})

/**
 * One time budget on the public entry point, rather than a guard on each pattern that might stall.
 *
 * Seven expressions in this module have had quadratic backtracking. Three of them carried their own
 * timing guard, and the seventh was found in the one that did not - and two of the seven arrived as
 * fixes for earlier ones. A budget measured through `serialize` cannot be outflanked that way: a new
 * pattern added later is inside it the moment a shape is added here, and no shape needs to know which
 * expression it is aimed at.
 */
describe('no shape stalls the serializer', () => {
  const dotted = 'a.'.repeat(128000)
  const chain = (): NormalizedError => {
    const frames = '    at frame\n'.repeat(115)
    let err: NormalizedError = { name: 'Error', message: 'root', stack: `Error: root\n${frames}` }
    for (let i = 0; i < 5; i++) {
      err = { name: 'Error', message: `wrap${i}`, stack: `Error: wrap${i}\n${frames}`, cause: err }
    }
    return err
  }

  const shapes: Record<string, LogRecord> = {
    'a dotted run before a URL': { ...base, msg: `${dotted} https://h/a?token=x` },
    'a dotted run after a URL': { ...base, msg: `https://h/a?token=x ${dotted}` },
    'a dotted run glued to a URL': { ...base, msg: `${dotted}https://h/a?token=x` },
    'a colon run before a URL': { ...base, msg: `${'a:'.repeat(80000)} https://h/a?token=x` },
    'a period run ending in a character': { ...base, msg: `https://h/a${'.'.repeat(160000)}x` },
    'a comma run ending in a character': { ...base, msg: `https://h/a${','.repeat(160000)}x` },
    'a quote run ending in a character': { ...base, msg: `https://h/a${'"'.repeat(160000)}x` },
    'a name run with no equals': { ...base, msg: `https://h:99999/${'a'.repeat(160000)}?token=x` },
    'many URLs glued into one run': {
      ...base,
      msg: Array.from({ length: 20000 }, (_, i) => `https://h/${i}?token=x`).join(';')
    },
    'a key of nothing but capitals': { ...base, data: { [`${'A'.repeat(160000)}_PAT`]: 1 } },
    // The shape rules: a run that opens like a token but never completes, and many scheme words whose
    // value is too short to match, are the shapes that would make either one backtrack.
    'a token prefix that never completes': { ...base, msg: `eyJ${'a'.repeat(160000)}` },
    'a token prefix with one dot and no second': {
      ...base,
      msg: `eyJ${'a'.repeat(80000)}.${'b'.repeat(80000)}`
    },
    'forty thousand scheme words with short values': {
      ...base,
      msg: 'Bearer no '.repeat(40000)
    },
    // Reading each value back by name is a scan of the whole list per parameter. A run of glued URLs
    // never showed it, because every one of those carries a single parameter.
    'one URL of forty thousand parameters': {
      ...base,
      msg: `https://h/a?${Array.from({ length: 40000 }, (_, i) => `k${i}=v${i}`).join('&')}`
    },
    'a fragment of forty thousand parameters': {
      ...base,
      msg: `https://h/a#${Array.from({ length: 40000 }, (_, i) => `k${i}=v${i}`).join('&')}`
    },
    'a cause chain four thousand deep': {
      ...base,
      level: 'error',
      err: Array.from({ length: 4000 }).reduce<NormalizedError>(
        (cause) => ({ name: 'Error', message: 'wrapped', cause }),
        { name: 'Error', message: 'root' }
      )
    },
    'a long encoded parameter value': { ...base, msg: `https://h/a?u=${'%41'.repeat(53000)}` },
    'a value of many encoded pairs': { ...base, msg: `https://h/a?u=${'k%3Dv%26'.repeat(20000)}` },
    'a deeply nested encoded value': {
      ...base,
      msg: `https://h/a?u=${Array.from({ length: 12 }).reduce<string>((inner) => encodeURIComponent(`x?v=${inner}`), 'token=x')}`
    },
    'a key that is a long URL': { ...base, data: { [`https://h/${dotted}?token=x`]: 1 } },
    'a payload far over the cap': { ...base, data: { blob: 'x'.repeat(MAX_RECORD_BYTES * 8) } },
    'a wrapped error chain': { ...base, level: 'error', err: chain() },
    'every field oversized at once': {
      ...base,
      ts: 'é'.repeat(20000),
      msg: dotted,
      data: { blob: 'x'.repeat(MAX_RECORD_BYTES * 4) },
      err: chain()
    }
  }

  for (const [name, record] of Object.entries(shapes)) {
    it(`stays inside the budget: ${name}`, () => {
      const startedAt = Date.now()
      const line = serialize(record)
      expect(Date.now() - startedAt).toBeLessThan(500)
      expect(utf8Bytes(line)).toBeLessThanOrEqual(MAX_RECORD_BYTES)
    })
  }

  /**
   * A budget catches a stall in a shape somebody listed. This catches the shape of the stall itself.
   *
   * Eight of the nine superlinear defects in this module were found by someone measuring a case they
   * happened to think of, and the eighth was in a surface the budget above already covered - one URL
   * of many parameters, where the list only ever held many URLs of one parameter each. A growth
   * assertion does not need the case to be thought of: quadratic work at four times the size costs
   * sixteen times as much, and linear work costs four, so anything sixteen-ish fails whichever
   * expression is holding it.
   */
  const growth: Record<string, (size: number) => LogRecord> = {
    'parameters in one query': (size) => ({
      ...base,
      msg: `https://h/a?${Array.from({ length: size }, (_, i) => `k${i}=v${i}`).join('&')}`
    }),
    'parameters in one fragment': (size) => ({
      ...base,
      msg: `https://h/a#${Array.from({ length: size }, (_, i) => `k${i}=v${i}`).join('&')}`
    }),
    'characters in one key': (size) => ({ ...base, data: { [`${'A'.repeat(size)}_PAT`]: 1 } }),
    'characters of punctuation after a URL': (size) => ({
      ...base,
      msg: `https://h/a${'.'.repeat(size)}x`
    }),
    'characters that look like a scheme': (size) => ({
      ...base,
      msg: `${'a.'.repeat(size / 2)} https://h/a?token=x`
    }),
    'links in one cause chain': (size) => ({
      ...base,
      level: 'error',
      err: Array.from({ length: size }).reduce<NormalizedError>(
        (cause) => ({ name: 'Error', message: 'wrapped', cause }),
        { name: 'Error', message: 'root' }
      )
    }),
    'characters in one encoded value': (size) => ({
      ...base,
      msg: `https://h/a?u=${'%41'.repeat(size)}`
    }),
    'characters after a token prefix': (size) => ({ ...base, msg: `eyJ${'a'.repeat(size)}` }),
    'scheme words with values too short to match': (size) => ({
      ...base,
      msg: 'Bearer no '.repeat(size)
    }),
    'separators in one free-text line': (size) => ({ ...base, msg: 'a:1 '.repeat(size) }),
    // Structure, not text. Nothing here would have moved a text shape, so a future quadratic in the
    // walk over a record's own shape would have gone unnoticed by every row above.
    'properties in one object': (size) => ({
      ...base,
      data: Object.fromEntries(Array.from({ length: size }, (_, i) => [`k${i}`, i]))
    }),
    'levels of nesting in one object': (size) => ({
      ...base,
      data: { root: Array.from({ length: size }).reduce<unknown>((inner) => ({ inner }), 1) }
    }),
    'entries in one map': (size) => ({
      ...base,
      data: { m: new Map(Array.from({ length: size }, (_, i) => [`k${i}`, i])) }
    }),
    'members in one set': (size) => ({
      ...base,
      data: { s: new Set(Array.from({ length: size }, (_, i) => i)) }
    }),
    'items in one array': (size) => ({
      ...base,
      data: { a: Array.from({ length: size }, (_, i) => `v${i}`) }
    })
  }

  /**
   * The smallest measurement the ratio may be taken from. Below it the timer's own noise dominates and
   * the ratio permits whatever the floor divided by the real cost allows, which is how a shape costing
   * a thirtieth of a millisecond silently tolerated eighty-fold growth.
   */
  const FLOOR_MS = 1

  const elapsed = (record: LogRecord): number => {
    const startedAt = performance.now()
    serialize(record)
    return performance.now() - startedAt
  }

  for (const [name, build] of Object.entries(growth)) {
    it(`grows no worse than linearly with ${name}`, () => {
      // The input is enlarged until the small measurement clears the floor on its own, rather than the
      // ratio being loosened to accommodate a measurement too small to mean anything.
      let size = 20000
      let small = 0
      while (size <= 320000) {
        elapsed(build(size))
        small = elapsed(build(size))
        if (small >= FLOOR_MS) break
        size *= 2
      }
      if (small < FLOOR_MS) {
        // Still unmeasurable at the largest size, which means the work does not grow with this input
        // at all - a stronger result than a linear ratio, and the right one for a cause chain, whose
        // length is clamped before any of the work begins.
        expect(elapsed(build(size)), `${name} became measurable`).toBeLessThan(FLOOR_MS)
        return
      }
      const large = elapsed(build(size * 4))
      // Four times the input. Linear would be about 4, quadratic about 16; 10 leaves room for noise
      // while still failing on genuinely quadratic growth.
      expect(large / small, `${name} grew ${(large / small).toFixed(1)}x`).toBeLessThan(10)
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
    // The record's own payload property refuses to be read, so nothing downstream can run.
    const hostile = {
      ...base,
      get data(): never {
        throw new Error('unreadable record')
      }
    }
    const line = serialize(hostile)
    expect(utf8Bytes(line)).toBeLessThanOrEqual(MAX_RECORD_BYTES)
    const parsed = JSON.parse(line)
    expect(parsed.msg).toBe('board fetched')
    expect(parsed.ts).toBe(base.ts)
    expect(parsed.data.truncated).toBe(true)
    // Distinguishable from a record merely shed for size, or a defect here reads as sparse logging.
    expect(parsed.data.serializeFailed).toBe(true)
  })

  it('emits a line even when the identifying fields themselves cannot be read', () => {
    // The fallback used to read these fields a second time, through the very getter that had just
    // thrown, so the failure escaped into the caller of a logging call.
    const hostile = {
      ...base,
      get msg(): never {
        throw new Error('unreadable field')
      }
    }
    let line = ''
    expect(() => (line = serialize(hostile))).not.toThrow()
    const parsed = JSON.parse(line)
    expect(parsed.data.serializeFailed).toBe(true)
    expect(parsed.msg).toBe('')
  })

  it('clamps a cause chain rather than being defeated by it', () => {
    // A self-referential chain is bounded on the way in, so the record survives with a chain of the
    // depth `normalizeError` would itself have produced instead of degrading to an identity line.
    const err: NormalizedError = { name: 'Error', message: 'looping' }
    err.cause = err
    const parsed = JSON.parse(serialize({ ...base, level: 'error', err }))
    expect(parsed.err.message).toBe('looping')
    expect(parsed.data?.serializeFailed).toBeUndefined()
    expect(messages(parsed.err)).toHaveLength(6)
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
    const hostile = {
      ts: huge,
      level: huge,
      proc: huge,
      pid: 4821,
      scope: huge,
      msg: huge,
      get data(): never {
        throw new Error('unreadable record')
      }
    }
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
