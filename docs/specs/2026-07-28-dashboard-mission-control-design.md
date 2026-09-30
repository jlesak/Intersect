# Dashboard as Mission Control - design

GitHub issue #43 (ux-review N01, P1). Supersedes nothing; the Dashboard has been a placeholder since
the rail was introduced.

## Goal

The Dashboard answers one question - **what needs me now** - without the user assembling it from
three or four sections by hand. Four named zones in fixed positions, composed from data the stores
already hold, plus the one thing they do not hold yet: a running timer.

## The contradiction in the issue, and how it is resolved

#43 states both "V1 composes existing store selectors - no new data sources" and, for zone 3, "a
running timer with Start/Stop". A running timer is a new data source at every layer. Verified
against the tree at `8c6671a`:

- No `startTimer` / `isRunning` / `elapsed` / `runningEntry` symbol exists anywhere in `src/`.
- The whole time-tracking IPC surface is five request/response channels (`getWeek`, `refreshWeek`,
  `addManual`, `updateEntry`, `deleteEntry`). None start anything.
- There is no DB column for an open entry, and `assertDuration`
  (`src/core/timeTracking/timeTracking.ts:41`) rejects a non-positive duration, so the existing write
  path cannot represent a timer that has just started.

**Resolution: build the timer, as its own PR, first.** It is the shared dependency of #43 and #53,
#43 is the P1 of the two, and zone 3 is inert without it. A renderer-only in-memory timer was
rejected: it dies on reload or crash and silently loses real elapsed time, which is a trust defect in
the one feature whose purpose - established by #42 - is durations defensible to a timesheet.

## Constraints that shape everything below

- **The Dashboard is the app's default landing view.** `resolveShellContext`
  (`src/renderer/src/app/shellStore.ts:54`) falls back to the first section owning a `mainComponent`,
  and Dashboard registers at `order: -10`. It renders on every launch with no explicit selection, so
  its hydration cost is paid every start and a crash in it is a crash on boot.
- **The #60 store-factory guard.** `createStore` runs every selector twice against one state and
  throws when the two results differ. Derivation that builds fresh arrays or objects must live
  outside selectors - as pure functions over a stable slice, memoized with `useMemo` - or be
  `useShallow`-wrapped when the result is flat with stable entries. `docs/agents/domain.md:23-43` is
  the authority.
- **Feature boundaries.** Cross-feature imports go through `@renderer/features/<name>` barrels only
  (`eslint.config.js:3-6`). Cross-slice navigation goes through an `app/*Wiring.ts` module reacting to
  a pending-intent field on the source store, never a direct store-to-store import.
- **No new visual language.** Tokens only, from `src/renderer/src/shared/ui/theme.css`; new classes
  are an `ix-dash*` banner section appended to `shared/ui/app.css`. Never a literal hex - `e2e/theme.spec.ts`
  asserts the token values.
- **Do not add an ErrorBoundary.** `App.tsx:50` already wraps the main region with `key="dashboard"`.

## Zone specification

Fixed order, never reshuffling. Empty zones keep their heading and shrink to a one-line state; they
never disappear or move. Where a source is unconfigured the line says so and points at Settings,
rather than reading as breakage.

Layout: `Needs action` takes a `1.45fr` left column; zones 2-4 stack in a `1fr` right column.
Collapses to a single column below 860px. Needs action is the only zone that grows without bound, so
it gets the room.

### Zone 1 - Needs action

Two labelled subgroups in fixed order, each sorted within itself. A PR's age and a TODO's due day are
not comparable quantities, so a single merged sort would have to invent an exchange rate between them
and would reshuffle unpredictably as either source changed - the chaos the fixed-zone design exists
to prevent.

- **Pull requests**: every PR where `boardColumn(pr) === 'action'`
  (`src/common/prBoard.ts:24`), sorted oldest `createdAt` first. Each row shows the title, the
  repository, `boardReason(pr)` (`prBoard.ts:38`) as the why, and the age. Click opens that PR's
  detail: `setActiveSection(PR_INBOX_SECTION_ID)` then `openDetail(repositoryId, prId)`, composed as
  in `app/myWorkPrNavWiring.ts:16-17`.
- **Deadlines**: open TODOs that are overdue or due today, overdue first, each group by `dueDay`
  ascending. `isOverdue(dueDay, today)` exists (`features/todo/due.ts:8`); `isDueToday` does not and
  is added beside it. Click focuses that row in the TODO section (see "TODO focus intent").

### Zone 2 - Running sessions

Derived from `useAttentionStore(s => s.status)` - a `Record<sessionId, { status, since }>` keyed by
`${workspaceId}:${tabId}` - joined against the workspaces store for display names. Sorted by
`STATUS_PRIORITY` (waiting 3, done 2, working 1), then oldest `since` first.

Each row: a status dot in the existing `--status-*` hues, the workspace and tab name, the state with
its age ("waiting 4m"). Waiting rows get a primary **Go to** button calling
`navigateToSession(sessionId)` (`app/attentionWiring.ts:55`); done rows get the same as a ghost
button.

**Known blind spot, accepted:** a Claude tab before its first prompt and every plain shell tab carry
no attention entry and so do not appear. A session with no attention state has by definition nothing
that needs the user, which is what this zone is for. `sessions.listLive()` exists in core and preload
but is unreachable from the renderer; wiring it is a contained follow-up if the omission ever bites.

### Zone 3 - Time today

- **Logged today**: `totalMs(groupByDay(entries).get(dayKeyOf(now)) ?? [])`, rendered with
  `formatTotal` (`0m` floor rather than `formatDuration`'s `<1m`).
- **Wrong-week guard**: the time-tracking store holds exactly one week. Zone 3 derives only when
  `weekStart === weekStartOf(now)`; otherwise it loads the current week rather than showing a number
  from the wrong one. `SidebarTimeTracking.tsx:11-12` already guards this same hazard.
- **Weekend**: the board is Monday-Friday by design ("weekend sessions are excluded entirely - no
  card, no share in any total"). On Saturday and Sunday zone 3 states that plainly instead of showing
  a false `0m`. Extending the board to seven days belongs to #53.
- **Timer**: when nothing runs, a single primary button labelled **Start**. When something runs, the
  elapsed figure ticking each second, the description and issue key, and a **Stop** button.

### Zone 4 - System status

- **5h session** and **Weekly** meters from `useUsageStore` - already hydrated and live-subscribed at
  boot (`main.tsx:53-54`), so no new plumbing. `usedPercent` is already 0-100. Reuse
  `usageMeterColor`, `formatFiveHourReset`, `formatWeeklyReset` from `features/usage/format.ts`,
  which must be added to that feature's barrel; they are currently unreachable from outside.
- **Jira last synced**: `useMyWorkStore(s => s.fetchedAt)` through `formatRelativeTime`.
- **PRs last synced**: `syncedAt` on the prInbox store (see below).

## The native timer

### Storage - migration v22

```sql
CREATE TABLE running_timer (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  started_at  INTEGER NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  issue_key   TEXT
);
```

One global timer, single-row enforced by the schema rather than by convention. Start is replaced by
Stop while it runs, so concurrency never arises and no reconciliation logic is needed.

### Domain

```ts
/** The timer currently running, if any. Elapsed time is derived in the renderer from startedAt. */
export interface RunningTimer {
  startedAt: number
  description: string
  issueKey: string | null
}
```

### Behaviour

- **Start is one click.** Neither a description nor an issue key is required. Start stamps the issue
  key from `issueKeyFromBranch` applied to the selected workspace's branch, so stopping yields an
  already-attributed entry and #53's rollups have something to roll up. The guess is never silent -
  the running row displays the key the whole time it applies, and it is editable in place. No branch
  match means no key, and Start still works.
- **Stop writes immediately.** Elapsed is `now - startedAt`; the entry goes through the existing
  manual-entry write path as a `time_entry_manual` row for the current local day, and the
  `running_timer` row is cleared in the same transaction. The entry is then inline-editable on the
  board, which #42 already built. No modal and nothing to confirm: a dismissed confirmation would
  silently discard real elapsed time.
- **A forgotten timer keeps running.** Launching after leaving one on overnight shows the true
  elapsed figure. Nothing is auto-stopped or auto-truncated - the same reasoning that got the 20s quit
  fallback reverted in #57: inventing a number and writing it to a timesheet unasked is the worse
  failure. Stopping produces one entry the user corrects in place.
- **Two surfaces**: Dashboard zone 3 and the Time Tracking topbar. An app-wide chip stays with #53,
  which owns that topbar's rework.
- **No broadcast channel.** Single window, single store; four request/response channels plus a boot
  hydrate is the whole contract.

### Channels

`timeTracking:getTimer`, `timeTracking:startTimer`, `timeTracking:stopTimer`,
`timeTracking:updateTimer`, mirroring the shape of the existing five.

## Supporting changes

### TODO focus intent

`features/todo/store.ts` gains `pendingFocusId: string | null` and `focusTask(id)`. A new
`app/todoFocusWiring.ts` subscribes, clears the intent first, switches to the TODO section and
scrolls/highlights the row - the pattern established by `myWorkPrNavWiring.ts` and
`sessionResumeWiring.ts`. `TODO_SECTION_ID` is exported from the todo barrel; it is a bare literal
today. #54 can build its explicit-edit flow on this.

### PR sync freshness

`pr_cache.synced_at` is stamped on every sync (`db/prCacheRepo.ts:79,110`) and then dropped -
`toPr` never maps it and `PullRequest` has no such field. Adding a required field to `PullRequest`
would churn every test fixture that constructs one, so instead: a `getSyncedAt(): number | null`
repo method, one channel, and a `syncedAt` field on the prInbox store set on hydrate and after each
sync. Freshness then survives an app restart, which a renderer-only `Date.now()` stamp would not -
and unknown freshness right after launch is misleading exactly when it matters. #47 needs this same
seam.

### Shared clock

`shared/ui/useNow.ts`, a hook returning a timestamp that re-renders on an interval. The repo already
carries two ad-hoc copies of this `setInterval`/`clearInterval` pattern (`MyWorkView.tsx:181` and the
`prInbox` card ages). The Dashboard needs three cadences: 1s only while a timer runs, 60s for
relative ages, and the day key derived from the same source so an app left open overnight rolls over
instead of attributing work to yesterday. Today `dayKeyOf(Date.now())` is recomputed per render with
nothing invalidating it.

### Boot hydration

Add `todo` to the boot hydrate in `main.tsx`. This is a net win beyond this issue: `SidebarTodo`
reads `s.open.length`, so the rail's TODO count currently shows nothing until the user first opens
TODO. Sessions are **not** hydrated - zone 2 needs live attention state, not the historical index.

## Delivery

Two PRs, both closing #43. The schema migration lands isolated from the UI work and each PR is
reviewable on its own.

### PR 1 - native persisted timer

| File | Change |
| --- | --- |
| `core/db/migrations.ts` | migration v22, the `running_timer` table |
| `core/db/timeTrackingRepo.ts` | `getRunningTimer`, `startTimer`, `updateRunningTimer`, `clearRunningTimer` |
| `core/timeTracking/timeTracking.ts` | `startTimer`, `stopTimer`, `getRunningTimer` |
| `common/domain.ts` | `RunningTimer` |
| `common/ipc.ts` | the four channels |
| `core/api/timeTracking.ipc.ts`, `preload/index.ts` | handlers and bridge |
| `renderer/features/timeTracking/ipc.ts`, `store.ts` | seam; `timer: RunningTimer \| null` plus actions |
| `renderer/features/timeTracking/components/TimeTrackingView.tsx` | Start/Stop and the running figure in the topbar |
| `renderer/shared/ui/useNow.ts` | the shared ticking-clock hook |
| tests | repo, core, store, view mount, migration; `e2e/timetracking.spec.ts` gains start -> stop -> entry appears -> survives relaunch |

### PR 2 - the Dashboard

| File | Change |
| --- | --- |
| `features/dashboard/components/DashboardView.tsx` | rewrite: topbar plus the four-zone grid |
| `features/dashboard/components/Zone*.tsx` | one component per zone, each taking plain props |
| `features/dashboard/zones.ts` | pure derivation helpers, memoized in the components |
| `features/todo/due.ts`, `store.ts`, `index.ts` | `isDueToday`; `pendingFocusId` + `focusTask`; export `TODO_SECTION_ID` |
| `app/todoFocusWiring.ts` | new wiring |
| `features/attention/store.ts`, `index.ts` | export a live-session list helper and `STATUS_PRIORITY` |
| `core/db/prCacheRepo.ts`, `features/prInbox/store.ts` | `getSyncedAt()` plus one channel; `syncedAt` on the store |
| `features/usage/index.ts` | export the four existing format helpers |
| `renderer/main.tsx` | hydrate `todo` at boot, wire todo focus |
| `shared/ui/app.css` | a new `ix-dash*` banner section |
| tests | zone derivation, per-zone client mount, wiring; new `e2e/dashboard.spec.ts` on the shared harness |

The rail label stays `Dashboard` at `order: -10`, so `RAIL_LABELS` in `e2e/harness.ts` and the two
specs asserting it verbatim are untouched.

## Verification

The merge gate is `npm run typecheck && npm test && npm run lint && npm run e2e`, run by CI on every
PR and push to main. Playwright runs with `retries: 0` deliberately.

**Timer**: the single-row guard holds under a second start; stop writes exactly one entry with the
elapsed duration and clears the row; a timer running across midnight lands on the correct day key;
e2e start, quit, relaunch, still running.

**Zones**: action PRs and overdue/today TODOs group and sort as specified; `isDueToday` treats due
today as not overdue; zone 3's weekend and wrong-week states; every zone mounts clean with a
`console.error` spy asserted empty, which is how the #60 guard runs in CI.

**Navigation**: a PR row lands on that PR's detail; a TODO row lands on that row, focused; a waiting
session's Go to reveals its workspace and tab; e2e on a fresh profile renders all four zones in their
empty states without a crash.

## Risks

| Risk | Handling |
| --- | --- |
| Zone 2 misses neutral sessions | Accepted, reasoning above. |
| The #60 selector guard, on the default landing view | All derivation in `zones.ts` as pure functions over stable slices; per-zone mount tests with the `console.error` spy. |
| #64 - the prInbox barrel drags Monaco | Dashboard tests will need `vi.mock('monaco-editor')` purely to read a PR selector. Paid here, not fixed here; worth noting on #64 that it now has three unrelated consumers. |
| One-week time-tracking store | Wrong-week guard in zone 3. |
| Midnight rollover | The day key comes from `useNow`. |
| Weekend invisibility | Pre-existing; zone 3 states the weekend case rather than showing `0m`. |
| Rail assertions | Label and order unchanged. |
