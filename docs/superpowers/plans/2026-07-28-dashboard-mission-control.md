# Dashboard Mission Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Dashboard placeholder with four fixed zones that answer "what needs me now", composed from stores that already hold the data.

**Architecture:** `DashboardView` owns layout and hydration only. Each zone is its own component taking plain props. Every derivation lives in `zones.ts` as pure functions over stable store slices, memoized in the component - never inside a selector, because the store factory throws on a selector that returns a fresh reference and this view renders on every app launch. Three new seams: `isDueToday`, a TODO focus intent with an app-layer wiring module, and a PR `syncedAt` read.

**Tech Stack:** Electron, TypeScript, React 19, Zustand via `createStore`, Vitest (jsdom project), Playwright.

PR 2 of two for issue #43, and the one that closes it. PR 1 (the native timer, merged as #72) already exports `TimerControl` from the timeTracking barrel. Spec: `docs/superpowers/specs/2026-07-28-dashboard-mission-control-design.md`.

**Deviation from the usual plan format, deliberate:** tasks below give exact interfaces, file anchors, and the full behaviour each test must pin, but they do not transcribe every line of JSX. PR 1 showed the cost of over-specifying: a plan-authored defect and a false timing assumption were copied faithfully into the code and its tests, where nothing downstream could question them. Where this plan states a rule, follow it; where it describes markup, use the surrounding feature's idiom and your judgement.

## Global Constraints

- Renderer stores only via `createStore` from `@renderer/shared/store/createStore`. No selector may return a freshly built array or object: read a stable slice and derive with `useMemo`, or wrap a flat result in `useShallow`. `docs/agents/domain.md:23-43` is the authority. **This view is the app's default landing surface (`resolveShellContext` falls back to the first section with a `mainComponent`, and Dashboard is `order: -10`), so a guard trip here is a crash on boot.**
- Cross-feature imports only through `@renderer/features/<name>` barrels, never internals. Cross-slice *navigation* goes through an `app/*Wiring.ts` module reacting to a pending-intent field, never a direct store-to-store import - see `app/myWorkPrNavWiring.ts` and `app/sessionResumeWiring.ts`.
- Do not add an ErrorBoundary; `App.tsx:50` already wraps the region with `key="dashboard"`.
- Root element is `<div className="ix-main">`. `.ix-main` is a flex column with `min-height: 0`, so the scrolling child needs `flex: 1; min-height: 0; overflow-y: auto`.
- CSS: a new `ix-dash*` banner section in `shared/ui/app.css`, colours/radii/fonts only via `var(--…)` from `theme.css`. `e2e/theme.spec.ts` asserts the token values.
- Keep `id: 'dashboard'`, `order: -10`, `label: 'Dashboard'`. Changing the label breaks `RAIL_LABELS` in `e2e/harness.ts` and two specs that assert it verbatim.
- Vitest globals are off; `@testing-library/jest-dom` is not installed - assert with plain DOM queries.
- New e2e work uses `e2e/harness.ts`; never import `_electron`.
- Comments carry business meaning, never reference issues or PRs.
- Gate: `npm run typecheck && npm test && npm run lint && npm run e2e`.

## File Structure

| File | Responsibility |
| --- | --- |
| `features/dashboard/zones.ts` | create - every pure derivation, one exported function per zone |
| `features/dashboard/zones.test.ts` | create |
| `features/dashboard/components/DashboardView.tsx` | rewrite - layout, hydration, the shared clock |
| `features/dashboard/components/ZoneNeedsAction.tsx` | create |
| `features/dashboard/components/ZoneSessions.tsx` | create |
| `features/dashboard/components/ZoneTimeToday.tsx` | create |
| `features/dashboard/components/ZoneSystemStatus.tsx` | create |
| `features/dashboard/components/DashboardView.test.tsx` | create - mount tests, one per zone state |
| `features/todo/due.ts` + `.test.ts` | add `isDueToday` |
| `features/todo/store.ts` | add `pendingFocusId` + `focusTask(id)` |
| `features/todo/register.ts`, `index.ts` | export `TODO_SECTION_ID`, `isDueToday`, `focusTask` reachable via the store |
| `features/todo/components/TodoView.tsx` + `TodoItem.tsx` | honour the focus intent |
| `app/todoFocusWiring.ts` + `.test.ts` | create - the cross-slice jump |
| `features/attention/store.ts`, `index.ts` | export `liveSessions()` and `STATUS_PRIORITY` |
| `features/usage/index.ts` | export the four helpers in `format.ts` |
| `core/db/prCacheRepo.ts`, `core/api/prInbox.ipc.ts`, `common/ipc.ts`, `preload/index.ts` | `getSyncedAt()` |
| `features/prInbox/ipc.ts`, `store.ts` | `syncedAt` state |
| `app/registerFeatures.ts` or `main.tsx` | hydrate `todo` at boot, wire todo focus |
| `shared/ui/app.css` | `ix-dash*` |
| `e2e/dashboard.spec.ts` | create |

---

### Task 1: PR sync freshness reaches the renderer

**Files:** `core/db/prCacheRepo.ts`, `core/db/prCacheRepo.test.ts`, `common/ipc.ts`, `core/api/prInbox.ipc.ts` (+ its existing test), `preload/index.ts`, `features/prInbox/ipc.ts`, `features/prInbox/store.ts` (+ its test)

**Interfaces produced:** `PrCacheRepo.getSyncedAt(): number | null`; channel `prInboxGetSyncedAt`; `ipc().prInbox.getSyncedAt()`; `syncedAt: number | null` on the prInbox store.

`pr_cache.synced_at` is already stamped on every `replaceAll` (`prCacheRepo.ts:79,110`) and then dropped - `toPr` never maps it and `PullRequest` has no such field. Do **not** add a field to `PullRequest`: it is constructed by many test fixtures, and a per-PR copy of one cache-wide timestamp is the wrong shape anyway.

- [ ] **Step 1: Failing repo test.** `getSyncedAt()` returns null on an empty cache, and after `replaceAll` returns the `now()` the injected deps produced. Assert it changes on a second `replaceAll`.
- [ ] **Step 2: Run it, confirm it fails.** `npx vitest run src/core/db/prCacheRepo.test.ts`
- [ ] **Step 3: Implement.** `SELECT MAX(synced_at) AS t FROM pr_cache` - `MAX` over an empty table yields a row with `t: null`, so return `row?.t ?? null` rather than assuming a row means a value.
- [ ] **Step 4: Wire the channel** through `common/ipc.ts`, `prInbox.ipc.ts` handlers and wire routes, `preload/index.ts`, and `features/prInbox/ipc.ts`. The existing `prInbox.ipc.test.ts` pins the exact channel key set - update it, and add the round trip for the new channel.
- [ ] **Step 5: Store field.** `syncedAt: number | null`, set from `getSyncedAt()` in `hydrate()` and after a successful `sync()`. Failure to read it must not fail the board: swallow it and leave the previous value. Test that hydrate populates it and that a sync refreshes it.
- [ ] **Step 6: `npm run typecheck && npx vitest run src/core src/renderer/src/features/prInbox`**
- [ ] **Step 7: Commit** `feat(prInbox): surface when the PR cache was last synced (#43)`

---

### Task 2: Due-today, and a TODO you can jump to

**Files:** `features/todo/due.ts` + `.test.ts`, `features/todo/store.ts` + `.test.ts`, `features/todo/register.ts`, `features/todo/index.ts`, `features/todo/components/TodoView.tsx`, `features/todo/components/TodoItem.tsx`, `app/todoFocusWiring.ts` + `.test.ts`, `main.tsx`

**Interfaces produced:** `isDueToday(dueDay: string, today: string): boolean`; `TODO_SECTION_ID`; on the todo store `pendingFocusId: string | null` and `focusTask(id: string): void`; `wireTodoFocus(): () => void` from `app/todoFocusWiring.ts`.

`isOverdue` already exists (`due.ts:8`) and treats due-today as *not* overdue - the day is not over. `isDueToday` is its sibling, not a replacement. Day keys are `yyyy-mm-dd`, so plain string comparison is exact.

- [ ] **Step 1: Failing test for `isDueToday`.** True only on an exact match; false for yesterday and tomorrow. Pin that a day is both not-overdue and due-today on the same date, so the two predicates cannot drift into disagreeing.
- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Implement** `isDueToday` as a one-line comparison beside `isOverdue`, and export it from the feature barrel.
- [ ] **Step 4: Failing test for the focus intent.** `focusTask(id)` sets `pendingFocusId`; the wiring module clears it *before* switching section (the order the existing wiring modules use, so a failure cannot leave a stuck intent that replays); the section becomes `TODO_SECTION_ID`. Export `TODO_SECTION_ID` from `register.ts` - it is a bare literal today - and follow `app/myWorkPrNavWiring.ts` for the subscribe/unsubscribe shape.
- [ ] **Step 5: Implement** the store field, the action, `app/todoFocusWiring.ts`, and its call in `main.tsx` beside the other `wire*` calls.
- [ ] **Step 6: Land the focus in the list.** `TodoView` reads the id the wiring left, scrolls that row into view and marks it. `scrollIntoView` is stubbed in `vitest.setup.dom.ts`, so a test asserts the marking class, not the scroll. Clear the mark once applied so it does not persist as permanent selection.
- [ ] **Step 7: Hydrate todo at boot.** Add `useTodoStore.getState().load()` to `main.tsx` alongside the existing prInbox/usage/myWork hydrates. Independent of the Dashboard this fixes a real inconsistency: `SidebarTodo` reads `s.open.length`, so the rail's TODO count shows nothing until the user first opens TODO.
- [ ] **Step 8: `npx vitest run src/renderer/src/features/todo src/renderer/src/app`**
- [ ] **Step 9: Commit** `feat(todo): due-today predicate and a jump-to-task intent (#43)`

---

### Task 3: Live sessions and usage become readable from outside

**Files:** `features/attention/store.ts`, `features/attention/index.ts`, `features/attention/store.test.ts`, `features/usage/index.ts`

**Interfaces produced:** `STATUS_PRIORITY: Record<SessionStatus, number>`; `liveSessions(status: Record<string, AttentionEntry>): { sessionId: string; workspaceId: string; tabId: string; status: SessionStatus; since: number }[]`, sorted by descending priority then ascending `since`. From the usage barrel: `formatFiveHourReset`, `formatWeeklyReset`, `formatCapturedAt`, `usageMeterColor`.

`STATUS_PRIORITY` exists but is module-private (`attention/store.ts:86`); `oldestWaitingSession` returns a single id and there is no list helper. `liveSessions` is a **pure function over the slice**, not a store selector - it builds a fresh array, so it must be memoized at the call site. Use `parseSessionId` (`common/ipc.ts:641`) to split the key rather than splitting on `:` by hand.

- [ ] **Step 1: Failing test.** Waiting sorts above done above working; equal statuses sort oldest-`since` first; an empty record yields an empty array; the returned entries carry a parsed `workspaceId` and `tabId`.
- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Implement and export** both, plus the four usage formatters from `features/usage/index.ts` (`format.ts` is currently unreachable from outside the feature).
- [ ] **Step 4: `npx vitest run src/renderer/src/features/attention`**
- [ ] **Step 5: Commit** `feat(attention): expose the live-session list and its ordering (#43)`

---

### Task 4: Zone derivation

**Files:** `features/dashboard/zones.ts`, `features/dashboard/zones.test.ts`

Pure functions only - no React, no store imports, no `Date.now()`. Every one takes `now` or `today` as an argument so the tests are exact and nothing here can trip the selector guard.

**Interfaces produced:**

```ts
export interface ActionPr { pr: PullRequest; reason: string | null }
export interface DeadlineTodo { task: TodoTask; overdue: boolean }

/** Action-column PRs, oldest first - the longest-blocked review is the most urgent. */
export function actionPrs(prs: PullRequest[]): ActionPr[]

/** Open tasks that are overdue or due today, overdue first, then by due day. */
export function deadlineTodos(open: TodoTask[], today: string): DeadlineTodo[]

/** Today's logged total, or null when the loaded week is not the current one. */
export function loggedToday(entries: TimeEntry[], weekStart: string, now: number): number | null

/** Whether the local day of `now` falls outside the Monday-Friday board. */
export function isWeekend(now: number): boolean
```

Rules the tests must pin:

- `actionPrs` uses `boardColumn(pr) === 'action'` and carries `boardReason(pr)`, both from `@common/prBoard` - do not restate that logic, and do not use `myWork/prGroups.ts`, which is a different taxonomy for a different screen.
- `deadlineTodos` excludes tasks with `dueDay === null` and anything already done. Due today is not overdue.
- `loggedToday` returns **null**, not 0, when `weekStart !== weekStartOf(now)`: the store holds exactly one week, and reporting 0 for "you navigated to March" is a wrong number rather than a missing one. Zone 3 renders those two cases differently.
- `loggedToday` sums with `totalMs` over the entries whose `day` is `dayKeyOf(now)`.
- `isWeekend` exists so zone 3 can say the board does not track weekends instead of showing `0m`.

- [ ] **Step 1: Write the failing tests** for all four, including the null-vs-zero distinction and a weekend case.
- [ ] **Step 2: Run them, confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: `npx vitest run src/renderer/src/features/dashboard`**
- [ ] **Step 5: Commit** `feat(dashboard): derive the four zones from existing stores (#43)`

---

### Task 5: The zones on screen

**Files:** the four `Zone*.tsx`, `DashboardView.tsx`, `DashboardView.test.tsx`, `shared/ui/app.css`

Layout: `Needs action` in a `minmax(0, 1.45fr)` column, the other three stacked in a `minmax(0, 1fr)` column, collapsing to one column below 860px. Fixed order, never reshuffling. An empty zone keeps its heading and shrinks to a one-line state; it never disappears or moves.

`DashboardView` owns: the `useNow` cadences (60s always, and the day key derived from it so an app left open overnight rolls over), the idle-guarded hydrates for the stores that are not hydrated at boot, and the `useMemo` calls feeding each zone. Zones take plain props and read no stores, except `ZoneTimeToday` which mounts `TimerControl` from the timeTracking barrel - that component reads the timer itself and owns its own 1s tick.

Per zone:

- **Needs action** - two labelled subgroups, PRs then deadlines, each with a count. A PR row shows title, repository, `boardReason`, age via `formatRelativeTime`; clicking it sets the prInbox section then calls `openDetail(repositoryId, prId)`. A TODO row shows the text and `formatDueDay`, overdue marked distinctly; clicking calls `focusTask(id)`.
- **Running sessions** - a status dot in the existing `--status-*` hues, the workspace name, the status with its age. Waiting rows get a primary "Go to" calling `navigateToSession(sessionId)`; done rows the same as a ghost button. Resolve the workspace name from `useWorkspacesStore` `byId`; **there is no cross-workspace tab title** - `useTabsStore` holds one workspace at a time - so do not try to show a tab name.
- **Time today** - `formatTotal(loggedToday)` plus `TimerControl`. Three distinct states: a total, "the board does not track weekends" when `isWeekend`, and a prompt to return to the current week when `loggedToday` is null.
- **System status** - the two usage meters (reuse the `usageMeterColor` thresholds and mirror `SidebarUsage`'s meter markup at dashboard scale), then Jira and PR rows showing `formatRelativeTime` of `fetchedAt` / `syncedAt`, or "never" when null.

Hydration: `prInbox`, `usage`, `myWork` and `todo` are hydrated at boot (todo as of Task 2). `timeTracking` is **not** - guard on `status === 'idle'` before calling `hydrate()`, as `SessionsView.tsx:15` does. Do not hydrate `sessions`: zone 2 needs live attention state, not the historical index.

- [ ] **Step 1: Failing mount tests.** One per zone for the populated case and one for the empty case, plus a fresh-store mount with nothing configured. **Every test asserts a `console.error` spy is empty** - that is how the store-factory guard runs in CI, and it is the single most important assertion in this task. Reading a PR selector pulls Monaco through the prInbox barrel, so these files need `vi.mock('monaco-editor', () => ({ editor: {} }))`; that is the tax described in #64, paid not fixed.
- [ ] **Step 2: Run them, confirm they fail.**
- [ ] **Step 3: Implement** the zones, the view, and the `ix-dash*` CSS.
- [ ] **Step 4: `npx vitest run src/renderer/src/features/dashboard && npm run typecheck`**
- [ ] **Step 5: Commit** `feat(dashboard): four fixed zones replacing the placeholder (#43)`

---

### Task 6: End to end on a real profile

**Files:** `e2e/dashboard.spec.ts`

Use `launch` from the harness. The rail label and order are unchanged, so `RAIL_LABELS` needs no edit.

- [ ] **Step 1: Write the spec.** On a fresh profile with nothing configured, the Dashboard is the landing view and renders all four zone headings in their empty states with no crash and no error boundary (`.ix-crash` absent) - this is the case every launch hits, so it matters more than any populated fixture. Then start the timer from zone 3 and assert the zone reflects it, proving `TimerControl` works on this surface too.
- [ ] **Step 2: Do not run it.** The full e2e pass is run in one batch outside this plan.
- [ ] **Step 3: Commit** `test(e2e): the Dashboard renders its four zones on a fresh profile (#43)`

---

## Self-review against the spec

Spec coverage: zone 1 (Task 4 + 5), zone 2 (Tasks 3 + 5), zone 3 (Tasks 4 + 5, timer from PR 1), zone 4 (Tasks 1 + 3 + 5), TODO focus intent (Task 2), PR `syncedAt` (Task 1), shared clock (delivered in PR 1), boot hydration (Task 2), layout and empty-zone behaviour (Task 5), the #60 guard (Task 5 Step 1), the #64 Monaco tax (Task 5 Step 1, accepted). The spec's `isDueToday` and `TODO_SECTION_ID` are Task 2.

Type consistency: `ActionPr`/`DeadlineTodo` are produced in Task 4 and consumed in Task 5; `liveSessions` returns `sessionId` and that is exactly what `navigateToSession` takes; `syncedAt` and `fetchedAt` are both `number | null` and both render through `formatRelativeTime`.

Not in scope, and deliberately: the issue-key-from-branch prefill for Start (needs a "branch of this folder" seam that does not exist - `WorktreeInfo.branch` is only reachable via the project-scoped `projects.listWorktrees`), a seven-day board, and splitting the prInbox barrel.
