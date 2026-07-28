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
  `pat`, `token`, `cookie`, `password`, `secret`, `authorization`, `bearer`, `apikey`.
- **Short alternatives match only as a whole word**, where words are split on separators (`_`, `-`,
  `.`) and camelCase transitions. Long unambiguous alternatives may match as substrings.

  Whole-word means whole-word: run-together forms like `adopat`, `azurepat` and `mypat` do **not**
  redact. A suffix rule to catch them was considered and declined, because it widens the definition
  this boundary exists to narrow. Do not close that gap by adding words to the substring set -
  `sig`, for instance, would redact `assign`, `assigned`, `assignee`, `signal` and `design`, which
  is the same defect as unanchored `pat`.

  This is not cosmetic. Intersect is a workspace and terminal manager, so paths are its primary
  domain object, and the credential field is itself literally named `pat`
  (`src/common/domain.ts:837`, plus `AZURE_DEVOPS_PAT`) - so `pat` can neither be dropped nor left
  unanchored. Unanchored, it redacts 17 path-shaped identifiers in the domain and IPC surface
  (`filePath`, `folderPath`, `repoPath`, `targetPath`, `worktreePath`, `vttPath`, `backupPath`,
  `originalPath`, `path`, and more) plus `patch` and `pattern`, which would make the log actively
  misleading about the values the app handles most. Anchored, `pat`, `PAT`, `savedPat`,
  `ado_pat` and `AZURE_DEVOPS_PAT` all redact while `path`, `patch`, `pattern`, `dispatch` and
  `compatible` do not.
- Every URL surface that can carry a credential is redacted: userinfo (`user:PAT@host`), the query
  string, and the fragment. Path matrix parameters (`;jsessionid=`) are a known gap, kept because
  the vocabulary recognises no session-id name, so closing it would require widening the vocabulary
  rather than adding a surface.
- PTY output and terminal snapshots are never logged as content.

### What redaction does not cover

Stated plainly, because the rest of this section reads as though it were exhaustive and it is not.
Each limit below is asserted as a test, so the scope the code has and the scope described here cannot
drift apart silently.

- **Free text is scanned for URLs only.** A string with no `://` is passed through untouched, so a
  credential in prose survives: `Authorization: Bearer SECRET` and `set-cookie: session=SECRET`
  inside an error message are **not** redacted, and never have been. This is the limit an HTTP client
  is most likely to produce.
- **A deny-list cannot recognise a credential it has no name for.** A value under a name outside the
  vocabulary (`?sig=`, an Azure SAS signature) or one buried in an opaque blob (a token inside base64
  or JSON) is not redacted. This is a property of the approach, not a defect awaiting a fix.
- **The URL path is never scanned.** Matrix parameters leak even under a first-class vocabulary name:
  `https://h/a;token=SECRET` survives. The gap is the unscanned surface, not the vocabulary.
- **Redaction is silent.** Nothing distinguishes a log with a missed credential from a log that had
  nothing to redact.

An allow-list that redacts every parameter value and keeps every name would close the first three by
construction. It was proposed, and deliberately not adopted: the deny-list is kept and hardened
shape-by-shape instead, which makes the committed redaction audit the load-bearing safety artefact
rather than a convenience. Treat it as one.

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
