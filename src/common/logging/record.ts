/**
 * The shape of one log line and the pure transformations every producer shares: level
 * comparison, error normalisation, secret redaction, and serialisation to a single JSON line.
 *
 * Redaction lives here rather than at the call sites so that no producer can forget it, and
 * serialisation is the only place a record's size is bounded.
 *
 * Nothing here may throw into its caller. A diagnostic call that fails takes down the operation it
 * was meant to explain, so every value a record carries is treated as untrusted: it may be cyclic,
 * unreadable, unserialisable, or arbitrarily large, and it still has to end as one bounded line.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

export type LogProc = 'main' | 'core' | 'renderer'

/**
 * The subsystem a record came from. A closed union rather than a free string so a typo fails the
 * build and grouping the log by subsystem stays reliable; adding a subsystem means adding a member.
 */
export type LogScope =
  | 'rpc'
  | 'http'
  | 'mcp'
  | 'db'
  | 'pty'
  | 'jira'
  | 'ado'
  | 'lifecycle'
  | 'attention'
  | 'agentRuntime'
  | 'oneOnOne'
  | 'settings'
  | 'renderer'
  | 'log'

export interface NormalizedError {
  name: string
  message: string
  stack?: string
  cause?: NormalizedError
}

export interface LogRecord {
  /** ISO 8601 with milliseconds. Producers append independently, so this is what re-orders the file. */
  ts: string
  level: LogLevel
  proc: LogProc
  pid: number
  scope: LogScope
  /** Short and stable for a given event, so the file can be grouped by it. Values belong in `data`. */
  msg: string
  data?: Record<string, unknown>
  err?: NormalizedError
}

export const REDACTED = '[redacted]'

export const MAX_RECORD_BYTES = 8192

/** Lower is more severe; a floor admits every level with an order at or below its own. */
export const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 }

/**
 * Redaction works from a list of names that mean a credential, which fixes what it can and cannot
 * see. It recognises a credential that is *named* - a key, a URL parameter, a parameter nested
 * inside another parameter's value - and it cannot recognise one that is not.
 *
 * So `?sig=SECRET` survives, because `sig` is not in the vocabulary; so does a token inside a base64
 * or JSON blob, or any bare value whose name gives nothing away. That is inherent to naming
 * credentials rather than detecting them, not a gap waiting to be closed: the alternative is
 * redacting every value of every parameter, which would take the diagnostic value of the log with it.
 *
 * Adding a name is how coverage grows, and **a name of three or four letters belongs in
 * `SECRET_WORDS`, never in `SECRET_SUBSTRINGS`.** `sig` is the example to learn from, since an Azure
 * storage signature is the most likely name to be wanted next: as a substring it matches sixteen
 * identifiers in this app and two hundred uses of them, `assignee`, `assign`, `assignToPane`,
 * `assigned`, `assignProject`, `assignments` and `signal` among them. Work item assignees and
 * workspace-to-project assignment are core domain concepts here, so a substring `sig` would silently
 * redact a large part of what the log is for - the same defect unanchored `pat` had against paths.
 * Anchored as a word it matches `sig` and `?sig=` and leaves every one of those alone.
 */

/**
 * The credential names long enough to be unambiguous wherever they appear, so they are recognised
 * anywhere inside a name. That is the direction that fails safe: a name run together without a
 * separator, as `clientsecret` or `authtoken` arrives from a third party, is still caught.
 */
const SECRET_SUBSTRINGS = [
  'token',
  'cookie',
  'password',
  'secret',
  'authorization',
  'bearer',
  'apikey'
]

/**
 * The credential names too short to be recognised that way, matched as whole words instead.
 *
 * `pat` is the whole of this list and cannot leave it: the Azure DevOps credential field is itself
 * named `pat`. But as a substring it also matches every path-shaped identifier this app has -
 * `filePath`, `repoPath`, `worktreePath` and fifteen others - along with `patch` and `pattern`.
 * Paths are the primary domain object of a workspace and terminal manager, so redacting them would
 * leave the log misleading about the values it records most often.
 */
const SECRET_WORDS = new Set(['pat'])

/**
 * The start of a URL: a scheme, then the slashes that open the authority.
 *
 * Three patterns need to recognise this and they are built from this one source rather than written
 * out three times. Spelling it out repeatedly is what let them drift: widening one to accept a
 * mistyped `https:://` left the other two refusing it, and a credential escaped through each of the
 * two for as long as they disagreed.
 *
 * The scheme is length-bounded because `.`, `-` and `+` are not word characters, so a word boundary
 * opens a fresh start position after every one of them. Left unbounded, each start position rescans
 * the whole run, and a long dotted string costs quadratic time - seconds of a stalled process on
 * text that merely looks like a scheme. More than one colon is admitted because a mistyped
 * `https:://` still carries a credential, and refusing to recognise it means never redacting it.
 */
const SCHEME = String.raw`[a-z][a-z0-9+.-]{0,31}:+//`

/**
 * A scheme-qualified URL wherever it appears in free text. Credentials reach the log inside
 * sentences far more often than on their own: an HTTP client quotes the failing request in its
 * error message, so the URL arrives surrounded by prose.
 *
 * The run extends to the next whitespace and stops at nothing else, because ending it early is what
 * lets a credential escape: whatever falls outside the run is emitted verbatim, so excluding a comma
 * would hand over the token that followed a comma-separated batch of work item ids. Whitespace is
 * the only character a URL cannot legally contain, which makes it the only safe terminator. Over-
 * collecting is the safe direction, and what is over-collected is given back in `redactRun`.
 */
const EMBEDDED_URL = new RegExp(String.raw`\b${SCHEME}\S+`, 'gi')

/**
 * The characters that close a sentence, quotation or bracket around a URL rather than belonging to
 * it. Trimming them is safe where excluding them from the run is not: what is trimmed is punctuation
 * and nothing else, and everything in front of it is still offered for redaction.
 *
 * A set walked backwards from the end, rather than an end-anchored pattern: that pattern was not
 * anchored at its start as well, so a long punctuation run that stopped short of the end was
 * rescanned from every position in it.
 */
const CLOSING_PUNCTUATION = new Set([...`"'<>,;.:!?)]}`])

/**
 * Where a second URL begins inside one whitespace-free run, behind a character no scheme may
 * contain. Two URLs written back to back must each be redacted in their own right, rather than the
 * second being swallowed into a parameter value of the first and vanishing with it.
 */
const NESTED_SCHEME = new RegExp(String.raw`[^a-z0-9+.-]${SCHEME}`, 'gi')

const MAX_STACK_CHARS = 2000

const MAX_CAUSE_DEPTH = 5

/**
 * Text allowances tried in turn once a record is oversized because a single field is. JSON escaping
 * can expand one character sixfold, so no fixed byte allowance bounds the line on its own; the last
 * entry leaves nothing but the markers and therefore always fits.
 */
const FIELD_BUDGETS = [500, 100, 20, 0]

const CIRCULAR = '[circular]'

const UNREADABLE = '[unreadable]'

export function isLevelEnabled(level: LogLevel, floor: LogLevel): boolean {
  return LEVEL_ORDER[level] <= LEVEL_ORDER[floor]
}

/**
 * Split an identifier into its lower-cased words, so a short credential name can be recognised as a
 * word instead of as a substring. Separators, camel case, and the join between letters and digits
 * all divide a name; a run of capitals stays one word, except where a capitalised word starts inside
 * it, which is how `AZURE_DEVOPS_PAT` and `patToken` both come apart correctly.
 *
 * Splitting rather than matching is deliberate. Anchoring in a pattern would have to see the case
 * transition in `savedPat` while still accepting `PAT` and `Pat`, and a case-insensitive pattern
 * cannot see the transition it needs to anchor on.
 */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    // One capital of context is all the split needs, and all it may take: a `+` here would run to
    // the end of a long run of capitals and backtrack from every start position, which costs
    // seconds of a stalled process on a key that is nothing but capitals.
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z])([0-9])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '')
}

/**
 * Whether a name says that its value is a credential.
 *
 * One vocabulary serves both the keys of a logged object and the parameter names of a URL, so the
 * two cannot drift apart and a credential cannot be redacted on one surface while surviving on the
 * other.
 */
function isSecretName(name: string): boolean {
  const lower = name.toLowerCase()
  if (SECRET_SUBSTRINGS.some((part) => lower.includes(part))) return true
  return nameWords(name).some((word) => SECRET_WORDS.has(word))
}

/** Describe a value that refuses to be read, rather than letting its failure escape. */
function safeText(value: unknown): string {
  try {
    return String(value)
  } catch {
    return `[unprintable ${typeof value}]`
  }
}

/**
 * Reduce anything throwable to a serialisable shape. Non-errors are described rather than
 * discarded, because a rejected promise carrying a string is exactly the case worth seeing.
 */
export function normalizeError(err: unknown): NormalizedError {
  try {
    return walkError(err, 0)
  } catch {
    return { name: 'UnreadableError', message: UNREADABLE }
  }
}

function walkError(err: unknown, depth: number): NormalizedError {
  if (!(err instanceof Error)) {
    return { name: typeof err, message: err === null ? 'null' : safeText(err) }
  }
  const out: NormalizedError = { name: err.name, message: err.message }
  if (err.stack) out.stack = err.stack
  const cause = (err as Error & { cause?: unknown }).cause
  // A cause that points back into the chain would recurse forever; depth is the cheap guard.
  if (cause !== undefined && cause !== err && depth < MAX_CAUSE_DEPTH) {
    out.cause = walkError(cause, depth + 1)
  }
  return out
}

/**
 * Deep copy with every secret removed: a key whose name suggests a credential is replaced outright,
 * and any URL among the values has its credential-bearing parameters stripped.
 *
 * Cycles, unreadable properties and exotic objects all resolve to a marker rather than throwing, so
 * a logging call can never fail because of the shape of what it was given.
 */
export function redactValue(value: unknown): unknown {
  return redactAny(value, new WeakSet<object>())
}

function redactAny(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactText(value)
  if (typeof value === 'function') return '[function]'
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return CIRCULAR
  seen.add(value)
  try {
    return redactObject(value, seen)
  } finally {
    // Released on the way back out, so the same object referenced twice in one tree is reported
    // in full both times instead of being mistaken for a cycle.
    seen.delete(value)
  }
}

/**
 * Copy an object, keeping the meaning of the built-in types a caller is most likely to log.
 *
 * Enumerating own properties is what a plain object needs and what a Date, Error, Map or Set cannot
 * survive: they carry their content internally and would each flatten to `{}`, silently destroying
 * the value the record exists to report.
 */
function redactObject(value: object, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) return value.map((item) => redactAny(item, seen))
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
  }
  if (value instanceof Error) return redactError(normalizeError(value))
  if (value instanceof Set) return [...value].map((item) => redactAny(item, seen))
  if (value instanceof Map) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of value) {
      const name = safeText(key)
      out[redactText(name)] = isSecretName(name) ? REDACTED : redactAny(item, seen)
    }
    return out
  }
  const out: Record<string, unknown> = {}
  for (const key of ownKeys(value)) {
    // The name is redacted as well as judged. A cache keyed by request URL carries its credentials
    // in the key, where deciding whether the value is a secret does nothing to protect them.
    out[redactText(key)] = isSecretName(key) ? REDACTED : readAndRedact(value, key, seen)
  }
  return out
}

function ownKeys(value: object): string[] {
  try {
    return Object.keys(value)
  } catch {
    return []
  }
}

/**
 * Read one property and redact it. Reading is where a hostile or lazy object bites: a getter runs
 * arbitrary code, so its failure is contained here and costs one property rather than the record.
 */
function readAndRedact(owner: object, key: string, seen: WeakSet<object>): unknown {
  try {
    return redactAny((owner as Record<string, unknown>)[key], seen)
  } catch {
    return UNREADABLE
  }
}

/**
 * Strip credentials from every URL a piece of text contains. Safe on arbitrary text: anything that
 * is not a URL is returned untouched.
 *
 * URLs are the whole of what this reaches, and text with no `://` in it is returned without being
 * looked at. A credential quoted in prose any other way therefore survives - `Authorization: Bearer
 * SECRET` or `set-cookie: session=SECRET` inside an error message is not redacted and never has
 * been. Header-shaped text is a different scanner than this one, not a variation on it, and pretending
 * otherwise here would make the coverage read as wider than it is.
 */
function redactText(value: string): string {
  if (!value.includes('://')) return value
  return value.replace(EMBEDDED_URL, redactRun)
}

/**
 * Redact every URL inside one whitespace-free run of text.
 *
 * The run is deliberately over-collected, so it is handed back in pieces: the closing punctuation is
 * put back untouched, a second URL glued onto the first is separated out and redacted in its own
 * right, and the single character that separates them is passed through as itself. Every remaining
 * piece begins with a scheme and goes through `redactUrl`.
 *
 * That is the invariant this function exists to hold: nothing leaves here without first having been
 * offered for redaction. Text may be lost when a URL absorbs prose that followed it without a space,
 * and that is the direction to fail in - losing a fragment of a log line costs a little context,
 * whereas letting one token past costs a credential.
 */
function redactRun(run: string): string {
  let cut = run.length
  while (cut > 0 && CLOSING_PUNCTUATION.has(run.charAt(cut - 1))) cut -= 1
  const urls = run.slice(0, cut)
  const trailing = run.slice(cut)
  let out = ''
  let from = 0
  for (const nested of urls.matchAll(NESTED_SCHEME)) {
    const at = nested.index
    if (at <= from) continue
    out += redactUrl(urls.slice(from, at)) + urls.charAt(at)
    from = at + 1
  }
  return `${out}${redactUrl(urls.slice(from))}${trailing}`
}

/** Redact an error and its causes, since a client's message and stack routinely quote the request. */
function redactError(err: NormalizedError): NormalizedError {
  const out: NormalizedError = { name: err.name, message: redactText(err.message) }
  if (err.stack) out.stack = redactText(err.stack)
  if (err.cause) out.cause = redactError(err.cause)
  return out
}

/**
 * Redact a fragment that carries parameters, and leave an opaque one alone.
 *
 * A fragment is where an OAuth implicit flow delivers its access token, and it survives every copy
 * of a URL out of a browser, so it carries credentials as readily as the query does. It is also
 * where a single-page application keeps its route, which is not a parameter list and must not be
 * rewritten: the fragment is only re-serialised when a secret was actually found in it, and a
 * fragment holding no `=` at all is left exactly as it arrived.
 */
function redactFragment(hash: string): string {
  const body = hash.slice(1)
  const equals = body.indexOf('=')
  if (equals === -1) return hash
  // A hash route may carry its own query string, as in `#/board?token=x`, and the path in front of
  // the `?` stays verbatim. Only a `?` ahead of the first `=` marks such a route: further along it
  // belongs to a parameter's value, as an implicit flow's `redirect` or `state` carries one, and
  // treating that as the separator would leave every parameter before it unexamined.
  const query = body.indexOf('?')
  const route = query !== -1 && query < equals
  const prefix = route ? body.slice(0, query + 1) : ''
  const params = new URLSearchParams(route ? body.slice(query + 1) : body)
  let redacted = false
  for (const key of [...params.keys()]) {
    if (isSecretName(key)) {
      params.set(key, REDACTED)
      redacted = true
      continue
    }
    const value = params.get(key) ?? ''
    const inner = redactInsideValue(value, 1)
    if (inner !== value) {
      params.set(key, inner)
      redacted = true
    }
  }
  return redacted ? `#${prefix}${params.toString()}` : hash
}

/**
 * A `name=value` pair, taken where a delimiter or the start of the string introduces the name.
 *
 * The delimiter is what keeps the scan linear. Without it every position in a long run of name
 * characters is a fresh start that scans to the end looking for an `=` and backtracks, which costs
 * seconds on a run of a few hundred thousand characters.
 */
const PARAMETER_PAIR = /(^|[?&#])([A-Za-z0-9_.-]+)=([^&#]*)/g

/** Credentials in the authority of a string that could not be parsed. Anchored, so it scans once. */
const UNPARSED_USERINFO = new RegExp(String.raw`^(${SCHEME})[^/?#@]*@`, 'i')

/**
 * How far to look for parameters nested inside a parameter's value.
 *
 * A redirect target carried as a parameter holds its own parameters, and one of those may be the
 * credential - one level deep covers every shape seen in practice, and two covers a redirect chain
 * that carries another. The bound is the point: following the nesting as far as it goes would let a
 * crafted value recurse as deep as it is long, and a diagnostic call must not be the thing that
 * exhausts the stack.
 */
const MAX_PARAMETER_DEPTH = 2

/**
 * Decode one layer of percent-encoding, leaving the value alone if it does not decode cleanly.
 *
 * A correct client percent-encodes a URL it passes as a parameter, which hides both the `://` and
 * the `token=` from every pattern here while hiding nothing from a reader of the log. So the value is
 * decoded before it is searched. A stray `%` makes decoding throw, and a value that cannot be decoded
 * is simply not the shape being looked for.
 */
function decodeOnce(value: string): string {
  if (!value.includes('%')) return value
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Redact the credentials named inside one parameter's value.
 *
 * A parameter's value can carry parameters of its own - a `redirect_uri` or a `next` holding a whole
 * URL - and the credential is then named one level further in than anything the query itself
 * exposes. Neither the query parser nor the nested-scheme split reaches it: the parser sees a single
 * parameter whose value happens to contain a `?`, and the split needs a literal `://` that
 * percent-encoding has hidden.
 *
 * The value is returned exactly as it arrived unless something was actually redacted, so an innocent
 * value keeps its own encoding rather than being rewritten by having been examined.
 */
function redactInsideValue(value: string, depth: number): string {
  if (depth > MAX_PARAMETER_DEPTH) return value
  const decoded = decodeOnce(value)
  let redacted = false
  const scanned = decoded.replace(
    PARAMETER_PAIR,
    (pair, lead: string, name: string, inner: string) => {
      if (isSecretName(name)) {
        redacted = true
        return `${lead}${name}=${REDACTED}`
      }
      const deeper = redactInsideValue(inner, depth + 1)
      if (deeper === inner) return pair
      redacted = true
      return `${lead}${name}=${deeper}`
    }
  )
  return redacted ? scanned : value
}

/**
 * Redact a string that announces itself as a URL but does not parse as one.
 *
 * Everything is left as it stands except the values of parameters whose names say they are
 * credentials, and the authority when it carries userinfo. A malformed URL is not a safer URL, and
 * the shapes that fail to parse - an out-of-range port, an unclosed IPv6 host, a stray percent -
 * arrive from configuration mistakes rather than from anything exotic.
 */
function redactUnparsedUrl(raw: string): string {
  return raw
    .replace(UNPARSED_USERINFO, `$1${REDACTED}:${REDACTED}@`)
    .replace(PARAMETER_PAIR, (pair, lead: string, name: string, value: string) => {
      if (isSecretName(name)) return `${lead}${name}=${REDACTED}`
      const inner = redactInsideValue(value, 1)
      return inner === value ? pair : `${lead}${name}=${inner}`
    })
}

/**
 * Keep a URL useful for diagnosis while removing the credentials it carries, wherever they sit.
 *
 * The surfaces of a URL are enumerable - scheme, authority, path, query and fragment. A scheme
 * carries nothing secret, and the authority, query and fragment are each handled here. The path is
 * the gap, in two forms that both lie beyond the reach of matching on a name: a bare segment has no
 * name to be recognised by, and the one named form a path allows, a `;key=value` matrix parameter,
 * is used in practice only for servlet session ids, whose names this vocabulary does not describe.
 *
 * A parameter's value is searched too, to a bounded depth, because a redirect target carried as a
 * parameter brings its own parameters and the credential is often one of those. What no amount of
 * searching reaches is a credential with no name to give it away: `?sig=SECRET` and a token inside a
 * base64 blob both survive, for the reason set out where the vocabulary is defined.
 *
 * A string that fails to parse is still scanned, not trusted. A malformed URL carries exactly the
 * same credentials as a well-formed one - an out-of-range port arriving from bad configuration is
 * enough to make the parse fail - so handing it back untouched would leak on the strength of a typo.
 */
export function redactUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return redactUnparsedUrl(raw)
  }
  // Basic auth against Azure DevOps puts the token in the password, so a credential arrives in the
  // authority as readily as in the query. The user name goes too: it is half of the same secret.
  if (url.username) url.username = REDACTED
  if (url.password) url.password = REDACTED
  for (const key of [...url.searchParams.keys()]) {
    if (isSecretName(key)) {
      url.searchParams.set(key, REDACTED)
      continue
    }
    // The value is only written back when it changed, so examining an innocent parameter does not
    // re-serialise the query and rewrite everyone else's encoding.
    const value = url.searchParams.get(key) ?? ''
    const inner = redactInsideValue(value, 1)
    if (inner !== value) url.searchParams.set(key, inner)
  }
  if (url.hash) url.hash = redactFragment(url.hash)
  // The marker is left legible rather than percent-escaped, so a reader can see what was removed.
  // Only the marker: decoding the whole string would rewrite every other escape and would throw
  // outright on a malformed one, turning a diagnostic call into the failure being diagnosed. The
  // result reads as a URL but need not parse as one again - a redacted authority does not.
  return url.toString().replaceAll(encodeURIComponent(REDACTED), REDACTED)
}

/**
 * Describe call arguments by shape and size only. RPC arguments carry terminal keystrokes and
 * credentials, so their values must never reach the log.
 */
export function summarizeArgs(args: unknown[]): string[] {
  return args.map((arg) => {
    if (arg === null) return 'null'
    if (Array.isArray(arg)) return `array(${arg.length})`
    if (typeof arg === 'string') return `string(${arg.length})`
    return typeof arg
  })
}

interface WireRecord extends Omit<LogRecord, 'data' | 'err'> {
  data?: unknown
  err?: NormalizedError
}

/**
 * The fields that identify an event, kept as free strings because a degraded line is built from
 * whatever the record actually held rather than from what its type promised.
 */
interface DegradedRecord {
  ts: string
  level: string
  proc: string
  pid: number
  scope: string
  msg: string
  /**
   * `serializeFailed` marks the difference between a record deliberately shed for size and one that
   * defeated serialisation outright. Without it a defect in this module would look like nothing more
   * than unusually sparse records.
   */
  data: { truncated: true; serializeFailed?: true }
  err?: { name: string; message: string }
}

function toWire(record: LogRecord): WireRecord {
  const wire: WireRecord = {
    ts: record.ts,
    level: record.level,
    proc: record.proc,
    pid: record.pid,
    scope: record.scope,
    msg: redactText(record.msg)
  }
  if (record.data !== undefined) wire.data = redactValue(record.data)
  if (record.err !== undefined) wire.err = redactError(record.err)
  return wire
}

const UTF8 = new TextEncoder()

/**
 * The UTF-8 length of a line, measured with a platform global rather than Node's `Buffer`, because
 * the sandboxed renderer serialises its own records and has no Node globals to reach for.
 */
function bytes(line: string): number {
  return UTF8.encode(line).length
}

/**
 * Render as JSON, describing a `bigint` rather than failing on it. `JSON.stringify` throws on one,
 * and an identifier that happens to be a `bigint` must not cost the whole record.
 */
function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? `${item}n` : item))
}

function clampChars(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...[clamped]`
}

/** Read a field that the types call a string but an untrusted producer may have sent as anything. */
function field(value: unknown, budget: number): string {
  return clampChars(typeof value === 'string' ? redactText(value) : '', budget)
}

function clampStacks(err: NormalizedError): NormalizedError {
  const out: NormalizedError = { name: err.name, message: err.message }
  if (err.stack) out.stack = clampChars(err.stack, MAX_STACK_CHARS)
  if (err.cause) out.cause = clampStacks(err.cause)
  return out
}

/**
 * Keep the reported failure's own frames but drop those of its causes. Messages are the cheaper
 * half of an error by far, so the whole chain still says what happened even once the frames go.
 */
function withoutCauseStacks(err: NormalizedError): NormalizedError {
  const out: NormalizedError = { name: err.name, message: err.message }
  if (err.stack) out.stack = err.stack
  if (err.cause) out.cause = dropStacks(err.cause)
  return out
}

function dropStacks(err: NormalizedError): NormalizedError {
  const out: NormalizedError = { name: err.name, message: err.message }
  if (err.cause) out.cause = dropStacks(err.cause)
  return out
}

function withCauseLimit(err: NormalizedError, limit: number): NormalizedError {
  const out: NormalizedError = { name: err.name, message: err.message }
  if (err.stack) out.stack = err.stack
  if (err.cause && limit > 0) out.cause = withCauseLimit(err.cause, limit - 1)
  return out
}

function causeDepth(err: NormalizedError): number {
  let depth = 0
  for (let node = err.cause; node; node = node.cause) depth += 1
  return depth
}

/**
 * The fallback line: the fields that identify the event, and a marker saying the rest was shed.
 * Built only from primitives read defensively, so it cannot fail the way the full record did.
 */
function degrade(
  record: LogRecord,
  err: NormalizedError | undefined,
  budget: number
): DegradedRecord {
  const out: DegradedRecord = {
    ts: field(record.ts, budget),
    level: field(record.level, budget),
    proc: field(record.proc, budget),
    pid: Number.isFinite(record.pid) ? record.pid : 0,
    scope: field(record.scope, budget),
    msg: field(record.msg, budget),
    data: { truncated: true }
  }
  if (err) out.err = { name: field(err.name, budget), message: field(err.message, budget) }
  return out
}

/**
 * The identifying fields alone, against the widest text allowance that keeps the line inside the
 * cap. `failed` distinguishes a record that defeated serialisation from one merely shed for size.
 */
function degradedLine(
  record: LogRecord,
  err: NormalizedError | undefined,
  failed: boolean
): string {
  let line = ''
  for (const budget of FIELD_BUDGETS) {
    const out = degrade(record, err, budget)
    if (failed) out.data.serializeFailed = true
    line = stringify(out)
    if (bytes(line) <= MAX_RECORD_BYTES) return line
  }
  return line
}

/**
 * Render one record as a single JSON line, redacted and size-bounded.
 *
 * An oversized record is shrunk in stages rather than dropped, shedding what costs least to lose
 * first: over-long stacks, then the structured payload, then the frames of the wrapping errors,
 * then the wrappers themselves, and only last the identifying fields. Wrapping an error must never
 * make it log less than the bare error would have. Staying well inside the atomic-append limit is
 * what keeps three processes writing one file from interleaving a partial line.
 */
export function serialize(record: LogRecord): string {
  try {
    return bound(record)
  } catch {
    // A value the record carried could not be read or rendered. The event still gets a line: this
    // one is assembled from primitives alone, so it cannot fail the same way, and it says so.
    return degradedLine(record, undefined, true)
  }
}

function bound(record: LogRecord): string {
  const wire = toWire(record)
  let line = stringify(wire)
  if (bytes(line) <= MAX_RECORD_BYTES) return line

  if (wire.err) {
    wire.err = clampStacks(wire.err)
    line = stringify(wire)
    if (bytes(line) <= MAX_RECORD_BYTES) return line
  }

  if (wire.data !== undefined) {
    wire.data = { truncated: true, originalBytes: bytes(stringify(wire.data)) }
    line = stringify(wire)
    if (bytes(line) <= MAX_RECORD_BYTES) return line
  }

  if (wire.err?.cause) {
    let err = withoutCauseStacks(wire.err)
    wire.err = err
    line = stringify(wire)
    if (bytes(line) <= MAX_RECORD_BYTES) return line

    // Still oversized on messages alone. Shed the causes furthest from the reported failure first.
    for (let limit = causeDepth(err) - 1; limit >= 0; limit--) {
      err = withCauseLimit(err, limit)
      wire.err = err
      line = stringify(wire)
      if (bytes(line) <= MAX_RECORD_BYTES) return line
    }
  }

  // Only the identifying fields are left, so one of them is itself oversized.
  return degradedLine(record, wire.err, false)
}
