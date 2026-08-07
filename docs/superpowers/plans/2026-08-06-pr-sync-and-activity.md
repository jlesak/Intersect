# PR Auto-Sync and Activity Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The PR board refreshes itself when you come back to the window, says how fresh it is, and orders every column by what actually happened last rather than by when each pull request was born.

**Architecture:** Three layers, each with one job. The core derives `lastActivityAt` inside the thread fetch it already performs and persists it. The renderer store gains `syncError` and sorts by activity. A new `app/prSyncWiring.ts` owns the focus listener and both guards, so no scheduling state lives in the store.

**Tech Stack:** Electron, TypeScript 5.9, React 19, Zustand via `createStore`, better-sqlite3 with versioned forward migrations, Vitest 4 (`node` + `dom` projects), Playwright.

Closes #47 and #52. Spec: `docs/superpowers/specs/2026-08-06-pr-sync-and-activity-design.md` - **the spec governs.** Where this plan and the spec disagree, the spec is right and the plan has a bug; say so rather than implementing the plan.

**Deviation from the usual plan format, deliberate:** tasks give exact interfaces, file anchors, and the full behaviour each test must pin, but they do not transcribe every line of implementation. Over-specifying costs quality here: on the native-timer PR a plan-authored defect and a false timing assumption were copied faithfully into the code and its tests, where nothing downstream could question them. Where this plan states a rule, follow it; where it describes markup or mechanism, use the surrounding code's idiom and your judgement.

## Global Constraints

- **Work only inside `/Users/janlesak/Projects/Intersect-gh47`.** This is a git worktree on `feature/gh47-pr-sync-activity`. Two other worktrees share this repository and `npm run e2e` builds into a per-worktree `out/`. Never `cd` to another checkout, never switch branches, never `git pull`.
- Renderer stores only via `createStore` from `@renderer/shared/store/createStore`. No selector may return a freshly built array or object: read a stable slice and derive with `useMemo`, or wrap a flat result in `useShallow`. `docs/agents/domain.md:23-43` is the authority. A guard trip is a thrown error, i.e. a crash.
- Cross-feature imports only through `@renderer/features/<name>` barrels, never internals. Pure logic shared by two features goes in `src/common/`, beside `prBoard.ts` and `week.ts`.
- Comments carry business meaning, never reference issues, PRs, tasks or older code.
- Never use an em dash in code, comments, copy or commit messages. Use a plain dash.
- Colours, radii and fonts only via `var(--…)` from `theme.css`. `e2e/theme.spec.ts` asserts token values.
- Vitest globals are off; `@testing-library/jest-dom` is not installed - assert with plain DOM queries.
- New e2e work uses `e2e/harness.ts`; never import `_electron`.
- Migrations are append-only. Never edit an existing migration; add the next version and bump `LATEST_VERSION`.
- Gate: `npm run typecheck && npm test && npm run lint && npm run e2e`.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/common/domain.ts` | modify - add `lastActivityAt` to `PullRequest` |
| `src/common/ado.ts` + `.test.ts` | create - `hasAdoConnection`, the one rule for "is ADO connected" |
| `src/core/prInbox/adoService.ts` | modify - derive `lastActivityAt` in the existing enrich step |
| `src/core/prInbox/adoMapping.ts` | modify - seed the field on map |
| `src/core/prInbox/adoE2eStub.ts` | modify - stub the field |
| `src/core/db/migrations.ts` | modify - add the column, backfill from `created_at` |
| `src/core/db/prCacheRepo.ts` | modify - read and write the column |
| `src/renderer/src/features/prInbox/store.ts` | modify - `syncError`, sort by activity |
| `src/renderer/src/features/dashboard/zones.ts` | modify - `adoSetup` delegates to `hasAdoConnection` |
| `src/renderer/src/app/prSyncWiring.ts` + `.test.ts` | create - focus listener and both guards |
| `src/renderer/src/main.tsx` | modify - `wirePrSync()` |
| `src/renderer/src/features/prInbox/components/PrBoard.tsx` | modify - sync chip, stale line, `useNow` |
| `src/renderer/src/features/prInbox/components/PrCard.tsx` | modify - activity age, two badges, `now` prop |
| `src/renderer/src/shared/ui/app.css` | modify - chip and badge styling |
| `e2e/prSync.spec.ts` | create |

Test files live beside their subject and follow the neighbouring file's existing conventions.

---

### Task 1: A pull request carries when it was last touched

**Files:** `src/common/domain.ts`, `src/core/prInbox/adoService.ts`, `src/core/prInbox/adoMapping.ts` (+ its test), `src/core/prInbox/adoE2eStub.ts`, `src/core/db/migrations.ts` (+ its test), `src/core/db/prCacheRepo.ts` (+ its test)

**Interfaces produced:** `lastActivityAt: number` on `PullRequest`, populated by every path that produces one.

One agent owns this whole vertical slice, because the field is meaningless until it survives a round trip through SQLite.

The derivation belongs in the existing enrich step of `adoService.sync` (`adoService.ts:168-179`), which already fetches every thread of every PR to count unresolved ones. Do not add a second fetch.

```
lastActivityAt = max(pr.createdAt, every comment's publishedAt across every thread)
```

Rules the tests must pin:

- **System threads count.** ADO records pushes and vote changes as system threads (`isSystem` true) carrying real timestamps, and those are exactly the events #52 wants ordering by. Do not filter by `isSystem` here - the unresolved *count* on the next line does filter, and confusing the two is the easy mistake.
- `createdAt` is the floor. A PR with no threads, or whose only comment had no parseable `publishedDate` (which `toThread` maps to `0`), is dated by its own creation, never by zero.
- **Carry forward on failure.** When a PR's thread fetch throws, that PR keeps its previously cached `lastActivityAt`, exactly as `activeThreadCount` already does via `d.priorThreadCount`. A transient failure must not move a card. This needs a sibling of `priorThreadCount` on the service deps; follow how `priorThreadCount` is declared and supplied.
- The migration adds `last_activity_at INTEGER NOT NULL DEFAULT 0`, then backfills `UPDATE pr_cache SET last_activity_at = created_at`. Test that a row inserted under the *old* schema reads back with `lastActivityAt === createdAt` after migrating, not `0`. Rows already cached would otherwise render as 1970 until the next successful sync.

- [ ] **Step 1: Failing tests** for the derivation (newest comment across all threads including system; `createdAt` floor with no threads and with an unparseable date; carry-forward when the thread fetch throws), the migration backfill, and the repo round trip.
- [ ] **Step 2: Run them, confirm they fail.** `npx vitest run src/core src/common`
- [ ] **Step 3: Implement** the domain field, the derivation, the migration, the repo mapping, and the stub.
- [ ] **Step 4: `npx vitest run src/core src/common && npm run typecheck`**
- [ ] **Step 5: Commit** `feat(prInbox): a pull request carries when it was last touched (#52)`

---

### Task 2: One rule for whether Azure DevOps is connected

**Files:** `src/common/ado.ts` + `.test.ts`, `src/renderer/src/features/dashboard/zones.ts` (+ its test)

**Interfaces produced:** `hasAdoConnection(ado: AdoSettings, fallback: AdoFallback): boolean` from `@common/ado`.

`adoSetup` (`zones.ts:35`) answers two questions at once: whether settings have loaded, and whether they amount to a connection. Only the second is needed outside the dashboard, and it does not belong to a renderer feature.

Move the connection rule verbatim - an organisation URL and a token, each satisfiable by a saved value or by the `~/.claude.json`/environment fallback, a blank saved field deferring to the fallback rather than overriding it. `adoSetup` keeps its `'configured' | 'missing' | 'unknown'` signature and delegates, so its callers and tests do not change.

- [ ] **Step 1: Failing tests** for `hasAdoConnection`: saved values only, fallback only, blank saved field deferring to a present fallback, and each half missing on its own.
- [ ] **Step 2: Run them, confirm they fail.**
- [ ] **Step 3: Implement** and rewire `adoSetup` to delegate. Its existing tests must still pass untouched, including `unknown` before settings load - if one needs editing, the delegation changed behaviour and is wrong.
- [ ] **Step 4: `npx vitest run src/common src/renderer/src/features/dashboard && npm run typecheck`**
- [ ] **Step 5: Commit** `refactor(prInbox): one rule for whether Azure DevOps is connected (#47)`

---

### Task 3: The board admits a failed refresh, and orders by activity

**Files:** `src/renderer/src/features/prInbox/store.ts` + `store.test.ts`

**Interfaces produced:** `syncError: string | null` on the prInbox store.

**Consumes:** `lastActivityAt` from Task 1.

Two small changes to one file:

- `syncError` is set from any sync failure and cleared on every success, so it always describes the latest attempt. The quiet path stays quiet: it sets the field and does not toast. The loud path keeps its existing `reportError` toast **and** sets the field.
- `groupBoardColumns` (`store.ts:145`) sorts each column by `lastActivityAt` descending instead of `createdAt`. It is a pure function memoized at the call site, not a selector, so this cannot destabilise a snapshot.

- [ ] **Step 1: Failing tests.** A failed quiet sync sets `syncError` and leaves `prs` untouched; a failed loud sync sets it too; a success clears it; `groupBoardColumns` orders a column by activity where creation order would give the opposite answer.
- [ ] **Step 2: Run them, confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: `npx vitest run src/renderer/src/features/prInbox && npm run typecheck`**
- [ ] **Step 5: Commit** `feat(prInbox): the board admits a failed refresh and orders by activity (#47)`

---

### Task 4: The window coming back into focus refreshes the board

**Files:** `src/renderer/src/app/prSyncWiring.ts` + `.test.ts`, `src/renderer/src/main.tsx`

**Interfaces produced:** `wirePrSync(): () => void`.

**Consumes:** `hasAdoConnection` from Task 2, `syncedAt` and `syncing` from the prInbox store.

Follow `app/attentionWiring.ts:97` for the `window` focus listener and `app/myWorkPrNavWiring.ts` for the subscribe/unsubscribe shape. Call it in `main.tsx` beside the other `wire*()` calls.

```
STALE_AFTER_MS = 5 * 60 * 1000
```

Sync quietly - always `{ quiet: true }` - when all three hold:

- `hasAdoConnection` is true for the current settings and fallback
- `syncedAt` is null, or older than `STALE_AFTER_MS`
- `syncing` is false

Fire on boot and on every `window` `focus` event. **Settings load asynchronously** (`app/settingsWiring.ts:16`), so a boot sync fired synchronously at wire time would read empty settings and wrongly conclude ADO is not connected. Wait for the settings store to reach `ready`: act immediately if it already is, otherwise subscribe until it is and unsubscribe once it fires. A settings load that ends in `error` means no automatic sync; the next focus event re-evaluates.

Rules the tests must pin: a focus event on a stale, configured, idle store syncs quietly; it does not sync when fresh, when unconfigured, when a sync is in flight, or when settings never reached `ready`; the boot path waits for `ready` rather than reading `idle` settings; the returned function removes the listener so a second focus event after teardown does nothing.

- [ ] **Step 1: Failing tests** for each rule above, driving real `window.dispatchEvent(new Event('focus'))` rather than calling the handler directly.
- [ ] **Step 2: Run them, confirm they fail.**
- [ ] **Step 3: Implement** the wiring and its `main.tsx` call.
- [ ] **Step 4: `npx vitest run src/renderer/src/app && npm run typecheck`**
- [ ] **Step 5: Commit** `feat(prInbox): the window coming back into focus refreshes the board (#47)`

---

### Task 5: Freshness and activity on screen

**Files:** `src/renderer/src/features/prInbox/components/PrBoard.tsx` + `PrBoard.test.tsx`, `PrCard.tsx` (+ a test file if none exists), `src/renderer/src/shared/ui/app.css`

**Consumes:** `syncError` and the activity sort from Task 3, `lastActivityAt` from Task 1.

`PrBoard` takes a `useNow(60_000)` tick from `@renderer/shared/ui/useNow` so freshness ages on screen instead of freezing at first render, and passes `now` down to each card.

- **Sync chip**, beside the existing Sync button (`PrBoard.tsx:27-32`): "Synced 4m ago" from `syncedAt`, "never synced" when null, warning-toned once older than 15 minutes. Reuse `formatRelativeTime` from the myWork barrel rather than adding a fourth relative-time formatter.
- **Stale line**, when `syncError` is not null: mirror the Jira board's inline pattern (`MyWorkView.tsx:55-69`, classes `ix-mw-loading ix-mw-stale`) reading "Could not refresh: <reason>". **The cached board stays fully visible beneath it** - a failed refresh must never blank out data the user can still act on.
- **`PrCard`**: the age chip reads `lastActivityAt` and takes `now` as a prop instead of calling `Date.now()` internally; add a `● new changes` chip when `newChangesSinceMyReview` and an `N unresolved` chip when `activeThreadCount > 0`. Both fields already exist on the model and are simply unrendered today.

The 5-minute sync guard and the 15-minute warning threshold are deliberately different values; the spec explains why, and neither is dead code. Do not collapse them into one constant.

- [ ] **Step 1: Failing mount tests.** The chip's three states including the warning threshold; the stale line present on `syncError` **with the cached cards still rendered**; the age chip reflecting activity rather than creation; each badge appearing only when its field warrants it. Reading a PR selector pulls Monaco through the prInbox barrel, so these files need `vi.mock('monaco-editor', () => ({ editor: {} }))` - that is the known tax of #64, paid not fixed. Assert a `console.error` spy stays empty so a tripped store guard fails the test rather than the app.
- [ ] **Step 2: Run them, confirm they fail.**
- [ ] **Step 3: Implement** the components and the CSS.
- [ ] **Step 4: `npx vitest run src/renderer/src/features/prInbox && npm run typecheck`**
- [ ] **Step 5: Commit** `feat(prInbox): freshness and activity on the board (#47)`

---

### Task 6: End to end on a real profile

**Files:** `e2e/prSync.spec.ts`

Use `launch` from `e2e/harness.ts`.

On a fresh profile with no Azure DevOps configured: the PR board shows its never-synced chip, shows **no** failure banner, and no sync is attempted. That is the case every launch on an unconfigured machine hits, so it matters more than any populated fixture - and it is the one the guard exists to protect.

- [ ] **Step 1: Write the spec.**
- [ ] **Step 2: Do not run it.** The full e2e pass runs once, batched, outside this plan.
- [ ] **Step 3: Commit** `test(e2e): the PR board says it never synced on a fresh profile (#47)`

---

## Self-review against the spec

**Spec coverage:** `lastActivityAt` derivation, floor, carry-forward, migration and backfill (Task 1); `hasAdoConnection` and the `adoSetup` delegation (Task 2); `syncError` and the activity sort (Task 3); the focus trigger, both guards, the in-flight check and the settings-ready wait (Task 4); sync chip, stale line, activity age chip and both card badges (Task 5); the unconfigured fresh-profile case (Task 6). The error-handling table's rows map to Tasks 1 (thread-fetch carry-forward), 3 (quiet vs loud) and 4 (unconfigured, in-flight, settings not loaded); one repository failing is existing behaviour no task changes.

**Type consistency:** `lastActivityAt: number` is produced in Task 1 and consumed by Tasks 3 and 5. `hasAdoConnection(ado, fallback): boolean` is produced in Task 2 and consumed in Task 4. `syncError: string | null` is produced in Task 3 and consumed in Task 5. `wirePrSync(): () => void` matches the other `wire*` functions `main.tsx` already calls.

**Ordering:** Tasks 1 and 2 are independent. Task 3 needs 1, Task 4 needs 2, Task 5 needs 1 and 3, Task 6 needs the UI to exist. Each task ends green and committed, so a reviewer can reject one without unpicking its neighbours.

**Not in scope, deliberately:** the Dashboard's `actionPrs` keeps ordering by `createdAt` (`features/dashboard/zones.ts:89`) - flagged in the spec, not folded in; a periodic sync timer, dropped in favour of the focus trigger; and splitting the prInbox barrel (#64).
