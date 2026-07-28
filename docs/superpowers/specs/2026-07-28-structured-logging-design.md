# Structured logging and diagnostics

Design approved 2026-07-28.

## Goal

Make Intersect diagnosable after the fact. Today an agent asked to "read the logs and fix the
errors" has nothing to read: there is no log file, no logging library, no log level, and no global
error handler in any of the three processes. A crash leaves either silence or a dead process whose
output went to a terminal nobody was watching.

The target is a single durable, greppable, field-oriented log that captures what the UI asked for,
what the core did about it, every outbound request, and every error - including the ones no
`try/catch` anticipated.

## Delivery

Two pull requests. The infrastructure is a self-contained vertical that is worth reviewing on its
own; the error-swallow conversion is mechanical breadth across nearly every slice and would otherwise
bury it.

| PR | Contents | Reviewable question |
| --- | --- | --- |
| **1. Infrastructure** | The logger, the two sinks, global handlers, the instrumented seams (RPC, HTTP, MCP, spawns), redaction, the rate guard, `no-console`, the replacement of the existing 25 `console.*` sites, and the full test suite | Is the logging architecture right? |
| **2. Error-swallow conversion** | The 118 discarded errors, each given a log line at a level matched to intent | Is each swallow classified correctly? |

PR 1 lands first and is independently useful: it produces a populated log file on its own. PR 2
depends on it only for the logger import.

## Current state

| Gap | Evidence |
| --- | --- |
| No logging library, no file sink | `grep -E 'winston\|pino\|electron-log\|logger'` over `src` returns nothing |
| 25 ad-hoc `console.*` call sites | Inconsistent hand-written prefixes: `[intersect]`, `[lifecycle]`, `[coreHost]`, `[portRpc]`, `[jira]`, `[bridge]`, `[terminal]`, `[agentRuntime]`, and several with none |
| No global error handlers | Zero `uncaughtException`, `unhandledRejection`, `window.onerror`, `unhandledrejection` anywhere |
| 118 discarded errors | 90 bare `catch {}` plus 28 `.catch(() => {})`, outside tests |
| Core deaths have no cause | `coreHost.ts:154` reports only `core process exited unexpectedly (code null)` |
| Renderer has no sink at all | Stated in `ErrorBoundary.tsx:56`: "The renderer has no log channel to main, so the devtools console is the only sink" |

## Why not a browser test surface

Testing the renderer in a plain browser was considered and rejected on two counts.

The requests are not in the renderer. Jira's direct client uses a `fetch` injected at
`bootstrap.ts:590`; Azure DevOps talks to its MCP server over a **stdio child process**
(`adoClient.ts`, `@modelcontextprotocol/sdk`), not HTTP at all; only `adoVote.ts` and
`adoTestConnection.ts` make direct REST calls. All of it runs in the Node core process. A browser
Network tab would show Vite dev-server assets and nothing else.

The renderer also cannot boot there. Its only door is `window.intersect`, injected by preload;
`shared/ipc/client.ts:9` throws without it, and behind it sit real PTYs, `node:sqlite`, and live
HTTP clients. Browser mode would mean maintaining a fake backend and then testing the fake.

Instead: `--remote-debugging-port` on the real app gives CDP access to the real renderer for
console, DOM and screenshots, while the file captures main, core, RPC, HTTP, MCP and spawns.

## Architecture

One record type, three producers, two sink implementations, one file.

```
 renderer                    main                        core (utilityProcess)
 --------                    ----                        ---------------------
 window.onerror          uncaughtException           uncaughtException
 unhandledrejection      unhandledRejection          unhandledRejection
 console.error/warn      coreHost lifecycle          PortRpc requests/failures
 ErrorBoundary           window + dialog events      HTTP via injected fetch
 reportError                                         MCP callTool
     |                        |                      DB, PTY spawn, sync engines
     v                        |                           |
 createLogger             createLogger                createLogger
 (ipcSink)                (fileSink)                  (fileSink)
     |                        |                           |
     |  Channel.logWrite      |                           |
     |  ipcRenderer.send      |                           |
     +----------------------> +                           |
                              v                           v
                    ~/Library/Application Support/Intersect/logs/
                              intersect-YYYY-MM-DD.jsonl
                              (O_APPEND, one JSON object per line)
```

### Why each process appends directly instead of routing through main

The core is the process most likely to die, and a crash is exactly the case that must be
diagnosable. Records shipped over the port would still be in flight when it exits. Opening the file
`O_APPEND` in the core means its last words reach disk before the process disappears, with no
transport in the path.

The renderer is the one exception: `sandbox: true` leaves it no filesystem access, so it ships
records to main and main appends them. That hop is acceptable because a renderer crash does not take
main with it.

POSIX makes an `O_APPEND` write atomic with respect to other writers, so three producers on one file
do not corrupt each other. Records are truncated at 8 KB to stay well inside that guarantee.

### Why the file is per-day and pruned by main alone

A daily filename means no writer ever has to rename or roll a file another writer holds open, which
removes the rotation race entirely. Retention is 7 days, pruned once by main at startup - main starts
before core and outlives it, so it is the only process that can own this without coordination.

## The record

```json
{"ts":"2026-07-28T09:14:02.417Z","level":"error","proc":"core","pid":4821,
 "scope":"jira","msg":"search request failed",
 "data":{"status":503,"url":"https://jira.example.com/rest/api/2/search","durationMs":1841,"attempt":2},
 "err":{"name":"Error","message":"upstream unavailable","stack":"Error: upstream...\n    at ..."}}
```

| Field | Meaning |
| --- | --- |
| `ts` | ISO 8601 with milliseconds. Producers append independently, so lines interleave; `ts` is what makes the file sortable back into true order |
| `level` | `error` \| `warn` \| `info` \| `debug` |
| `proc` | `main` \| `core` \| `renderer` |
| `pid` | Distinguishes core instances across restarts |
| `scope` | One declared value per subsystem, replacing today's ad-hoc `[tag]` prefixes |
| `msg` | Short stable sentence. Never string-interpolated with values - those belong in `data` |
| `data` | Structured parameters. Optional |
| `err` | Normalized `{name, message, stack, cause}`. Optional |

`msg` stays constant for a given event so the file can be grouped by it; everything variable goes in
`data`. This is the difference the "structured, with parameters" requirement turns on.

`scope` is not a free string. The permitted values are declared as one union type in
`record.ts` - `'rpc' | 'http' | 'mcp' | 'db' | 'pty' | 'jira' | 'ado' | 'lifecycle' | 'attention' |
'agentRuntime' | 'oneOnOne' | 'settings' | 'renderer' | 'log'` - so a typo fails the build and
`grep`ping by subsystem is reliable. Adding a subsystem means adding a member.

## Components

### New

| File | Responsibility |
| --- | --- |
| `src/common/logging/record.ts` | `LogRecord` and `LogLevel` types, level ordering, `normalizeError`, `redact`, 8 KB truncation, `serialize` to a JSONL line. Pure, no I/O |
| `src/common/logging/logger.ts` | `createLogger({sink, level, proc, pid, now})` returning `{error, warn, info, debug, child(scope)}`. Holds the rate guard. All I/O injected |
| `src/common/logging/fileSink.node.ts` | `O_APPEND` sink, daily filename resolution, retention prune. The only module permitted to call `console`, as a last-resort fallback |
| `src/common/logging/httpLogging.ts` | `withHttpLogging(fetch, logger)` - a `typeof fetch` decorator logging method, URL, status, duration, and failures |
| `src/main/logging/index.ts` | Main's logger instance, global handlers, and the `Channel.logWrite` receiver that appends renderer records |
| `src/core/logging/index.ts` | Core's logger instance and global handlers |
| `src/renderer/src/shared/logging/logger.ts` | Renderer logger over the IPC sink; installs `window.onerror` and `unhandledrejection`; mirrors library `console.error/warn` |

### Modified in place

| File | Change |
| --- | --- |
| `src/common/portRpc.ts` | Optional injected logger. One change instruments both ends: request/response at `debug` with channel and duration, rejections at `error` with the stack. PTY data and resize channels excluded |
| `src/core/prInbox/adoClient.ts` | `callTool` decorated: tool name, argument summary, duration, failure. This is the only visibility into ADO traffic |
| `src/core/bootstrap.ts` | Wrap the injected `fetch` at line 590; pass loggers into services; replace existing `console.*` |
| `src/core/index.ts`, `src/main/index.ts` | Install global handlers; replace existing `console.*` |
| `src/preload/index.ts` | Add the `log` namespace over `ipcRenderer.send` |
| `src/common/ipc.ts` | Add the `IpcApi.log` surface. Deliberately **not** a `Channel` member - see below |
| `eslint.config.js` | `no-console` for `src/**`, exempting the two sanctioned fallback modules; restrict `fileSink.node.ts` from renderer and preload |
| 118 catch sites | Each gets a log line - PR 2, see below |

`fileSink.node.ts` lives under `common` but must never enter the renderer bundle. The existing
config already encodes exactly this kind of confinement for `node-pty` and for `electron` in core, so
it gets a `no-restricted-imports` entry in the same style rather than a new mechanism.

### The log channel must stay out of the `Channel` enum

`CORE_INVOKE_CHANNELS` is *derived*: every `Channel` member that is not fire-and-forget, not a
broadcast, and not Electron-only. Its own comment states the intent - "a new slice channel is
core-routed by default". So adding `Channel.logWrite` would silently register
`ipcMain.handle('log:write', ...)` forwarding every renderer log record into the core, which is both
the wrong destination and a round-trip where a fire-and-forget send is wanted.

Instead `RENDERER_LOG_CHANNEL = 'log:write'` is a plain exported constant in
`src/common/logging/channel.ts`, registered with `ipcMain.on` in `src/main/logging/index.ts`. This
follows the existing precedent: `NATIVE_NOTIFICATION_PUSH`, `CORE_SHUTDOWN_CHANNEL` and
`WINDOW_FOCUS_CHANGED` are all plain constants outside the enum for the same reason. The typed
`IpcApi.log` surface is still added to `ipc.ts` so the renderer keeps one door.

## Instrumented seams

| Seam | Level | Fields |
| --- | --- | --- |
| RPC request served | `debug` | `channel`, `durationMs`, arg summary (shapes and lengths, not values) |
| RPC rejection | `error` | `channel`, `durationMs`, `err` with stack |
| RPC notification failure | `error` | `channel`, `err` |
| HTTP request | `debug` on success, `error` on failure or status >= 400 | `method`, `url`, `status`, `durationMs` |
| MCP `callTool` | `debug` / `error` | `tool`, `durationMs`, argument summary |
| Child process spawn and exit | `info` / `warn` | `command`, `pid`, `exitCode`, `signal` |
| Core lifecycle | `info` | `state`, `attempt`, `message` |
| Uncaught throw or rejection | `error` | `err` with stack, then the process dies as before |
| DB migration | `info` | `from`, `to`, `durationMs` |

The PTY data path is deliberately absent. Terminal throughput would flood the file and throttle the
terminal itself. PTY output is never logged as content anywhere - only byte counts.

## Levels and configuration

`INTERSECT_LOG_LEVEL` selects the floor, defaulting to `debug` in development and `info` when
packaged. Read from the environment at logger construction in each process; the core already receives
`process.env` through its init path.

Not a Settings toggle: the logger must exist before the database opens, so bootstrap-time records
could not honour a persisted value, and the most valuable records are the bootstrap ones.

`no-console` in ESLint keeps the logger from being bypassed. Without it, `console.*` drifts back in
and those lines never reach the file.

## Redaction

Applied in `record.ts` at serialization, so no call site can forget it.

- A key naming a credential serializes as `"[redacted]"`, at any depth. The vocabulary is
  `pat` and `sig` as whole words, and `token`, `cookie`, `password`, `secret`, `authorization`,
  `bearer`, `apikey`, `credential` as substrings. A plural counts: a field holding several
  credentials holds credentials, so a trailing `s` is removed before the lookup.
- **Short alternatives match only as a whole word**, where words are split on separators (`_`, `-`,
  `.`) and camelCase transitions. Long unambiguous alternatives may match as substrings.

  Whole-word means whole-word: run-together forms like `adopat`, `azurepat` and `mypat` do **not**
  redact. A suffix rule to catch them was considered and declined, because it widens the definition
  this boundary exists to narrow. Do not close that gap by adding words to the substring set -
  `sig` is in the vocabulary as a **word** for exactly this reason: as a substring it would redact
  `assign`, `assigned`, `assignee`, `assignToPane`, `signal` and `design`, which is the same defect
  as unanchored `pat`. Both short names are held in the word set and neither may move.

  This is not cosmetic. Intersect is a workspace and terminal manager, so paths are its primary
  domain object, and the credential field is itself literally named `pat`
  (`src/common/domain.ts:837`, plus `AZURE_DEVOPS_PAT`) - so `pat` can neither be dropped nor left
  unanchored. Unanchored, it redacts 17 path-shaped identifiers in the domain and IPC surface
  (`filePath`, `folderPath`, `repoPath`, `targetPath`, `worktreePath`, `vttPath`, `backupPath`,
  `originalPath`, `path`, and more) plus `patch` and `pattern`, which would make the log actively
  misleading about the values the app handles most. Anchored, `pat`, `PAT`, `savedPat`,
  `ado_pat` and `AZURE_DEVOPS_PAT` all redact while `path`, `patch`, `pattern`, `dispatch` and
  `compatible` do not.
- Every URL surface that can carry a credential is redacted: userinfo (`user:PAT@host`), the path,
  the query string, and the fragment. Path matrix parameters (`;token=`) were a documented gap for as
  long as nothing looked at the path; scanning it closed them, since `;token=` is a named pair like
  any other. The path and the fragment reach that scanner through one loop over one list of surfaces,
  rather than a call each: written out separately they drifted, and the fragment spent a round holding
  an authority - a whole second URL with a password in it - that nothing looked at.

  What opens an authority is read generously, because a separator that is not literally `://` carries
  exactly the same credential: a mistyped `https:://`, and an escaped `https:\/\/`, which is the form a
  regular expression's source and a slash-escaping serialiser both produce. Nothing at all is required
  in *front* of the scheme, and requiring a word boundary there hid `req_https://user:PAT@h/a` and
  `2https://user:PAT@h/a` for as long as it stood.
- **A string is redacted because the walk reaches every string, not because a field was named.** This
  is the one structural guarantee in this section, and it is what the rest of it leans on:
  - `serialize` assembles the wire object and then redacts *it*, whole. It does not redact a list of
    fields. `err.name` beside a redacted `err.message`, and `ts`, `level`, `proc` and `scope` copied
    out verbatim while the fallback line redacted all five, were the four leaks that list produced.
    A field added to the record later is covered before anybody thinks about it.
  - Inside the walk, a branch that describes its value with a string hands the string back and one
    choke point redacts it. A `URL`, a `RegExp`'s source, a typed array's tag, a `Date` - each is text
    taken from the caller, and each used to be redacted, or not, by its own branch. A branch added
    later is covered the same way.
  - A `URL` instance is handed on as text, so it takes the route the same text written as a string
    takes. It used to go straight to `redactUrl`, which is a narrower scan.
  - A string offered as one URL is divided at every scheme before any of it is parsed, so a URL joined
    into another is reached whatever surface it landed on and whether or not the outer one parses.
- Every rule is reachable from every surface, and each is applied by one implementation rather than
  copied per surface. Query, fragment, path and unparseable text all reach the same scanner, which
  recurses into each decoded parameter value to a bounded depth.

  **For strings inside a record this now follows from the structure above. For `redactUrl` called
  directly it remains a property to keep.** An earlier version of this section claimed there was "no
  way to add a rule to only half the surfaces"; that was wrong four times over, and every one was the
  same defect: the shape detector added to free text and not to `redactUrl`'s parseable branch; the
  marker guard present in the URL-run splitter and absent from its sibling that scans named pairs; the
  fragment given the shape rules while the path was given the scanner; the four identity fields left
  out of a list of fields to redact.

  What is left of the gap is one seam, named here rather than left to be found: the vocabulary's
  **named-pair scan** (`pat=SECRET`, `"pat": "SECRET"` written anywhere in a string) belongs to the
  free-text route and not to `redactUrl`. So `redactUrl('https://h/pat=SECRET/x')` keeps the value,
  while the same text logged as a string or as a `URL` does not. Every route to disk goes through
  `serialize`, which applies the free-text route to every string it writes, so this is a trap for a
  caller who uses `redactUrl` for something other than logging - not a hole in the file.
- **Redaction is applied more than once to the same text, so every rule must be stable under
  reapplication.** An HTTP logger redacts a URL itself and `serialize` redacts the payload that
  result lands in; the second pass is deliberate, because it is what makes the safety of the log
  depend on serialization rather than on the caller. A rule that treats an already-written
  `[redacted]` as a value worth taking therefore corrupts a line it had already made safe, and
  corrupts it further on each pass. The audit asserts stability shape by shape: it measured only
  whether the secret survived, and read as fully green while 51 of its 86 shapes were growing a
  bracket per pass.

  The second pass must also not *count*. An authority reduced to `[redacted]:[redacted]` carries no
  credential, and rewriting it again reported two removals for a line from which nothing was removed -
  which is the count reporting phantoms on every re-logged URL, and the count is the anomaly signal.
  The marker is compared exactly wherever this is guarded, never as a prefix: a value that merely
  begins with a marker is a value, and reading the two as the same thing is how `pat=[redacted]SECRET`
  once got through.
- **A value is also redacted when its shape says credential, regardless of its name.** Two shapes
  qualify, both verifiable by construction rather than by guesswork: a JWT (`eyJ`, which is what
  base64 makes of the `{"` opening every JWT header, followed by base64url and two structural dots),
  and the value following `Bearer` or `Basic` in prose, which is how this app's own ADO connection
  test transmits its PAT.

  Shapes deliberately **not** matched, because no rule separates them from innocent data here: a hex
  digest, since `revision` is a 64-character sha256 hex written in dozens of places and the hook
  token is `randomBytes(32).toString('hex')` - the same shape is both an innocent value and a
  credential; a bare base32 PAT, whose length could not be verified and whose plausible ranges start
  matching git object names; and a bare base64 signature, indistinguishable from the base64
  attention-marker payload this app encodes on purpose as user-facing text. Over-redaction destroys
  data silently, so an unmatched shape is preferred to a rule that cannot tell the two apart.
- **A record carries the number of redactions it required**, present only when non-zero. A log full
  of ADO traffic that redacted nothing is then a visible anomaly rather than being indistinguishable
  from a clean run. Nobody checks this automatically yet; it makes a miss detectable, not detected.
- PTY output and terminal snapshots are never logged as content.

### What redaction does not cover

Stated plainly, because the rest of this section reads as though it were exhaustive and it is not.
Each limit below is asserted as a test, so a limit that stops being true fails loudly instead of
quietly.

That is all those tests give, and the sentence here used to promise more: that "the scope the code has
and the scope described here cannot drift apart silently". They cannot make that promise. A test can
only hold a limit somebody wrote down, and the two worst leaks this module has had were limits nobody
had written down at all - a fragment carrying a whole second URL, and a nested URL sitting at the very
start of a path. The mechanism that does cover the unwritten cases is the structural one above: a
string is redacted because the walk reaches it.

- **Free text is scanned for URLs, for the two value shapes above, and for the vocabulary's names
  written as a pair** (`pat=SECRET`, `"pat": "SECRET"`) - and for nothing else. So
  `Authorization: Bearer SECRET` in an error message is redacted by shape, `pat=SECRET` in a settings
  line by name, and `x-request-signature: SECRET` **not at all**, because that name is outside the
  vocabulary and the value has no distinguishing shape.

  The example this bullet used to give, `set-cookie: session=SECRET`, is now redacted - `set-cookie`
  contains `cookie` - which is worth stating plainly: the limit was recorded as permanent and a test
  asserted the leak, so widening the scan quietly falsified both. A limit written down is not a limit
  that stays true.
- **A deny-list cannot recognise a credential it has no name for.** A value under a name outside the
  vocabulary (`?hmac=`, or a bare `?key=`) is not redacted, and neither is one buried in an opaque
  blob whose own shape says nothing (a token inside base64 or JSON). This is a property of the
  approach, not a defect awaiting a fix: adding a name requires evidence that this app meets it, not
  the observation that the name could exist.

  The specific Azure SAS case named here previously is now covered - `sig` is in the vocabulary as a
  whole word - but the class it stood for is not, and adding that one name did nothing to close it.
- **Over-redaction is real where a shape is matched in prose.** The value after `Basic` is taken
  whatever it is, so `Basic /Users/me/project/out/main.js` loses the path. Excluding `/` from the
  value was considered and declined: standard base64 contains `/` in roughly two of three tokens, so
  excluding it truncates the match below the length floor and the credential itself leaks. Losing a
  path is the better failure, and the audit asserts the loss so that widening the rule fails loudly.
- **Nothing checks the redaction count.** A record now reports how many redactions it required, so a
  miss is *detectable* - but only by a person reading the file. No alert, no test over real logs, and
  no baseline for what a normal session looks like.

An allow-list that redacts every parameter value and keeps every name would close the first two by
construction. It was proposed, and deliberately not adopted: the deny-list is kept and hardened
shape-by-shape instead, which makes the committed redaction audit the load-bearing safety artefact
rather than a convenience. Treat it as one - 105 shapes across 7 routes, each named with the class it
stands for and the failure it was written against.

Its known weakness is that it enumerates **shapes** while the protections are about **classes**, and
a group holding every instance of its class cannot be told from one holding a convenient subset. That
gap has hidden a defect four times, and the worst of them was this: a group covering URLs glued
together held only instances with the credential in a query parameter, so deleting the code that
catches the userinfo form of the same class turned one test red and read as safe. It reopened a
plaintext password leak. When a mechanism looks unused, the audit is not evidence that it is.

Two guards against that, both of which the audit cannot give:

- Two rows read the module's own structure and fail when it changes: the branches of the value walk,
  and the fields of `LogRecord`. Adding either without proving where its text is redacted is what has
  to fail. The list of carriers they hold is still a list, but it can no longer fall behind the code.
- A green suite is not evidence. When a shape is added, the question to ask is what else is in its
  class - the round that added seven glued-URL shapes and no offset-zero instance is the example.

The residual that matters most is the vocabulary, and it is nearly unchanged by eleven rounds of work:
every mechanism for *finding* a named credential was improved, and what a credential is *called* was
extended by two words. `credential` is held on this app's own evidence - `otoManager.ts:75` scrubs
`CREDENTIALS?` out of a spawned environment. **`sig` is not, and it is the exception to the standard
this section sets.** There is no shared access signature anywhere in `src`: `blob.core`,
`sharedaccess`, `[?&]sig=` and `SharedKey` return nothing outside the logging module. It was added
pre-emptively, against a credential this app does not currently handle, and it is recorded as an
exception rather than dressed up as evidence, because otherwise the standard that declined `key` means
nothing for the next word. It is kept because it costs nothing measurable: anchored as a whole word it
damages none of the 36 `sig`-containing identifiers here. `key` was weighed on the same standard and
declined, because a Jira issue key is the central domain identifier here. Shape detection is the only
part of this design that does not depend on knowing the name, which is why it closes limits the
vocabulary never could - and why the two shapes it matches were chosen for being provable rather than
for being useful.

The threat model is a log file pasted into a GitHub issue, not a local attacker: the file is already
as private as the SQLite database beside it.

## The logger must never break the app

- A sink that throws is reported once through the fallback `console.error`, then goes permanently
  no-op for that process. Logging failure never propagates to a caller.
- Records truncate at 8 KB.
- A rate guard caps records per second per process. Excess is dropped and summarized as a single
  record carrying the dropped count, so a log storm stays visible as a storm instead of either
  wedging the app or being silently hidden.
- Every logging call site is synchronous and non-throwing from the caller's perspective.

## The 118 discarded errors (PR 2)

All of them get a log line, distributed as:

| Area | Sites |
| --- | --- |
| `core/myWork` | 11 |
| `core/prInbox` | 10 |
| `core/agentTooling` | 10 |
| `core/usage` | 7 |
| `main` | 6 |
| `core/oneOnOne` | 6 |
| `core/hooks` | 6 |
| `core/sessions` | 5 |
| `core/db` | 5 |
| `core/bootstrap` | 5 |
| `renderer/terminal` | 4 |
| `renderer/timeTracking` | 3 |
| `core/pty` | 3 |
| `core/projects` | 3 |
| Remaining single sites | 6 |
| `.catch(() => {})` across the above | 28 |

Level is assigned by intent, not uniformly:

- **`debug`** for genuinely optional outcomes - `jiraProbe`, `loginShellPath`, optional-file reads,
  capability detection. These are expected failures and must not read as problems.
- **`warn`** for degraded-but-handled paths - a single PR's thread fetch failing mid-sync, a snapshot
  that could not be restored.
- **`error`** for swallows that hide real defects - core bootstrap, `coreHost`, `portRpc`, the
  bridge, DB access.

No control flow changes. A `catch` that currently falls back to a default keeps doing exactly that;
it just says so first. This is the bulk of the diff and touches nearly every slice.

## Testing

**Unit (Vitest, `node` project):** level filtering; redaction at depth and in URL query strings;
error normalization including `cause`; 8 KB truncation; rate guard including the dropped-count
summary; daily filename resolution; retention pruning; `serialize` output being exactly one line of
valid JSON.

**Unit (`dom` project):** the renderer logger's sink call shape; `window.onerror` and
`unhandledrejection` producing records; console mirroring not recursing.

**Integration:** `PortRpc` against a fake sink - a rejected request yields exactly one `error` record
carrying a stack, a PTY-channel notification yields none; `withHttpLogging` on success, on status
400+, and on a thrown network error; a decorated `adoClient.callTool` failure.

**E2E:** one spec that launches the app, exercises a flow that crosses all three processes, then
asserts the log file exists, parses as JSONL line by line, and contains records with `proc` of
`main`, `core` and `renderer`. That last assertion is what proves the renderer-to-main hop works in
the real sandboxed runtime, which no unit test can establish.

## Access for debugging

`npm run dev:debug` adds `--remote-debugging-port=9222`, so a CDP client can attach to the real
renderer for console, DOM and screenshots while the file supplies main, core, RPC, HTTP and MCP.

## Out of scope

- Browser mode with a faked `window.intersect` backend. Rejected above; if wanted later it is its own
  issue.
- Log level in the Settings UI. Rejected above.
- Any change to control flow, error recovery, or user-facing error surfaces. `reportError` keeps its
  toast; it just also reaches the file.
- Remote or aggregated log shipping. This is a single-user local app.
