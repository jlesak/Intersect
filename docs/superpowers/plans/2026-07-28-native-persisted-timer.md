# Native Persisted Timer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Intersect a real start/stop work timer that survives a quit or crash, so Dashboard zone 3 (#43) and the Time Tracking topbar can offer Start/Stop and stopping produces a normal, editable worklog entry.

**Architecture:** One durable SQLite row (`running_timer`, single-row by schema constraint) holds `startedAt`, a description and an issue key. Elapsed time is never stored - it is derived in the renderer from `startedAt`, so a forgotten timer reports the truth after a relaunch. Stopping computes the elapsed span in the core and writes it through the existing manual-entry path, then clears the row. Four request/response IPC channels, no broadcast: the app is a single window with a single store.

**Tech Stack:** Electron, TypeScript, `node:sqlite`, React 19, Zustand (via the repo's `createStore` factory), Vitest (node + jsdom projects), Playwright.

This is PR 1 of two for issue #43. PR 2 (the Dashboard itself) is planned separately and consumes what this builds. Spec: `docs/superpowers/specs/2026-07-28-dashboard-mission-control-design.md`.

## Global Constraints

- Renderer stores are built with `createStore` from `@renderer/shared/store/createStore`, never zustand's `create`. ESLint enforces it.
- A selector must not build a fresh array or object. The factory calls every selector twice against one state and throws when the results differ. `s.timer` is a stored object reference and is therefore safe to read directly.
- Cross-feature imports go through `@renderer/features/<name>` barrels only, never internals.
- Styling uses only the CSS custom properties in `src/renderer/src/shared/ui/theme.css`. Never a literal hex - `e2e/theme.spec.ts` asserts the token values.
- Do not add an ErrorBoundary to a feature view; `App.tsx:50` already wraps the main region.
- New e2e work uses `e2e/harness.ts`. Never import `_electron` directly - ESLint bans it outside the frozen `UNMIGRATED_E2E_SPECS` list, and nothing may be added to that list.
- Vitest globals are off. Every test file imports `describe`, `test`, `expect`, `vi`, `beforeEach`, `afterEach` from `'vitest'` explicitly.
- `@testing-library/jest-dom` is not installed. Assert with plain DOM queries (`document.querySelector`, `.textContent`), never `toBeInTheDocument()`.
- Day keys are `yyyy-mm-dd` in the user's local timezone. All date arithmetic goes through `@common/week`, never fixed 24h offsets.
- The merge gate is `npm run typecheck && npm test && npm run lint && npm run e2e`.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/common/domain.ts` | `RunningTimer` shape (modify) |
| `src/common/ipc.ts` | Four channel constants and the `IpcApi['timeTracking']` methods (modify) |
| `src/core/db/migrations.ts` | Migration v22 creating `running_timer` (modify) |
| `src/core/db/timeTrackingRepo.ts` | `RunningTimerRepo` - the row's only reader and writer (modify) |
| `src/core/timeTracking/timeTracking.ts` | Start/stop/update rules; stop composes elapsed into a manual entry (modify) |
| `src/core/api/timeTracking.ipc.ts` | Handler delegation and wire routes (modify) |
| `src/core/api/timeTracking.ipc.test.ts` | Handler delegation coverage (create) |
| `src/core/bootstrap.ts` | Construct the repo and pass it to the service (modify) |
| `src/preload/index.ts` | Bridge the four channels (modify) |
| `src/renderer/src/shared/ui/useNow.ts` | Shared ticking clock (create) |
| `src/renderer/src/shared/ui/useNow.test.tsx` | Its test (create) |
| `src/renderer/src/features/timeTracking/ipc.ts` | Renderer seam (modify) |
| `src/renderer/src/features/timeTracking/store.ts` | `timer` state and its three actions (modify) |
| `src/renderer/src/features/timeTracking/components/TimerControl.tsx` | The Start/Stop control, shared by the topbar and later by Dashboard zone 3 (create) |
| `src/renderer/src/features/timeTracking/components/TimerControl.test.tsx` | Its test (create) |
| `src/renderer/src/features/timeTracking/components/TimeTrackingView.tsx` | Mount the control in the topbar (modify) |
| `src/renderer/src/features/timeTracking/index.ts` | Export `TimerControl` for PR 2 (modify) |
| `src/renderer/src/shared/ui/app.css` | `ix-timer*` classes (modify) |
| `e2e/timetracking.spec.ts` | Start, stop, relaunch coverage (modify) |

`TimerControl` is a separate component rather than markup inside `TimeTrackingView` because PR 2 mounts the same control in Dashboard zone 3. It reads the store itself so both call sites stay one line.

---

### Task 1: Persist the running timer

**Files:**
- Modify: `src/common/domain.ts` (append near the other time-tracking types, around line 651)
- Modify: `src/core/db/migrations.ts` (append a migration to the `MIGRATIONS` array, after the `version: 21` entry ending near line 550)
- Modify: `src/core/db/timeTrackingRepo.ts` (append after `createTimeOverrideRepo`)
- Test: `src/core/db/timeTrackingRepo.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: `RepoDeps` from `./deps` (`{ now: () => number; newId: () => string }`), `makeTestDb` / `makeTestDeps` from `./testkit`.
- Produces: `RunningTimer` (`@common/domain`); `RunningTimerRepo` with `get(): RunningTimer | null`, `start(startedAt: number, description: string, issueKey: string | null): RunningTimer`, `update(description: string, issueKey: string | null): RunningTimer`, `clear(): void`; the factory `createRunningTimerRepo(db: DatabaseSync, deps: RepoDeps): RunningTimerRepo`.

- [ ] **Step 1: Add the domain type**

In `src/common/domain.ts`, immediately after the `NewManualTimeEntry` / `TimeEntryUpdate` aliases:

```ts
/**
 * The work timer currently running, if any. Elapsed time is deliberately not stored - it is
 * derived from `startedAt` wherever it is shown, so a timer left running across a quit reports
 * the real span rather than a figure frozen at shutdown.
 */
export interface RunningTimer {
  /** Epoch ms the timer was started. */
  startedAt: number
  description: string
  issueKey: string | null
}
```

- [ ] **Step 2: Write the failing repo test**

Append to `src/core/db/timeTrackingRepo.test.ts`. Add `createRunningTimerRepo` and `type RunningTimerRepo` to the existing import from `./timeTrackingRepo`.

```ts
describe('runningTimerRepo', () => {
  let db: DatabaseSync
  let repo: RunningTimerRepo

  beforeEach(() => {
    db = makeTestDb()
    repo = createRunningTimerRepo(db, makeTestDeps())
  })

  test('no timer is running on a fresh database', () => {
    expect(repo.get()).toBeNull()
  })

  test('start stores the timer and get reads it back', () => {
    const started = repo.start(1_700_000_000_000, 'Refactor validators', 'FID2507-611')
    expect(started).toEqual({
      startedAt: 1_700_000_000_000,
      description: 'Refactor validators',
      issueKey: 'FID2507-611'
    })
    expect(repo.get()).toEqual(started)
  })

  test('a timer with no description or issue key round-trips as empty and null', () => {
    const started = repo.start(1_700_000_000_000, '', null)
    expect(started.description).toBe('')
    expect(started.issueKey).toBeNull()
  })

  test('starting while one already runs is refused, leaving the first untouched', () => {
    repo.start(1_700_000_000_000, 'First', null)
    expect(() => repo.start(1_700_000_009_999, 'Second', null)).toThrow(
      'A timer is already running'
    )
    expect(repo.get()?.description).toBe('First')
  })

  test('update replaces both editable fields without moving startedAt', () => {
    repo.start(1_700_000_000_000, 'Rough note', null)
    const updated = repo.update('Refactor validators', 'FID2507-611')
    expect(updated).toEqual({
      startedAt: 1_700_000_000_000,
      description: 'Refactor validators',
      issueKey: 'FID2507-611'
    })
  })

  test('update with no timer running is refused', () => {
    expect(() => repo.update('Anything', null)).toThrow('No timer is running')
  })

  test('clear removes the timer and is safe to call twice', () => {
    repo.start(1_700_000_000_000, 'Refactor validators', null)
    repo.clear()
    expect(repo.get()).toBeNull()
    repo.clear()
    expect(repo.get()).toBeNull()
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/core/db/timeTrackingRepo.test.ts`
Expected: FAIL - `createRunningTimerRepo` is not exported.

- [ ] **Step 4: Add migration v22**

Append to the `MIGRATIONS` array in `src/core/db/migrations.ts`, after the `version: 21` entry:

```ts
  {
    // The work timer. At most one runs at a time, so the row is pinned to id 1 by a CHECK rather
    // than by convention - a second concurrent start then fails at the database instead of
    // silently producing two timers nothing would reconcile. Elapsed time is not a column: it is
    // derived from started_at, so a timer left running across a quit reports the real span.
    version: 22,
    up(db) {
      db.exec(`
        CREATE TABLE running_timer (
          id          INTEGER PRIMARY KEY CHECK (id = 1),
          started_at  INTEGER NOT NULL,
          description TEXT    NOT NULL DEFAULT '',
          issue_key   TEXT,
          created_at  INTEGER NOT NULL
        );
      `)
    }
  }
```

Note the trailing comma on the preceding `version: 21` object - add one if the array previously ended without it.

- [ ] **Step 5: Implement the repo**

Append to `src/core/db/timeTrackingRepo.ts`:

```ts
interface RunningTimerRow {
  started_at: number
  description: string
  issue_key: string | null
}

function toRunningTimer(row: RunningTimerRow): RunningTimer {
  return {
    startedAt: row.started_at,
    description: row.description,
    issueKey: row.issue_key
  }
}

/**
 * The single running work timer. Every method addresses the same pinned row, so there is no id to
 * pass and no ambiguity about which timer is meant.
 */
export interface RunningTimerRepo {
  get(): RunningTimer | null
  /** Begin timing. Refuses when one is already running rather than replacing it silently. */
  start(startedAt: number, description: string, issueKey: string | null): RunningTimer
  /** Overwrite both editable fields. `startedAt` is never editable - it is what was measured. */
  update(description: string, issueKey: string | null): RunningTimer
  /** Stop timing. Idempotent: clearing when nothing runs is not an error. */
  clear(): void
}

export function createRunningTimerRepo(db: DatabaseSync, deps: RepoDeps): RunningTimerRepo {
  const get = (): RunningTimer | null => {
    const row = db.prepare('SELECT * FROM running_timer WHERE id = 1').get() as
      | RunningTimerRow
      | undefined
    return row ? toRunningTimer(row) : null
  }

  return {
    get,

    start(startedAt, description, issueKey) {
      if (get()) throw new Error('A timer is already running')
      db.prepare(
        `INSERT INTO running_timer (id, started_at, description, issue_key, created_at)
         VALUES (1,?,?,?,?)`
      ).run(startedAt, description, issueKey, deps.now())
      return get()!
    },

    update(description, issueKey) {
      if (!get()) throw new Error('No timer is running')
      db.prepare('UPDATE running_timer SET description = ?, issue_key = ? WHERE id = 1').run(
        description,
        issueKey
      )
      return get()!
    },

    clear() {
      db.prepare('DELETE FROM running_timer WHERE id = 1').run()
    }
  }
}
```

Add `RunningTimer` to the existing type-only import at the top of the file:

```ts
import type { NewManualTimeEntry, RunningTimer, TimeEntry, TimeEntryUpdate } from '@common/domain'
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/core/db/timeTrackingRepo.test.ts src/core/db/migrations.test.ts`
Expected: PASS. `migrations.test.ts` asserts `CURRENT_VERSION` is derived from the last entry, so it should follow the bump without edits - if it hardcodes a number, update that number to 22.

- [ ] **Step 7: Commit**

```bash
git add src/common/domain.ts src/core/db/migrations.ts src/core/db/timeTrackingRepo.ts src/core/db/timeTrackingRepo.test.ts
git commit -m "feat(timeTracking): persist the running work timer (#43)"
```

---

### Task 2: Start, stop and update in the service

**Files:**
- Modify: `src/core/timeTracking/timeTracking.ts`
- Test: `src/core/timeTracking/timeTracking.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: `RunningTimerRepo` and `createRunningTimerRepo` from Task 1; the existing `ManualTimeEntryRepo.create`; `dayKeyOf` from `@common/week`.
- Produces: three methods on `TimeTrackingService` - `getRunningTimer(): RunningTimer | null`, `startTimer(description: string, issueKey: string | null): RunningTimer`, `updateTimer(description: string, issueKey: string | null): RunningTimer`, `stopTimer(): TimeEntry | null`. Also a new required dep `timer: RunningTimerRepo` and `now: () => number` on `TimeTrackingDeps`.

Two rules this task locks in, both of which the tests below pin:

1. **A sub-second timer writes nothing.** `assertDuration` rejects a non-positive duration, and a double-clicked Start/Stop is a misclick rather than work. Below one second, stop discards the timer and returns `null`.
2. **A blank description gets a neutral fallback, never blank.** `addManual` requires a description, and an unlabelled row on the board is worse than a plain one. The fallback is the issue key when there is one, otherwise `Timed work`. Both are editable in place afterwards.

- [ ] **Step 1: Write the failing service test**

Append to `src/core/timeTracking/timeTracking.test.ts`. Match the existing file's fake-repo style; if it already has a shared harness for building `TimeTrackingDeps`, extend that instead of duplicating it, and add a `timer` and `now` to it.

```ts
describe('the work timer', () => {
  /** An in-memory stand-in for RunningTimerRepo with the same refusal rules as the real one. */
  function fakeTimerRepo() {
    let current: RunningTimer | null = null
    return {
      get: () => current,
      start(startedAt: number, description: string, issueKey: string | null) {
        if (current) throw new Error('A timer is already running')
        current = { startedAt, description, issueKey }
        return current
      },
      update(description: string, issueKey: string | null) {
        if (!current) throw new Error('No timer is running')
        current = { ...current, description, issueKey }
        return current
      },
      clear() {
        current = null
      }
    }
  }

  /** A service wired to fake repos, with a clock the test advances by hand. */
  function makeService() {
    const created: NewManualTimeEntry[] = []
    let clock = new Date(2026, 6, 28, 10, 0, 0).getTime()
    const timer = fakeTimerRepo()
    const service = createTimeTracking({
      sessions: { list: async () => [], refresh: async () => [] } as unknown as SessionIndex,
      manual: {
        create: (input: NewManualTimeEntry) => {
          created.push(input)
          return { id: 'entry-1', source: 'manual' as const, ...input }
        },
        listByDays: () => [],
        update: () => {
          throw new Error('unused')
        },
        remove: () => {}
      },
      overrides: {
        get: () => undefined,
        listAll: () => [],
        upsert: () => {
          throw new Error('unused')
        },
        pruneAbsent: () => {}
      },
      timer,
      now: () => clock
    })
    return { service, created, timer, advance: (ms: number) => (clock += ms) }
  }

  test('nothing is running before the first start', () => {
    const { service } = makeService()
    expect(service.getRunningTimer()).toBeNull()
  })

  test('start records the clock and the given attribution', () => {
    const { service } = makeService()
    const started = service.startTimer('Refactor validators', 'FID2507-611')
    expect(started.description).toBe('Refactor validators')
    expect(started.issueKey).toBe('FID2507-611')
    expect(service.getRunningTimer()).toEqual(started)
  })

  test('stop writes one entry for the elapsed span and leaves nothing running', () => {
    const { service, created, advance } = makeService()
    service.startTimer('Refactor validators', 'FID2507-611')
    advance(25 * 60_000)
    const entry = service.stopTimer()

    expect(created).toHaveLength(1)
    expect(created[0]).toEqual({
      day: '2026-07-28',
      description: 'Refactor validators',
      issueKey: 'FID2507-611',
      durationMs: 25 * 60_000
    })
    expect(entry?.durationMs).toBe(25 * 60_000)
    expect(service.getRunningTimer()).toBeNull()
  })

  test('a blank description falls back to the issue key rather than logging an unlabelled row', () => {
    const { service, created, advance } = makeService()
    service.startTimer('', 'FID2507-611')
    advance(10 * 60_000)
    service.stopTimer()
    expect(created[0].description).toBe('FID2507-611')
  })

  test('a blank description with no issue key falls back to a neutral label', () => {
    const { service, created, advance } = makeService()
    service.startTimer('', null)
    advance(10 * 60_000)
    service.stopTimer()
    expect(created[0].description).toBe('Timed work')
  })

  test('a sub-second timer is a misclick: nothing is written and nothing keeps running', () => {
    const { service, created, advance } = makeService()
    service.startTimer('Oops', null)
    advance(400)
    expect(service.stopTimer()).toBeNull()
    expect(created).toEqual([])
    expect(service.getRunningTimer()).toBeNull()
  })

  test('stopping when nothing runs is a no-op, not an error', () => {
    const { service, created } = makeService()
    expect(service.stopTimer()).toBeNull()
    expect(created).toEqual([])
  })

  test('a timer running across midnight lands whole on the day it was stopped', () => {
    const { service, created, advance } = makeService()
    service.startTimer('Late night', null)
    advance(17 * 60 * 60_000) // started 2026-07-28 10:00, stopped 2026-07-29 03:00
    service.stopTimer()
    expect(created[0].day).toBe('2026-07-29')
    expect(created[0].durationMs).toBe(17 * 60 * 60_000)
  })

  test('update replaces the attribution of a running timer', () => {
    const { service } = makeService()
    service.startTimer('', null)
    const updated = service.updateTimer('Refactor validators', 'FID2507-611')
    expect(updated.description).toBe('Refactor validators')
    expect(service.getRunningTimer()?.issueKey).toBe('FID2507-611')
  })
})
```

Add the imports this block needs to the top of the file: `RunningTimer`, `NewManualTimeEntry` from `@common/domain`, and `SessionIndex` from `../sessions/sessionIndex` (type-only) if not already imported.

**`TimeTrackingDeps` gains two required fields in Step 3, so every existing `createTimeTracking(...)` call in this test file stops compiling.** Give each of them `timer: fakeTimerRepo()` and `now: () => Date.now()`. Do not make the fields optional to avoid the edit - a service that silently has no timer repo would fail at the first Start rather than at the type check.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/core/timeTracking/timeTracking.test.ts`
Expected: FAIL - `timer`/`now` are not valid `TimeTrackingDeps`, and `startTimer` does not exist.

- [ ] **Step 3: Extend the deps and the service interface**

In `src/core/timeTracking/timeTracking.ts`:

```ts
export interface TimeTrackingDeps {
  /** The app-wide session index instance - the same one the Sessions slice reads. */
  sessions: SessionIndex
  manual: ManualTimeEntryRepo
  overrides: TimeOverrideRepo
  timer: RunningTimerRepo
  /** Injected so timer tests can advance the clock instead of sleeping. */
  now: () => number
}
```

Add to the `TimeTrackingService` interface:

```ts
  /** The timer currently running, or null. */
  getRunningTimer(): RunningTimer | null
  /** Begin timing now. Refuses when one is already running. */
  startTimer(description: string, issueKey: string | null): RunningTimer
  /** Re-attribute a running timer without disturbing what it has measured. */
  updateTimer(description: string, issueKey: string | null): RunningTimer
  /**
   * Stop timing and log the elapsed span as a manual entry on the day it was stopped. Returns
   * null when nothing was running, or when the span was too short to be real work.
   */
  stopTimer(): TimeEntry | null
```

Update the imports at the top:

```ts
import type {
  NewManualTimeEntry,
  RunningTimer,
  TimeEntry,
  TimeEntrySource,
  TimeEntryUpdate
} from '@common/domain'
import type {
  ManualTimeEntryRepo,
  RunningTimerRepo,
  TimeOverrideRepo
} from '../db/timeTrackingRepo'
```

- [ ] **Step 4: Implement the four methods**

Add above `export function createTimeTracking`:

```ts
/**
 * Below this, a start followed immediately by a stop is a misclick rather than work. Logging it
 * would put a zero-length row on the board for the user to hunt down and delete.
 */
const MIN_TIMED_MS = 1_000

/** A row is never logged unlabelled: the issue key stands in, and failing that a neutral label. */
function timedDescription(description: string, issueKey: string | null): string {
  const trimmed = description.trim()
  if (trimmed) return trimmed
  return issueKey ?? 'Timed work'
}
```

Add to the returned object in `createTimeTracking`:

```ts
    getRunningTimer() {
      return deps.timer.get()
    },

    startTimer(description, issueKey) {
      return deps.timer.start(deps.now(), description, issueKey)
    },

    updateTimer(description, issueKey) {
      return deps.timer.update(description, issueKey)
    },

    stopTimer() {
      const running = deps.timer.get()
      if (!running) return null
      // One reading of the clock for both the span and the day, so they can never disagree.
      const stoppedAt = deps.now()
      const durationMs = stoppedAt - running.startedAt
      deps.timer.clear()
      if (durationMs < MIN_TIMED_MS) return null
      // Attributed to the day it was stopped, so a span crossing midnight lands on one day rather
      // than being split across two - the same whole-session rule the auto entries follow.
      return deps.manual.create({
        day: dayKeyOf(stoppedAt),
        description: timedDescription(running.description, running.issueKey),
        issueKey: running.issueKey,
        durationMs
      })
    }
```

`dayKeyOf` is already imported in this file.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/core/timeTracking/`
Expected: PASS, including the pre-existing week/override tests.

- [ ] **Step 6: Wire the repo in bootstrap**

In `src/core/bootstrap.ts`, add `createRunningTimerRepo` to the existing import from `./db/timeTrackingRepo` (line ~79) and extend the service construction near line 525:

```ts
    service: createTimeTracking({
      sessions: sessionIndex,
      manual: createManualTimeEntryRepo(db, repoDeps),
      overrides: createTimeOverrideRepo(db, repoDeps),
      timer: createRunningTimerRepo(db, repoDeps),
      now: () => Date.now()
    })
```

Keep the existing `sessions:` argument exactly as it already reads - do not rename the variable it passes.

- [ ] **Step 7: Verify the core typechecks**

Run: `npm run typecheck:node`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/core/timeTracking/timeTracking.ts src/core/timeTracking/timeTracking.test.ts src/core/bootstrap.ts
git commit -m "feat(timeTracking): start, stop and re-attribute the work timer (#43)"
```

---

### Task 3: Expose the timer over IPC

**Files:**
- Modify: `src/common/ipc.ts`
- Modify: `src/core/api/timeTracking.ipc.ts`
- Create: `src/core/api/timeTracking.ipc.test.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/features/timeTracking/ipc.ts`

**Interfaces:**
- Consumes: the four service methods from Task 2.
- Produces: `ipc().timeTracking.getTimer()`, `.startTimer(description, issueKey)`, `.updateTimer(description, issueKey)`, `.stopTimer()`; and the renderer seam exports `getTimer`, `startTimer`, `updateTimer`, `stopTimer` from `features/timeTracking/ipc.ts`.

- [ ] **Step 1: Add the channels and the API methods**

In `src/common/ipc.ts`, extend the timeTracking channel block (line ~570):

```ts
  timeTrackingGetTimer: 'timeTracking:getTimer',
  timeTrackingStartTimer: 'timeTracking:startTimer',
  timeTrackingUpdateTimer: 'timeTracking:updateTimer',
  timeTrackingStopTimer: 'timeTracking:stopTimer',
```

And extend the `timeTracking` block of `IpcApi` (line ~251):

```ts
    /** The work timer currently running, or null. Read once at boot; there is no push channel. */
    getTimer(): Promise<RunningTimer | null>
    /** Begin timing now. Rejects when a timer is already running. */
    startTimer(description: string, issueKey: string | null): Promise<RunningTimer>
    /** Re-attribute a running timer without disturbing what it has measured. */
    updateTimer(description: string, issueKey: string | null): Promise<RunningTimer>
    /** Stop timing and log the span. Resolves null when nothing ran, or the span was too short. */
    stopTimer(): Promise<TimeEntry | null>
```

Add `RunningTimer` to the `@common/domain` type import at the top of `ipc.ts`.

- [ ] **Step 2: Write the failing handler test**

Create `src/core/api/timeTracking.ipc.test.ts`, following the shape of the sibling `*.ipc.test.ts` files:

```ts
import { describe, expect, test, vi } from 'vitest'
import type { RunningTimer, TimeEntry } from '@common/domain'
import type { TimeTrackingService } from '../timeTracking/timeTracking'
import { createTimeTrackingHandlers } from './timeTracking.ipc'

const TIMER: RunningTimer = {
  startedAt: 1_700_000_000_000,
  description: 'Refactor validators',
  issueKey: 'FID2507-611'
}

const ENTRY: TimeEntry = {
  id: 'entry-1',
  source: 'manual',
  day: '2026-07-28',
  description: 'Refactor validators',
  issueKey: 'FID2507-611',
  durationMs: 25 * 60_000
}

function handlers(over: Partial<TimeTrackingService> = {}) {
  const service = {
    getWeek: vi.fn(),
    refreshWeek: vi.fn(),
    addManual: vi.fn(),
    updateEntry: vi.fn(),
    deleteEntry: vi.fn(),
    getRunningTimer: vi.fn(() => TIMER),
    startTimer: vi.fn(() => TIMER),
    updateTimer: vi.fn(() => TIMER),
    stopTimer: vi.fn(() => ENTRY),
    ...over
  } as unknown as TimeTrackingService
  return { service, api: createTimeTrackingHandlers({ service }) }
}

describe('timeTracking timer handlers', () => {
  test('getTimer returns what the service holds', async () => {
    const { api } = handlers()
    await expect(api.getTimer()).resolves.toEqual(TIMER)
  })

  test('startTimer forwards the description and issue key', async () => {
    const { api, service } = handlers()
    await api.startTimer('Refactor validators', 'FID2507-611')
    expect(service.startTimer).toHaveBeenCalledWith('Refactor validators', 'FID2507-611')
  })

  test('updateTimer forwards both fields', async () => {
    const { api, service } = handlers()
    await api.updateTimer('Renamed', null)
    expect(service.updateTimer).toHaveBeenCalledWith('Renamed', null)
  })

  test('stopTimer returns the logged entry', async () => {
    const { api } = handlers()
    await expect(api.stopTimer()).resolves.toEqual(ENTRY)
  })

  test('a service failure crosses the boundary as a message-only Error', async () => {
    const { api } = handlers({
      startTimer: vi.fn(() => {
        throw new Error('A timer is already running')
      })
    })
    await expect(api.startTimer('x', null)).rejects.toThrow('A timer is already running')
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/core/api/timeTracking.ipc.test.ts`
Expected: FAIL - `api.getTimer` is not a function.

- [ ] **Step 4: Add the handlers and wire routes**

In `src/core/api/timeTracking.ipc.ts`, extend the returned object:

```ts
    getTimer: () => surface(async () => deps.service.getRunningTimer()),
    startTimer: (description, issueKey) =>
      surface(async () => deps.service.startTimer(description, issueKey)),
    updateTimer: (description, issueKey) =>
      surface(async () => deps.service.updateTimer(description, issueKey)),
    stopTimer: () => surface(async () => deps.service.stopTimer())
```

And the wire routes:

```ts
    [Channel.timeTrackingGetTimer]: h.getTimer,
    [Channel.timeTrackingStartTimer]: h.startTimer,
    [Channel.timeTrackingUpdateTimer]: h.updateTimer,
    [Channel.timeTrackingStopTimer]: h.stopTimer
```

- [ ] **Step 5: Bridge them in preload**

In `src/preload/index.ts`, extend the `timeTracking` block:

```ts
    getTimer: () => ipcRenderer.invoke(Channel.timeTrackingGetTimer),
    startTimer: (description, issueKey) =>
      ipcRenderer.invoke(Channel.timeTrackingStartTimer, description, issueKey),
    updateTimer: (description, issueKey) =>
      ipcRenderer.invoke(Channel.timeTrackingUpdateTimer, description, issueKey),
    stopTimer: () => ipcRenderer.invoke(Channel.timeTrackingStopTimer)
```

- [ ] **Step 6: Add the renderer seam**

Append to `src/renderer/src/features/timeTracking/ipc.ts`, adding `RunningTimer` to its `@common/domain` type import:

```ts
export const getTimer = (): Promise<RunningTimer | null> => ipc().timeTracking.getTimer()
export const startTimer = (description: string, issueKey: string | null): Promise<RunningTimer> =>
  ipc().timeTracking.startTimer(description, issueKey)
export const updateTimer = (description: string, issueKey: string | null): Promise<RunningTimer> =>
  ipc().timeTracking.updateTimer(description, issueKey)
export const stopTimer = (): Promise<TimeEntry | null> => ipc().timeTracking.stopTimer()
```

- [ ] **Step 7: Run the tests and both typechecks**

Run: `npx vitest run src/core/api/timeTracking.ipc.test.ts && npm run typecheck`
Expected: PASS and clean. The typecheck is what proves the preload bridge and the `IpcApi` contract agree.

- [ ] **Step 8: Commit**

```bash
git add src/common/ipc.ts src/core/api/timeTracking.ipc.ts src/core/api/timeTracking.ipc.test.ts src/preload/index.ts src/renderer/src/features/timeTracking/ipc.ts
git commit -m "feat(timeTracking): expose the work timer over IPC (#43)"
```

---

### Task 4: Hold the timer in the renderer store

**Files:**
- Modify: `src/renderer/src/features/timeTracking/store.ts`
- Test: `src/renderer/src/features/timeTracking/store.test.ts` (create if absent, else append)

**Interfaces:**
- Consumes: `getTimer`, `startTimer`, `updateTimer`, `stopTimer` from `./ipc` (Task 3).
- Produces: on `useTimeTrackingStore` - state field `timer: RunningTimer | null`, and actions `startTimer(description: string, issueKey: string | null): Promise<void>`, `updateTimer(description: string, issueKey: string | null): Promise<void>`, `stopTimer(): Promise<void>`. `hydrate()` and `refresh()` also load the timer.

`timer` holds the object the IPC returned, unchanged, so reading `s.timer` is a stable reference and needs no `useShallow`.

- [ ] **Step 1: Write the failing store test**

Create `src/renderer/src/features/timeTracking/store.test.ts` (if the file exists, append the `describe` and merge the mock setup):

```ts
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { RunningTimer } from '@common/domain'
import { useTimeTrackingStore } from './store'

vi.mock('./ipc')
import * as api from './ipc'

const mocked = vi.mocked(api)

const TIMER: RunningTimer = {
  startedAt: 1_700_000_000_000,
  description: 'Refactor validators',
  issueKey: 'FID2507-611'
}

const reset = (): void => {
  useTimeTrackingStore.setState(
    {
      status: 'idle',
      error: null,
      weekStart: '2026-07-27',
      entries: [],
      timer: null
    },
    false
  )
}

describe('the work timer in the store', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocked.getWeek.mockResolvedValue([])
    mocked.getTimer.mockResolvedValue(null)
    reset()
  })

  test('hydrate loads whatever timer the core already has running', async () => {
    mocked.getTimer.mockResolvedValue(TIMER)
    await useTimeTrackingStore.getState().hydrate()
    expect(useTimeTrackingStore.getState().timer).toEqual(TIMER)
  })

  test('start puts the returned timer in state', async () => {
    mocked.startTimer.mockResolvedValue(TIMER)
    await useTimeTrackingStore.getState().startTimer('Refactor validators', 'FID2507-611')
    expect(mocked.startTimer).toHaveBeenCalledWith('Refactor validators', 'FID2507-611')
    expect(useTimeTrackingStore.getState().timer).toEqual(TIMER)
  })

  test('stop clears the timer and re-reads the week so the new entry appears', async () => {
    useTimeTrackingStore.setState({ timer: TIMER })
    mocked.stopTimer.mockResolvedValue(null)
    await useTimeTrackingStore.getState().stopTimer()
    expect(useTimeTrackingStore.getState().timer).toBeNull()
    expect(mocked.getWeek).toHaveBeenCalled()
  })

  test('a failed start leaves nothing running rather than a phantom timer', async () => {
    mocked.startTimer.mockRejectedValue(new Error('A timer is already running'))
    await useTimeTrackingStore.getState().startTimer('Second', null)
    expect(useTimeTrackingStore.getState().timer).toBeNull()
  })

  test('update replaces the attribution in state', async () => {
    useTimeTrackingStore.setState({ timer: { ...TIMER, description: '', issueKey: null } })
    mocked.updateTimer.mockResolvedValue(TIMER)
    await useTimeTrackingStore.getState().updateTimer('Refactor validators', 'FID2507-611')
    expect(useTimeTrackingStore.getState().timer).toEqual(TIMER)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/src/features/timeTracking/store.test.ts`
Expected: FAIL - `startTimer` is not a function on the store.

- [ ] **Step 3: Add the state and actions**

In `src/renderer/src/features/timeTracking/store.ts`, add `RunningTimer` to the `@common/domain` type import, then extend the interface:

```ts
  /** The work timer currently running, or null. Elapsed time is derived from it, never stored. */
  timer: RunningTimer | null
  startTimer(description: string, issueKey: string | null): Promise<void>
  updateTimer(description: string, issueKey: string | null): Promise<void>
  /** Stop and log the span, then re-read the week so the new entry is on the board. */
  stopTimer(): Promise<void>
```

Add `timer: null` to the initial state beside `entries: []`.

Add a loader beside the existing `reload`:

```ts
  /** Read the running timer from the core. A failure leaves the last known value alone. */
  async function loadTimer(): Promise<void> {
    try {
      set({ timer: await api.getTimer() })
    } catch {
      // The board is still usable without the timer; a toast here would fire on every reload.
    }
  }
```

Call `await loadTimer()` at the end of `hydrate()` and of `refresh()`.

Add the three actions to the returned object:

```ts
    async startTimer(description, issueKey) {
      try {
        set({ timer: await api.startTimer(description, issueKey) })
      } catch (e) {
        reportError('Could not start the timer', e)
      }
    },

    async updateTimer(description, issueKey) {
      try {
        set({ timer: await api.updateTimer(description, issueKey) })
      } catch (e) {
        reportError('Could not change what the timer is tracking', e)
      }
    },

    async stopTimer() {
      try {
        await api.stopTimer()
        set({ timer: null })
      } catch (e) {
        reportError('Could not stop the timer', e)
        await loadTimer()
        return
      }
      await reload()
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/renderer/src/features/timeTracking/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/timeTracking/store.ts src/renderer/src/features/timeTracking/store.test.ts
git commit -m "feat(timeTracking): hold the running timer in the renderer store (#43)"
```

---

### Task 5: A shared ticking clock

**Files:**
- Create: `src/renderer/src/shared/ui/useNow.ts`
- Test: `src/renderer/src/shared/ui/useNow.test.tsx`

**Interfaces:**
- Produces: `useNow(intervalMs: number | null): number` - the current epoch ms, re-rendering the caller on each interval. `null` stops the ticking, so a component pays nothing while there is nothing live to show.

The repo already carries two ad-hoc copies of this `setInterval` pattern (`MyWorkView.tsx:181` and the prInbox card ages). PR 2 needs three cadences from it, including the day key so an app left open overnight rolls over.

- [ ] **Step 1: Write the failing test**

```tsx
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useNow } from './useNow'

function Probe({ intervalMs }: { intervalMs: number | null }) {
  return <span data-testid="now">{useNow(intervalMs)}</span>
}

const shown = (): string => document.querySelector('[data-testid="now"]')?.textContent ?? ''

describe('useNow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 28, 10, 0, 0))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('starts at the current time', () => {
    render(<Probe intervalMs={1000} />)
    expect(shown()).toBe(String(Date.now()))
  })

  test('advances on each interval', () => {
    render(<Probe intervalMs={1000} />)
    const first = shown()
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(Number(shown())).toBe(Number(first) + 3000)
  })

  test('a null interval never ticks, so an idle caller pays nothing', () => {
    render(<Probe intervalMs={null} />)
    const first = shown()
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(shown()).toBe(first)
  })

  test('unmounting clears the interval', () => {
    const clear = vi.spyOn(globalThis, 'clearInterval')
    const view = render(<Probe intervalMs={1000} />)
    view.unmount()
    expect(clear).toHaveBeenCalled()
    clear.mockRestore()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/src/shared/ui/useNow.test.tsx`
Expected: FAIL - cannot resolve `./useNow`.

- [ ] **Step 3: Implement the hook**

```ts
import { useEffect, useState } from 'react'

/**
 * The current epoch ms, re-rendering the caller every `intervalMs`. Pass null to stop ticking -
 * a view with nothing live on screen should not be re-rendering on a timer.
 *
 * Anything shown as an age, an elapsed span or today's date needs this: read once at render, such
 * a value is correct at mount and quietly wrong from then on, and a day key derived from a frozen
 * clock keeps attributing work to yesterday after midnight.
 */
export function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (intervalMs === null) return
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])

  return now
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/src/shared/ui/useNow.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/shared/ui/useNow.ts src/renderer/src/shared/ui/useNow.test.tsx
git commit -m "feat(renderer): a shared ticking clock for ages and elapsed spans (#43)"
```

---

### Task 6: The Start/Stop control

**Files:**
- Create: `src/renderer/src/features/timeTracking/components/TimerControl.tsx`
- Test: `src/renderer/src/features/timeTracking/components/TimerControl.test.tsx`
- Modify: `src/renderer/src/features/timeTracking/components/TimeTrackingView.tsx`
- Modify: `src/renderer/src/features/timeTracking/index.ts`
- Modify: `src/renderer/src/shared/ui/app.css`

**Interfaces:**
- Consumes: `useTimeTrackingStore` with `timer`, `startTimer`, `stopTimer`, `updateTimer` (Task 4); `useNow` (Task 5); `formatDuration` from `@renderer/features/sessions`.
- Produces: `<TimerControl />`, exported from the timeTracking barrel for PR 2's Dashboard zone 3.

The elapsed figure ticks once a second only while something runs; otherwise `useNow(null)` and the component is inert.

- [ ] **Step 1: Write the failing component test**

```tsx
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { RunningTimer } from '@common/domain'
import { useTimeTrackingStore } from '../store'
import { TimerControl } from './TimerControl'

vi.mock('../ipc')
import * as api from '../ipc'

const mocked = vi.mocked(api)

const TIMER: RunningTimer = {
  startedAt: new Date(2026, 6, 28, 9, 35, 0).getTime(),
  description: 'Refactor validators',
  issueKey: 'FID2507-611'
}

const text = (selector: string): string =>
  document.querySelector(selector)?.textContent?.trim() ?? ''

/**
 * Mounted client-side rather than as static markup: the control subscribes to the store, and only
 * a real root can expose a re-render loop from an unstable selector.
 */
describe('TimerControl', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocked.getWeek.mockResolvedValue([])
    mocked.getTimer.mockResolvedValue(null)
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 28, 10, 0, 0))
    useTimeTrackingStore.setState({ timer: null })
  })

  afterEach(() => {
    vi.useRealTimers()
    useTimeTrackingStore.setState({ timer: null })
  })

  test('offers a single Start when nothing runs, and settles without a render loop', async () => {
    const logged: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
    })
    try {
      await act(async () => {
        render(<TimerControl />)
      })
      expect(logged).toEqual([])
      expect(text('.ix-timer__action')).toBe('Start')
      expect(document.querySelector('.ix-timer__elapsed')).toBeNull()
    } finally {
      consoleError.mockRestore()
    }
  })

  test('shows the elapsed span and the attribution while running', async () => {
    useTimeTrackingStore.setState({ timer: TIMER })
    await act(async () => {
      render(<TimerControl />)
    })
    expect(text('.ix-timer__elapsed')).toBe('25m')
    expect(text('.ix-timer__what')).toContain('Refactor validators')
    expect(text('.ix-timer__what')).toContain('FID2507-611')
    expect(text('.ix-timer__action')).toBe('Stop')
  })

  test('the elapsed span advances while it runs', async () => {
    useTimeTrackingStore.setState({ timer: TIMER })
    await act(async () => {
      render(<TimerControl />)
    })
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(text('.ix-timer__elapsed')).toBe('26m')
  })

  test('Start asks the store to start an unattributed timer', async () => {
    mocked.startTimer.mockResolvedValue(TIMER)
    await act(async () => {
      render(<TimerControl />)
    })
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.ix-timer__action')?.click()
    })
    expect(mocked.startTimer).toHaveBeenCalledWith('', null)
  })

  test('Stop asks the store to stop', async () => {
    useTimeTrackingStore.setState({ timer: TIMER })
    mocked.stopTimer.mockResolvedValue(null)
    await act(async () => {
      render(<TimerControl />)
    })
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.ix-timer__action')?.click()
    })
    expect(mocked.stopTimer).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/src/features/timeTracking/components/TimerControl.test.tsx`
Expected: FAIL - cannot resolve `./TimerControl`.

- [ ] **Step 3: Implement the control**

```tsx
import { formatDuration } from '@renderer/features/sessions'
import { useNow } from '@renderer/shared/ui/useNow'
import { useTimeTrackingStore } from '../store'

/**
 * Start/Stop for the work timer, with the elapsed span while one runs. Mounted both in the Time
 * Tracking topbar and in the Dashboard's time zone, so it reads the store itself rather than
 * taking the timer as a prop.
 *
 * Start is deliberately one click with nothing to fill in first - the description and issue key
 * are editable while it runs and on the entry afterwards, so recording the time never waits on
 * deciding what to call it.
 */
export function TimerControl() {
  const timer = useTimeTrackingStore((s) => s.timer)
  // Nothing on screen changes by itself while idle, so the clock stops with the timer.
  const now = useNow(timer ? 1000 : null)

  if (!timer) {
    return (
      <div className="ix-timer">
        <button
          type="button"
          className="ix-btn ix-btn--primary ix-timer__action"
          onClick={() => void useTimeTrackingStore.getState().startTimer('', null)}
        >
          Start
        </button>
      </div>
    )
  }

  const what = [timer.description.trim(), timer.issueKey].filter(Boolean).join(' · ')

  return (
    <div className="ix-timer ix-timer--running">
      <span className="ix-timer__elapsed">
        {formatDuration(Math.max(0, now - timer.startedAt))}
      </span>
      {what && <span className="ix-timer__what">{what}</span>}
      <button
        type="button"
        className="ix-btn ix-btn--primary ix-timer__action"
        onClick={() => void useTimeTrackingStore.getState().stopTimer()}
      >
        Stop
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Add the styles**

Append a new banner section to `src/renderer/src/shared/ui/app.css`:

```css
/* ---------------- time tracking: the work timer ---------------- */
.ix-timer {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.ix-timer__elapsed {
  font-family: var(--font-mono);
  font-size: 15px;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.ix-timer__what {
  font-size: 12px;
  color: var(--text-faint);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

`font-variant-numeric: tabular-nums` keeps the figure from jittering as digits change each second.

- [ ] **Step 5: Mount it in the topbar**

In `TimeTrackingView.tsx`, import it (`import { TimerControl } from './TimerControl'`) and place it in the topbar immediately before the total, so the running timer sits beside the number it will change:

```tsx
          <TimerControl />
          <span className="ix-tt__total">{formatTotal(totalMs(entries))} total</span>
```

- [ ] **Step 6: Export it from the barrel**

Append to `src/renderer/src/features/timeTracking/index.ts`:

```ts
export { TimerControl } from './components/TimerControl'
```

- [ ] **Step 7: Run the tests and the web typecheck**

Run: `npx vitest run src/renderer/src/features/timeTracking/ && npm run typecheck:web`
Expected: PASS and clean.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/features/timeTracking/components/TimerControl.tsx src/renderer/src/features/timeTracking/components/TimerControl.test.tsx src/renderer/src/features/timeTracking/components/TimeTrackingView.tsx src/renderer/src/features/timeTracking/index.ts src/renderer/src/shared/ui/app.css
git commit -m "feat(timeTracking): Start/Stop the work timer from the topbar (#43)"
```

---

### Task 7: Prove it survives a relaunch

**Files:**
- Modify: `e2e/timetracking.spec.ts`

**Interfaces:**
- Consumes: `launch`, `openRailSection`, `tempDir`, `userDataDir`, `test`, `expect` from `./harness` - all already imported by this spec.

This is the test that justifies the whole schema. A renderer-only timer would pass every unit test in this plan and fail here.

- [ ] **Step 1: Write the failing e2e test**

Append to `e2e/timetracking.spec.ts`:

```ts
test('the work timer logs an entry on stop and keeps running across a relaunch', async () => {
  const profileDir = userDataDir()

  const first = await launch(profileDir, {
    env: { INTERSECT_CLAUDE_PROJECTS_DIR: tempDir('intersect-empty-projects-') }
  })
  await openRailSection(first.win, 'Time Tracking', '.ix-tt')

  // Nothing has been started, so the control offers exactly one action.
  await expect(first.win.locator('.ix-timer__action')).toHaveText('Start')
  await first.win.locator('.ix-timer__action').click()
  await expect(first.win.locator('.ix-timer__action')).toHaveText('Stop')
  await expect(first.win.locator('.ix-timer__elapsed')).toBeVisible()
  await first.app.close()

  // The timer is durable state, not renderer state: it is still running after a full restart.
  const second = await launch(profileDir, {
    env: { INTERSECT_CLAUDE_PROJECTS_DIR: tempDir('intersect-empty-projects-') }
  })
  await openRailSection(second.win, 'Time Tracking', '.ix-tt')
  await expect(second.win.locator('.ix-timer__action')).toHaveText('Stop')

  await second.win.locator('.ix-timer__action').click()
  await expect(second.win.locator('.ix-timer__action')).toHaveText('Start')
  // Stopping logged the span as an ordinary card on today's column, editable like any other.
  await expect(second.win.locator('.ix-entry', { hasText: 'Timed work' })).toHaveCount(1)
  await second.app.close()
})
```

If this spec's existing tests use a different card selector than `.ix-entry`, use theirs - check what the neighbouring assertions query before running.

- [ ] **Step 2: Build and run the spec**

Run: `npm run build && npx playwright test e2e/timetracking.spec.ts`
Expected: the new test FAILS first if the build predates Task 6; after a rebuild it PASSES. The relaunch assertion is the one that matters - if it fails, the timer is not actually persisted.

Note the elapsed span between the two clicks will be several seconds of real time, comfortably above the one-second floor from Task 2.

- [ ] **Step 3: Run the full gate**

Run: `npm run typecheck && npm test && npm run lint && npm run e2e`
Expected: all clean. This is exactly what CI runs.

- [ ] **Step 4: Commit**

```bash
git add e2e/timetracking.spec.ts
git commit -m "test(e2e): the work timer survives a relaunch and logs on stop (#43)"
```

---

## Notes for PR 2

- `TimerControl` is exported from the timeTracking barrel and drops straight into Dashboard zone 3.
- The spec's decision that Start prefills the issue key from the selected workspace's git branch is **not** in this PR. `startTimer(description, issueKey)` already accepts the key, so PR 2 supplies it without changing this contract. The branch itself is not currently readable for an arbitrary workspace folder - `WorktreeInfo.branch` exists but only via the project-scoped `projects.listWorktrees`, so PR 2 needs either a small "branch of this folder" seam over `gitRaw(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])` (`src/core/prInbox/git.ts:7`) or to reuse the worktrees listing. Zone 3 works without it; the key is an enhancement, not a dependency.
- `useNow` is the clock for zone 3's elapsed figure, zone 1 and zone 4's relative ages, and the day key that must roll over at midnight.
