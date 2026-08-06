# PR Auto-Sync and Activity Ordering - Design

Closes #47 (PR inbox: background auto-sync and visible data staleness) and #52 (sort and badge PRs
by last activity instead of creation date). One design because both change the same surface and #52's
ordering field is produced by the same sync #47 schedules.

## Problem

PR data reaches the network only when the user presses Sync, or as a side effect of opening My Work
(`myWork/store.ts:130-133`). Boot hydrates the SQLite cache and nothing more (`main.tsx`,
`prInbox/store.ts`). So the board can show hours-old data with nothing on screen admitting it, and
the user either acts on stale information or re-syncs defensively. The Dashboard's system-status zone
now renders PR sync freshness, which makes the gap visible without closing it.

Separately, the board orders and ages every card by `pr.createdAt` (`store.ts:145`,
`PrCard.tsx:6-16,55`). A pull request pushed to an hour ago still reads "12d ago" and sinks to the
bottom of its column, which is backwards for a review queue. The model already carries
`newChangesSinceMyReview` and `activeThreadCount` (`domain.ts:357,362`) and renders neither.

`PullRequest` has no activity timestamp of any kind. Azure DevOps does not return one on the pull
request payload, so ordering by activity requires deriving and persisting a new field.

## Decisions

These were settled before design and are recorded so implementation does not reopen them.

**What counts as activity: every thread, system threads included.** ADO records pushes, vote changes
and policy evaluations as system threads carrying real timestamps. Counting them means a push moves
its PR with ADO's own time rather than an approximation, and costs no extra network call and no state
carried between syncs. The accepted trade-off is that a vote change also moves a PR - for a review
queue that is genuine activity, but it is a looser signal than "somebody wrote something".

The two rejected alternatives: human comments only (a force-push would not move the PR at all, which
is the exact complaint in #52), and comments plus push detection by comparing `sourceCommitId`
against the cached row (more precise about what counts, but the recorded time is the sync time rather
than the push time, it needs a persisted watermark, and the first sync has no baseline).

**Triggers: focus regain only, guarded by staleness.** No periodic timer. On window focus regain,
sync quietly when the last sync is older than `STALE_AFTER_MS` and ADO is configured. The boot sync
approved in #47 fires under the same two guards. The existing Sync button remains the loud,
unguarded path, so "I want it now" is always one click away.

A single guard replaces the interval because one sync is not one request: it is one ADO call per
repository plus one thread fetch per open pull request. Unguarded focus syncing would fire that whole
fan-out every time the user alt-tabs from their editor.

**No auto-sync without a connection.** A machine with no ADO organisation URL or token cannot
succeed, so it must not try - otherwise the failure banner below becomes permanent furniture on a
board that was never going to have data.

## Architecture

Three layers, each with one job.

**Core - derive and persist.** `adoService.sync` already fetches every thread of every PR to count
the unresolved ones. The same enrich step computes `lastActivityAt`. `prCacheRepo` persists it.

**Renderer store - hold and expose.** `syncedAt` already exists. `syncError` is added so a quiet
failure is still observable. Nothing about scheduling lives here.

**App wiring - decide when.** A new `app/prSyncWiring.ts` owns the focus listener and both guards,
following `app/attentionWiring.ts`, which already listens on `window` focus, and joining the `wire*()`
calls in `main.tsx`. Keeping the schedule out of the store is what makes it testable by dispatching a
real focus event, and keeps the store a plain data holder.

### Data flow

```
window focus ─→ prSyncWiring: configured? and stale?
                      │ yes
                      ▼
              prInbox.sync({quiet:true})
                      │
                      ▼
  core adoService.sync ─→ per repo: list PRs
                       └→ per PR: fetch threads ─→ activeThreadCount
                                                └→ lastActivityAt
                      │
                      ▼
        prCacheRepo.replaceAll (stamps synced_at)
                      │
                      ▼
   store: prs, syncedAt, syncError=null ─→ board sorts and renders
```

## Components

### `lastActivityAt` on the domain and in the cache

Added to `PullRequest` as `lastActivityAt: number`. Doc comment states the business meaning: when
anything last happened on this pull request, so a review queue can order by attention rather than
age.

Derivation, in the core's enrich step beside the thread count:

```
lastActivityAt = max(pr.createdAt, every thread's every comment publishedAt)
```

`createdAt` is the floor, so a pull request with no threads at all is dated by its own creation
rather than by zero. A comment whose `publishedDate` was absent parses to `0` today and simply loses
to the floor, which is correct. When a PR's thread fetch fails, `lastActivityAt` carries the prior
cached value forward exactly as `activeThreadCount` already does, so one transient failure cannot
reset a card's position.

Storage: `pr_cache.last_activity_at INTEGER NOT NULL DEFAULT 0`, one forward migration in the shape
of the `active_thread_count` migration (`migrations.ts:244`). The migration then runs
`UPDATE pr_cache SET last_activity_at = created_at`, because rows already in the cache would
otherwise read as 1970 until the next successful sync - a wrong number on screen where a missing one
was expected. `toPr` maps the column and `replaceAll` writes it.

### `hasAdoConnection` in common

`adoSetup()` (`features/dashboard/zones.ts:35`) answers two questions at once: whether settings have
loaded, and whether they constitute a connection. Only the second is needed here, and it does not
belong to the dashboard feature.

A new `src/common/ado.ts` exports `hasAdoConnection(ado: AdoSettings, fallback: AdoFallback): boolean`
- pure, beside the existing `prBoard.ts` and `week.ts`. It carries the rule unchanged: an
organisation URL and a token, each satisfiable by what the user saved or by the
`~/.claude.json`/environment fallback, with a blank saved field deferring to the fallback rather than
overriding it.

`adoSetup()` keeps its `'configured' | 'missing' | 'unknown'` signature and delegates, so the
dashboard's callers and tests do not change, and the two surfaces cannot drift on what "configured"
means.

### `app/prSyncWiring.ts`

Exports `wirePrSync(): () => void`, called from `main.tsx` beside the other `wire*()` calls.

```
STALE_AFTER_MS = 5 * 60 * 1000
```

On boot and on every `window` `focus` event, it syncs when all three hold:

- `hasAdoConnection` is true for the current settings and fallback
- `syncedAt` is null, or older than `STALE_AFTER_MS`
- no sync is already in flight (`syncing` is false)

The sync is always `{ quiet: true }`: an automatic sync that fails must not toast, because a machine
that is merely offline would otherwise interrupt the user for something they did not ask for.

Settings must have loaded before `hasAdoConnection` can be trusted. `app/settingsWiring.ts:16` starts
that load at boot, asynchronously, so a sync fired synchronously at wire time would read empty
settings and conclude the connection is missing. The boot attempt therefore waits for the settings
store to reach `ready` - already ready, act now; otherwise subscribe until it is. A settings load that
fails outright means no automatic sync, and the next focus event re-evaluates.

### Board header - freshness and failure

`PrBoard` takes a `useNow(60_000)` tick so freshness ages on screen instead of freezing at first
render.

- **Sync chip**, beside the existing Sync button: "Synced 4m ago" from `syncedAt`, "never synced"
  when null, warning-tinted once older than `STALE_WARN_MS` (15 minutes).

  The two thresholds are deliberately different and the warning tint is not dead code. While the app
  is in use, focus regain keeps the age under five minutes and the chip stays quiet. The tint appears
  precisely when it should: the window has sat unfocused for a quarter of an hour, or automatic
  syncing is not happening at all because ADO is unconfigured or every attempt is failing.
- **Stale line**, when `syncError` is not null: the Jira board's existing inline pattern
  (`MyWorkView.tsx:55-69`, `ix-mw-loading ix-mw-stale`), reading "Could not refresh: <reason>". The
  cached board stays fully visible beneath it - a failed refresh must never blank out data the user
  can still act on.

`syncError: string | null` on the store is set on any sync failure and cleared on every success, so
it always describes the latest attempt rather than accumulating history.

### Cards - activity, not birth

`PrCard`:

- The age chip reads `lastActivityAt` instead of `createdAt`, and takes `now` as a prop instead of
  calling `Date.now()` internally, so every card ages with the board's tick.
- `● new changes` chip, accent-toned, when `newChangesSinceMyReview`.
- `N unresolved` chip when `activeThreadCount > 0`.

`groupBoardColumns` (`store.ts:145`) sorts each column by `lastActivityAt` descending. It is a pure
function memoized at the call site, not a selector, so this cannot destabilise a store snapshot or
trip the store factory's guard (#60).

## Error handling

| Failure | Behaviour |
| --- | --- |
| Background sync fails | `syncError` set, cache kept, stale line shown, no toast. |
| Manual sync fails | Existing loud path unchanged: toast via `reportError`, plus the stale line. |
| One repository fails | Unchanged: the sync succeeds on the rest and reports `failedRepos`. |
| One PR's thread fetch fails | `activeThreadCount` and `lastActivityAt` both carry the prior cached values forward. |
| ADO not configured | No automatic sync at all. The Sync button still works and still reports loudly. |
| Sync already in flight | Focus event is ignored; no queueing, no second request. |
| Settings not loaded yet | Treated as not configured; the next focus event re-evaluates. |

## Testing

Unit, core: activity derivation dated by the newest comment across all threads including system ones;
`createdAt` as the floor when a PR has no threads; carry-forward of both enriched fields when a
thread fetch throws. Migration: the column exists and pre-existing rows are backfilled from
`created_at`.

Unit, common: `hasAdoConnection` for saved values, fallback values, blank-defers-to-fallback, and
each half missing. `adoSetup` still returns `unknown` before settings load.

Unit, renderer: `groupBoardColumns` orders by activity, not creation; the sync chip's three states
including the warning threshold; the stale line appears on `syncError` with the cached board still
rendered; `syncError` clears on a successful sync; `PrCard` renders both new badges only when their
fields warrant it.

Unit, wiring: dispatching a `focus` event syncs when stale and configured; does not when fresh, when
unconfigured, when settings have not loaded, or when a sync is in flight. The unsubscribe removes the
listener.

E2E: on a fresh profile with no ADO configured, the board shows its never-synced chip, shows no
failure banner, and no sync is attempted.

Gate: `npm run typecheck && npm test && npm run lint && npm run e2e`.

## Out of scope

The Dashboard's `actionPrs` keeps ordering by `createdAt` (`features/dashboard/zones.ts:89`). Its
"longest-blocked first" intent arguably wants last activity too, but zone 1's ordering is a separate
product question from the board's, and changing it here would be an unrequested change to a surface
that just shipped. Flagged rather than folded in.

Also excluded: a periodic sync timer (deliberately dropped in favour of the focus trigger), any
change to how `newChangesSinceMyReview` or `activeThreadCount` are computed, and splitting the
prInbox barrel (#64).
