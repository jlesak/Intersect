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

  it('reaches a parameter nested two values deep, and stops there', () => {
    const inner = encodeURIComponent('y?token=S3CR3T')
    expect(redactUrl(`https://h/a?u=${encodeURIComponent(`x?v=${inner}`)}`)).not.toContain('S3CR3T')
    // Beyond the bound the value is left as it stands, deliberately: following the nesting as far as
    // it goes would let a crafted value recurse as deep as it is long.
    const deeper = encodeURIComponent(`x?v=${encodeURIComponent(`y?w=${inner}`)}`)
    expect(redactUrl(`https://h/a?u=${deeper}`)).toContain('S3CR3T')
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
    'a fragment on one of two glued URLs': `https://h/a#token=${SECRET};https://h/b?pat=${SECRET}`,
    'a question mark inside a fragment parameter': `https://h/a#access_token=${SECRET}&redirect=/a?b=1`,
    'a question mark before the first equals': `https://h/a#token=${SECRET}?x=1`,
    'an out-of-range port': `https://h:99999/a?token=${SECRET}`,
    'an unclosed IPv6 host': `https://[::1/a?token=${SECRET}`,
    'a doubled scheme colon': `https:://h/a?token=${SECRET}`,
    'a doubled scheme colon with userinfo': `https:://user:${SECRET}@h/a`,
    'a doubled colon on a nested scheme': `https://h/redirect?url=https:://other/a?token=${SECRET}`,
    'a question mark inside an earlier parameter value': `https://h/r?next=/x?token=${SECRET}`,
    'an encoded redirect target': `https://h/oauth/authorize?client_id=1&redirect_uri=https%3A%2F%2Fapp%2Fcb%3Faccess_token%3D${SECRET}`,
    'an encoded redirect target in the fragment': `https://h/a#redirect_uri=https%3A%2F%2Fapp%3Ftoken%3D${SECRET}`,
    'an encoded redirect target that cannot be parsed': `https://h:99999/r?redirect_uri=https%3A%2F%2Fapp%3Ftoken%3D${SECRET}`,
    'a URL under an innocent parameter name': `https://h/redirect?url=https://other/a?token=${SECRET}`
  }

  for (const [name, shape] of Object.entries(shapes)) {
    it(`redacts it: ${name}`, () => {
      // Every route a string can take to disk: a payload value, a key, the message, and an error's
      // message and stack, since a client quotes the failing request in all of them.
      expect(JSON.stringify(redactValue({ text: shape }))).not.toContain(SECRET)
      expect(JSON.stringify(redactValue({ [shape]: 1 }))).not.toContain(SECRET)
      expect(serialize({ ...base, msg: shape })).not.toContain(SECRET)
      expect(serialize({ ...base, err: normalizeError(new Error(shape)) })).not.toContain(SECRET)
    })
  }
})

/**
 * What redaction does not reach, asserted rather than merely written down.
 *
 * These are limits of naming credentials instead of detecting them, not defects with a fix pending.
 * They are pinned here so the scope the comments claim and the scope the code has cannot drift apart,
 * and so that anyone who later makes one of them pass has to come here and say so deliberately.
 */
describe('the limits of a deny-list, held on purpose', () => {
  it('cannot see a credential whose name is outside the vocabulary', () => {
    // `sig` names nothing. Redacting it would mean redacting every value of every parameter, which
    // costs the diagnostic value the log exists for.
    expect(redactUrl('https://h/a?sig=SECRETVALUE')).toContain('SECRETVALUE')
    expect(redactValue({ sig: 'SECRETVALUE' })).toEqual({ sig: 'SECRETVALUE' })
  })

  it('cannot see a credential inside a value that is not a name and a value', () => {
    const blob = Buffer.from('{"token":"SECRETVALUE"}').toString('base64')
    expect(redactUrl(`https://h/a?state=${blob}`)).toContain(blob)
  })

  it('scans free text for URLs only, so a header quoted in prose is not redacted', () => {
    // No `://`, so the text is returned without being looked at. Header-shaped text would be a
    // different scanner, not a variation on this one.
    for (const line of ['Authorization: Bearer SECRETVALUE', 'set-cookie: session=SECRETVALUE']) {
      expect(redactValue({ note: line })).toEqual({ note: line })
    }
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
