# Jarvis - Design (MVP: Workspace & Terminal Manager)

Clean-room React/Electron implementation inspired by strIDEterm's UX. Scope: workspaces
+ terminal tabs + split layouts + local persistence. Everything else in `PROMPT.md` non-goals
is explicitly out.

This document is the contract for implementation and review. Decisions below are grounded in
research captured on 2026-07-05 (see "Research basis").

---

## 1. Tech stack (pinned, research-verified)

| Concern | Choice | Version | Notes |
|---|---|---|---|
| Shell/framework | Electron | `^43.0.0` | bundles Node 24.17.0, ABI 148, Chromium 150 |
| Build/dev | electron-vite | `^5.0.0` | auto-externalizes main/preload deps (native modules), HMR |
| Bundler | Vite | `^7.2.6` | electron-vite 5 peer tops at vite 7 (do not jump to 8) |
| UI | React + ReactDOM | `^19.2.x` | |
| Language | TypeScript | `~5.9.x` | not TS 6 (electron-toolkit validated on 5.9) |
| State | Zustand | `^5.0.x` | one store per feature slice (see §8) |
| Terminal render | @xterm/xterm | `^6.0.0` | scoped pkg; old `xterm` deprecated; no canvas addon in v6 |
| Terminal fit | @xterm/addon-fit | `^0.11.0` | |
| Terminal links | @xterm/addon-web-links | `^0.12.0` | clickable URLs (small polish) |
| PTY | node-pty | `^1.1.0` | **only native module**; rebuilt for Electron ABI |
| Persistence | **node:sqlite** (built-in) | Node 24.17 / 25.9 | `DatabaseSync`; unflagged; FK on by default |
| Unit tests | Vitest | `^4.x` | node env (main/db/logic) + jsdom env (renderer) |
| E2E | @playwright/test | `^1.61.x` | built-in `_electron` launcher |
| Native rebuild | @electron/rebuild | `^4.1.0` | postinstall, targets node-pty only |

### 1.1 Why node:sqlite instead of better-sqlite3 (key decision)

- `better-sqlite3` is a native addon: it must be compiled against **one** ABI. Rebuilt for
  Electron (ABI 148) it will not load under Vitest running on host Node (different ABI), and
  vice-versa. That directly undermines the PROMPT's requirement to unit-test DB persistence
  logic. Maintaining two build states is a standing papercut.
- `node:sqlite` (`DatabaseSync`) is compiled into the runtime itself, so the **same code runs
  under Electron main (Node 24.17) and Vitest (host Node 25.9) with no rebuild**. Verified on
  host: available without any flag, `PRAGMA foreign_keys` defaults ON, `PRAGMA user_version`
  works.
- Trade-off accepted: `node:sqlite` is Stability 1.2 (Release Candidate). For a personal,
  single-user MVP this is acceptable, and the API surface we use (exec/prepare/run/get/all,
  pragmas) is stable. If it ever regresses, the repository layer (§5) is the only code that
  touches it and is swappable.
- `node:sqlite` has no `db.transaction()` helper (unlike better-sqlite3). We provide a small
  `tx(db, fn)` helper using `BEGIN`/`COMMIT`/`ROLLBACK`.

### 1.2 Native module discipline (node-pty)

- `node-pty` stays in `dependencies` (never dev) and is auto-externalized by electron-vite v5
  for the main build (a `.node` addon must never be bundled by Rollup).
- **No `@electron/rebuild` step is needed.** node-pty 1.1.0 ships **N-API prebuilds**
  (`prebuilds/darwin-arm64/pty.node` + `spawn-helper`). N-API is ABI-stable across Node and
  Electron; empirically the same binary loaded under host Node 25 AND Electron 43's Node 24.17,
  and spawned a live shell. This removes the entire native-rebuild class of problems.
- **Exec-bit fix (required):** the packaged `spawn-helper` arrives without the execute bit on a
  clean `npm install` (`-rw-r--r--`), so `posix_spawnp` fails. Main-process startup calls
  `ensureSpawnHelperExecutable()` (`fs.chmodSync(helper, 0o755)`) before any spawn. Portable,
  survives reinstall, no shell step. Verified: with the bit set, spawn succeeds and streams data.
- `node-pty` is imported **only** in `src/main/**`. It is never imported by renderer or by any
  Vitest test, so unit tests never touch it. PTY behavior is verified via Playwright E2E.
- macOS `spawn-helper` also needs asarUnpack for a *packaged* build - out of scope for this
  MVP's dev-run goal, noted for the future.

---

## 2. Process & module architecture

We use electron-vite's standard three-target layout (`src/main`, `src/preload`,
`src/renderer`). This is the 2026 convention the PROMPT asks us to follow. The PROMPT's
illustrative tree (`electron/main.ts`, `electron/ipc/`, `src/features/*`) is honored **in
principle**: renderer is organized by vertical slice, main has one IPC module per slice, DB is
isolated, shared is small. Only the top-level folder names follow the tool's convention.

```
jarvis/
  electron.vite.config.ts
  package.json  tsconfig.json  tsconfig.node.json  tsconfig.web.json
  vitest.config.ts  playwright.config.ts
  src/
    shared/                      # cross-PROCESS contracts (main <-> preload <-> renderer)
      ipc.ts                     # IpcApi interface + channel name constants (single source of truth)
      domain.ts                  # Workspace, Tab, Layout, PaneAssignment domain types
    main/
      index.ts                   # app lifecycle, window, wires ipc + db + pty; quit teardown
      db/
        connection.ts            # openDatabase(userDataDir): DatabaseSync + pragmas
        migrations.ts            # PRAGMA user_version runner + ordered migration list
        workspaceRepo.ts         # workspace CRUD + layout persistence (pure over a db handle)
        tabRepo.ts               # tab CRUD + reorder + pane assignment
        appStateRepo.ts          # kv: selected_workspace_id
      ipc/
        workspaces.ipc.ts        # registers ipcMain.handle for workspaces.* (delegates to repos)
        tabs.ipc.ts              # tabs.* handlers
        terminal.ipc.ts          # terminal spawn/write/resize/kill + data broadcast (node-pty)
      pty/
        sessionManager.ts        # Map<sessionId, IPty>; spawn/write/resize/kill/killAll; onExit cleanup
        shell.ts                 # resolveShell(), buildSpawn(preset, cwd) -> {file,args,initialCommand}
    preload/
      index.ts                   # contextBridge.exposeInMainWorld('jarvis', typed api)
      index.d.ts                 # declare global Window.jarvis: IpcApi
    renderer/
      index.html
      src/
        main.tsx                 # createRoot; runs registerFeatures() then render; kicks hydration
        app/
          App.tsx                # shell layout: <Sidebar/> + <WorkspaceView/>
          Sidebar.tsx            # renders getSidebarSections()
          registerFeatures.ts    # imports + calls each feature's register() (the one coupling point)
          hydrateStores.ts       # Promise.all of each store.hydrate()
        shared/
          registries/
            sidebarRegistry.ts   # ordered array + register/getAll/reset
            commandRegistry.ts   # Map + register/get/getAll/reset
          ipc/client.ts          # thin typed wrapper around window.jarvis
          ui/                    # small UI kit (Button, Dialog, ContextMenu, Icon, ...) - kept minimal
          layout/geometry.ts     # LAYOUTS table: slot counts + css grid templates (pure)
        features/
          workspaces/
            index.ts             # public barrel (store hook + types only)
            register.ts          # side-effect: registerSidebarSection + registerCommand
            store.ts             # useWorkspacesStore (hydrate + CRUD write-through)
            ipc.ts               # thin fns over shared/ipc/client (mockable seam)
            components/          # WorkspaceList, WorkspaceItem, WorkspaceDialog, folder picker btn
            __tests__/
          tabs/
            index.ts  register.ts  store.ts  ipc.ts  components/ (TabBar, TabItem, PresetPicker) __tests__/
          terminal/
            index.ts  register.ts  store.ts  ipc.ts
            terminalController.ts  # imperative Map<sessionId,{term,fit,mount}> OUTSIDE React
            components/          # TerminalPane, SplitStage, LayoutPicker
            __tests__/
  e2e/                           # Playwright _electron specs
```

**Isolation rule (enforced, not just convention):** ESLint `no-restricted-imports` blocks any
import of `features/<x>/**` except `features/<x>/index.ts` from outside that slice.
`src/shared/**` may be imported anywhere. `main/**` and `renderer/**` never import each other.

---

## 3. IPC contract design

Single source of truth: `src/shared/ipc.ts` exports channel-name constants and an `IpcApi`
interface. `main` implements handlers; `preload` builds the concrete object and exposes it as
`window.jarvis`; renderer calls through `shared/ipc/client.ts`. Shared file is included in both
`tsconfig.node.json` and `tsconfig.web.json`.

### 3.1 Request/response (invoke/handle) - everything except terminal I/O

```
workspaces.list()                        -> Workspace[]
workspaces.create(folderPath, name?)     -> Workspace        // name defaults to basename
workspaces.rename(id, name)              -> Workspace
workspaces.remove(id)                    -> void             // app state only; never touches FS
workspaces.setLayout(id, layout)         -> Workspace
workspaces.setActive(id)                 -> void             // persists selected workspace
workspaces.pickFolder()                  -> string | null    // dialog.showOpenDialog

tabs.listByWorkspace(workspaceId)        -> Tab[]
tabs.create(workspaceId, preset)         -> Tab              // preset: 'shell' | 'claude'
tabs.rename(id, title)                   -> Tab
tabs.remove(id)                          -> void             // also kills its PTY session
tabs.reorder(workspaceId, orderedIds[])  -> Tab[]            // one transaction
tabs.assignToPane(id, slot|null)         -> Tab              // slot 0..3 or null (unplaced)
tabs.setActive(workspaceId, tabId)       -> void

app.getBootState()                       -> { selectedWorkspaceId: string|null }
```

- Errors: only `.message` survives IPC. Handlers wrap failures and return/throw with a clear
  message. Renderer store surfaces it in `status:'error'`.
- Every mutation returns the canonical row so the store write-through uses server truth.

### 3.2 Terminal I/O channels (performance-sensitive)

- `terminal.spawn(sessionId, preset, cwd, cols, rows)` -> `invoke/handle` returns `{ok}` (needs
  confirmation before renderer attaches xterm).
- `terminal:input` -> `send` (fire-and-forget), payload `{sessionId, data}`.
- `terminal:resize` -> `send`, payload `{sessionId, cols, rows}`.
- `terminal:data` -> **single multiplexed** `webContents.send`, payload `{sessionId, data}`.
  Renderer keeps ONE listener and demuxes by sessionId to the right xterm instance. (Never a
  per-session dynamic channel name - that leaks listeners and duplicates output.)
- `terminal:exit` -> `webContents.send`, payload `{sessionId, exitCode}`.
- `terminal.kill(sessionId)` -> `send`.

`sessionId` = `` `${workspaceId}:${tabId}` `` (stable, reconstructable).

---

## 4. Data model (domain types, `src/shared/domain.ts`)

```ts
type Preset = 'shell' | 'claude'
type Layout = 'single' | 'columns' | 'rows' | 'grid'   // 1 / 2 / 2 / 4 panes

interface Workspace {
  id: string            // uuid
  name: string
  folderPath: string
  layout: Layout
  activeTabId: string | null
  sortOrder: number
}
interface Tab {
  id: string            // uuid
  workspaceId: string
  title: string
  preset: Preset
  paneSlot: number | null   // 0..3 assigned pane in current layout, or null (tab-bar only)
  sortOrder: number
}
```

---

## 5. Database schema & migrations (node:sqlite)

DB file: `path.join(app.getPath('userData'), 'jarvis.db')` (i.e.
`~/Library/Application Support/Jarvis/jarvis.db`). Opened after `app.whenReady()`.
`journal_mode = WAL`; `foreign_keys` is ON by default in node:sqlite but we assert it.

Migration runner: read `PRAGMA user_version`; for each migration with `version > current`, run
its `up(db)` inside a transaction and bump `user_version`. `user_version` is set by string
interpolation of a program-controlled integer (PRAGMA can't bind params).

### Schema v1

```sql
CREATE TABLE workspaces (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  folder_path  TEXT NOT NULL,
  layout       TEXT NOT NULL DEFAULT 'single',
  active_tab_id TEXT,
  sort_order   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE TABLE tabs (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  preset       TEXT NOT NULL CHECK (preset IN ('shell','claude')),
  pane_slot    INTEGER,          -- 0..3 or NULL
  sort_order   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_tabs_workspace ON tabs(workspace_id);
CREATE TABLE app_state (            -- flat kv for cross-cutting singletons
  key   TEXT PRIMARY KEY,
  value TEXT
);
```

- `active_tab_id` intentionally not a FK (avoids ordering pain on delete; app reconciles).
- Reorder: repository rewrites `sort_order` for all affected tabs in one transaction.
- Delete workspace cascades tabs; PTY sessions for those tabs are killed by the IPC handler
  first (§7).
- Selected workspace persisted as `app_state('selected_workspace_id')`.

Repositories are plain functions taking a `DatabaseSync` handle -> trivially unit-testable
against an in-memory `new DatabaseSync(':memory:')` with the same migrations applied.

---

## 6. Split-layout model

Pure geometry table in `renderer/src/shared/layout/geometry.ts`:

```
single  : 1 slot   grid-template: single cell
columns : 2 slots  two columns
rows    : 2 slots  two rows
grid    : 4 slots  2x2 (css grid-areas a b / c d)
```

- `layout` persists per workspace. `paneSlot` per tab records assignment.
- Assignment UX (choose the simplest correct one): the tab context menu has "Open in split ->
  [slot]" actions, and the layout picker sets `workspace.layout`. Dragging is a nice-to-have,
  not required (PROMPT allows a simpler affordance). We implement context-menu assignment +
  a layout picker; drag-and-drop deferred.
- When layout shrinks (e.g. grid->single), tabs whose slot no longer exists are reconciled to
  `paneSlot=null` (still in tab bar). `activeTabId` fills slot 0 if empty.
- Pure functions: `slotsForLayout(layout)`, `reconcilePanes(tabs, layout, activeTabId)` -
  unit-tested.

---

## 7. Terminal / PTY lifecycle

### Main (`pty/sessionManager.ts`, `pty/shell.ts`)
- `resolveShell()` = `process.env.SHELL || '/bin/zsh'`.
- Spawn (both presets share a login+interactive shell so `.zprofile`+`.zshrc` load and PATH
  fully resolves - critical for finding `claude` at `~/.local/bin`):
  `pty.spawn(shell, ['-l'], { name:'xterm-color', cwd, cols, rows, env: process.env })`.
- **Shell preset**: nothing more.
- **Claude preset**: after spawn, write `claude\r` (short delay to let the shell settle). This
  mirrors strIDEterm's "type the command into a resolved interactive shell" pattern; PATH is
  resolved by the real shell, and when `claude` exits the user drops back to a live shell.
- `spawn(sessionId, preset, cwd, cols, rows)`: idempotent (in-flight guard); stores IPty in
  `Map<sessionId, IPty>`; wires `pty.onData -> webContents.send('terminal:data', {sessionId,data})`
  and `pty.onExit -> send('terminal:exit') + map.delete`.
- `write/resize/kill(sessionId)`; `killAll()`.
- On `pty.onExit` remove from map (covers user typing `exit`).

### Renderer (`terminal/terminalController.ts`) - the key perf pattern
- Module-level `Map<sessionId, {term, fitAddon, mountDiv}>` **outside React**.
- Attaching a session to a visible pane = append the persisted `mountDiv` into the pane's DOM
  node (imperative). Switching tabs/layout never destroys the xterm instance -> scrollback,
  cursor, and buffer survive.
- First attach: `term.open(mountDiv)`, load FitAddon + WebLinks, `fit()` now and again on next
  frame (fit() silently no-ops if container has zero size), subscribe to `terminal:data`
  (filtered by sessionId) -> `term.write`, wire `term.onData -> ipc terminal:input`.
- `ResizeObserver` on pane -> `fitAddon.fit()` then send `terminal:resize(cols,rows)`.
- Dispose a session's xterm only when its tab is deleted (unsubscribe listener, disconnect
  observer, dispose addons+term, then main `terminal.kill`).

### Teardown safety (no orphaned shells)
- Tab close: renderer disposes xterm then calls `tabs.remove` (handler kills PTY) - or directly
  `terminal.kill`.
- `app.on('before-quit')`: `sessionManager.killAll()` before exit.
- `BrowserWindow 'closed'`: also `killAll()` (single-window app, but defensive).

---

## 8. State management (Zustand, per-slice)

- One store per slice: `useWorkspacesStore`, `useTabsStore`, `useTerminalStore`. No global root
  store (that would be a mandatory edit point per feature, defeating the registry seam).
- Each store: `status: 'idle'|'loading'|'ready'|'error'`, normalized `byId`+`order`, actions.
- `hydrate()`: guards re-entry, loads via IPC, populates state. Fired at boot (non-blocking);
  components render skeletons on non-ready status.
- Mutations: pessimistic write-through by default (await IPC, set from canonical response).
  Optimistic+rollback only for rename-while-typing if needed.
- Cross-slice effects go through public APIs (e.g. deleting a workspace -> tabs store clears
  that workspace's tabs; terminal controller disposes those sessions), never a shared store.
- Boot order (`main.tsx`): `registerFeatures()` (sync, fills registries) -> `render(<App/>)`
  -> `hydrateStores()` (async). Workspaces hydrate first; tabs hydrate for the selected
  workspace.

---

## 9. Extensibility registries (required seam)

- `sidebarRegistry`: `SidebarSection { id, order, icon, label, component }`; module array;
  `registerSidebarSection` (throws on dup id), `getSidebarSections()` (sorted copy),
  `__resetForTests()`. Workspaces slice registers the workspace-list section. Shell maps over
  `getSidebarSections()` - "workspaces" is not hardcoded.
- `commandRegistry`: `Command { id, title, handler }`; `Map`; `registerCommand` (throws on dup),
  `getCommand(id)`, `getAllCommands()`, `__resetForTests()`. Registered command ids include
  `workspaces.create`, `workspaces.rename`, `workspaces.delete`, `tabs.newShell`,
  `tabs.newClaude`, `terminal.setLayout.columns|rows|grid|single`. **No palette UI** (data only),
  ready for a future command-palette slice.
- Both are dead-simple, synchronous, no plugin loader / dynamic import / config files.

---

## 10. UI / visual design

Minimalist functional dark theme. Before building UI components, invoke
`frontend-design:frontend-design` for typography/spacing/color/layout direction, then build a
small shared UI kit and apply it consistently across sidebar, tab bar, split panes, dialogs,
context menus. Deliberate, not templated defaults. Details deferred to that stage; recorded here
so the design is not "unstyled".

---

## 11. Test plan (TDD)

**Vitest - unit/integration (pure, no Electron process, no node-pty):**
1. Registries: register, duplicate-throws, order sort, getAll copy, reset-between-tests.
2. DB repos against in-memory `node:sqlite` + migrations: workspace CRUD, name defaulting,
   layout persistence, tab CRUD, reorder (sort_order rewrite), pane assign, cascade delete,
   app_state kv. **These are true integration tests but need no rebuild** (node:sqlite).
3. Migration runner: fresh DB -> v1; idempotent re-run; user_version bump; transaction rollback
   on a failing migration.
4. Pure layout logic: `slotsForLayout`, `reconcilePanes`.
5. Store logic with `./ipc` mocked (`vi.mock`): status transitions, write-through merges,
   optimistic-rollback branch, cross-slice clear on workspace delete.
6. Shell/preset spawn spec builder (`buildSpawn`) as a pure function: correct file/args and
   claude initial-command, without spawning.

**Playwright `_electron` - E2E / UAT:**
- App launches, main window renders, sidebar present.
- Create workspace via mocked folder pick (inject a temp dir), appears in sidebar with basename.
- Open Shell tab -> xterm renders, shell prompt appears; type `echo hi` -> output shows.
- Open Claude tab -> pty spawns (claude may or may not be present; assert the tab+pty exist and
  `claude` was written; tolerate command-not-found gracefully).
- Split: set columns layout, assign two tabs to panes -> both panes visible.
- Rename + reorder + delete tab; rename + delete workspace.
- **Restart survival**: quit, relaunch against the same userData dir -> selected workspace, its
  tabs, layout, and pane assignment restored.

TDD applies to items 1-6 (red-green-refactor). PTY plumbing and pure visual layout are verified
via E2E / manual per PROMPT's allowance.

---

## 12. Security config

- `webPreferences`: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`
  (Electron defaults; explicitly assert - the react-ts template ships `sandbox:false`, revert).
- Preload exposes only the narrow `window.jarvis` typed surface via `contextBridge`; never raw
  `ipcRenderer`.
- All node:sqlite / node-pty / fs access lives in main only.

---

## 13. Quit & persistence-on-start flow

- On boot: open DB + migrate -> load workspaces + selected id -> renderer hydrates -> for the
  selected workspace, tabs + layout + pane assignment restored -> PTYs are **not** auto-spawned
  on load in MVP (terminals start on demand when a pane shows a tab). (Simpler + avoids spawning
  N shells on launch; a tab shows a "start" affordance or auto-spawns when first attached.)
  DECISION: auto-spawn a tab's PTY the first time its pane becomes visible after restore, so the
  restored layout is immediately live. This is the least surprising behavior for a terminal app.
- On quit: kill all PTYs, ensure pending DB writes are synchronous (node:sqlite is synchronous,
  so no async flush needed - a correctness win over async stores).

---

## 14. Research basis

Findings (2026-07-05) that ground the above are archived from the research workflow: strIDEterm
study (imperative xterm Map, sessionId keying, quit teardown, layout vocabulary), electron-vite
scaffold + secure IPC, node:sqlite/better-sqlite3 ABI analysis, node-pty/@xterm v6 integration &
flow control, zustand per-slice + registry patterns. See task output
`tasks/wz1w1c6to.output` in the session scratch for full citations.

---

## 15. Build sequence

1. Scaffold electron-vite react-ts; strip template demo; set versions/security/tsconfig/test
   config; verify Electron launches + `node:sqlite` loads in main. (commit)
2. TDD: shared contracts, DB connection+migrations+repos, registries. (commit)
3. frontend-design pass -> UI kit + app shell (sidebar via registry). (commit)
4. Workspaces slice (store TDD + IPC + UI + folder picker). (commit)
5. Tabs slice (store TDD + IPC + tab bar + preset picker). (commit)
6. Terminal slice: sessionManager (main) + terminalController (renderer) + panes + split
   layouts + layout picker. (commit)
7. Preload bridge + main wiring end to end.
8. Playwright E2E (UAT). (commit)
9. Code review (adversarial) -> fix. (commit)
10. Run app + E2E, verify restart survival; finalize README. (commit)
```

---

## 16. Design-review reconciliation (adopted decisions)

Adversarial review (4 lenses vs PROMPT.md) returned "approve-with-changes" - no blockers.
The following decisions are adopted and OVERRIDE the sections above where they differ. They are
the authoritative delta for implementation.

### 16.1 Naming: rename cross-process `src/shared` -> `src/common`
Two "shared" dirs were ambiguous. Cross-PROCESS contracts live in **`src/common/`** (alias
`@common`): `domain.ts`, `ipc.ts`. Renderer-only primitives stay in `src/renderer/src/shared/`
(alias `@renderer/shared`): registries, ui kit, ipc client, layout geometry.

### 16.2 Main-content seam (extensibility) - add `mainComponent` to sidebar sections
`App.tsx` must NOT hardcode the workspaces view as the main area, or the future PR-review slice
has no surface. Extend the existing (already-sanctioned) sidebar registry with an optional field
- no new registry, no loader:
```ts
interface SidebarSection { id; order; icon; label; component; mainComponent?: ComponentType }
```
App shell keeps a tiny `activeSectionId` (app-shell local state), renders the active section's
`mainComponent` in the main region (resolves to workspaces today). This is the deliberate seam;
adding a slice with a main surface = register a section with a `mainComponent`, zero shell edits.

### 16.3 Cross-slice coordination lives in the app layer (no slice imports another slice)
- The workspaces store owns `workspaces[]` + `selectedWorkspaceId` + CRUD + `setLayout`. It never
  imports the tabs/terminal slices.
- **App-level effect** (`app/`): when `selectedWorkspaceId` changes, call `tabsStore.hydrate(id)`.
  Deletion just updates the workspaces store (remove + reselect); the effect re-hydrates tabs.
- Terminal xterm instances are disposed on their `terminal:exit` event (fired because the backend
  kills PTYs on tab/workspace delete via cascade+handler). `terminalController` also exposes an
  explicit `disposeForWorkspace(id)` used by the app-level deletion coordinator as a belt-and-braces.
- Net: all cross-slice reactions live in `app/` (the composition root), which alone may import
  multiple slice barrels. No feature slice depends on a sibling slice.

### 16.4 Hydration is sequential where dependent
Boot: `workspaces.getState()` (returns `{workspaces, selectedWorkspaceId}` in one call) ->
hydrate workspaces store -> app effect hydrates tabs for the selected workspace. `Promise.all`
is only for genuinely independent stores. Fixes the §2/§8 wording contradiction.

### 16.5 IPC: fold boot state into the workspaces module (drop `app.*` namespace)
`workspaces.ipc.ts` owns selection: `workspaces.getState() -> {workspaces, selectedWorkspaceId}`,
`workspaces.setActive(id)`. `appStateRepo` (kv) persists `selected_workspace_id` and is used only
by `workspaces.ipc.ts`. No separate `app.*` channel / `app.ipc.ts`. One IPC module per slice holds.

### 16.6 Repositories are factories with injected clock + id (deterministic tests)
`createWorkspaceRepo(db, { now, newId })` / `createTabRepo(db, { now, newId })` /
`createAppStateRepo(db)`. `now: () => number`, `newId: () => string` default to
`Date.now`/`crypto.randomUUID` in production; tests inject a monotonic counter + deterministic id.
`sort_order` on append = `MAX(sort_order)+1` (query-derived, deterministic given DB state). This
makes item-2/3 red-green real (exact ids, stable created_at, deterministic ordering).

### 16.7 node:sqlite WAL discipline (in-memory tests must not touch WAL)
Migrations ONLY create schema (no pragmas). `openDatabase(userDataDir)` sets
`journal_mode = WAL` + asserts `foreign_keys` for the ON-DISK db only, and must NOT assert the
result equals `'wal'` (a `:memory:` db returns `'memory'`). Repo tests do
`new DatabaseSync(':memory:')` + `runMigrations(db)` directly - never the WAL path.

### 16.8 node-pty confinement is lint-enforced
ESLint `no-restricted-imports` forbids importing `node-pty` anywhere except
`src/main/pty/sessionManager.ts`. `src/main/pty/shell.ts` is a PURE spec builder
(`buildSpawn(preset, cwd, opts) -> {file, args, initialCommand, env}`) with zero node-pty import,
so `buildSpawn` is unit-testable and never transitively loads the native binary in Vitest.

### 16.9 sessionManager has an injected spawn seam (teardown logic gets red-green)
`createSessionManager({ spawn, send })` - `spawn` defaults to `pty.spawn`, tests pass a fake that
records calls and can fire `onExit`. Unit-tests: idempotent in-flight guard, `Map<sessionId,IPty>`
lifecycle, `onExit` -> map delete (covers user `exit`), `killAll()` teardown. No node-pty import
in the test. This moves the orphaned-process-prevention logic the PROMPT cares about into TDD.

### 16.10 Renderer terminal:data demux is a pure `createDataRouter()`
Extract `createDataRouter()` = `{ register(sessionId, sink), route({sessionId,data}), dispose(sessionId) }`
owning the sessionId->sink Map. Unit-tested in Vitest (no jsdom/xterm). The xterm `open`/`fit`/
`ResizeObserver` stays the E2E-only imperative shell in `terminalController`.

### 16.11 IPC handlers are pure functions with injected deps (testable)
Each handler = a pure function taking injected deps (repos, `dialog`, `sessionManager`, `{now,newId}`)
returning a value or throwing a message-only error; `register()` merely binds them to
`ipcMain.handle`. Unit-test (Vitest, no Electron): error-wrapping (non-Error thrown -> clean
message string), canonical-row return, `pickFolder` cancel path. New test-plan item 7.

### 16.12 Claude preset write is deterministic; E2E shell is deterministic
- Claude preset: spawn `zsh -l`, then write `claude\r` gated on the FIRST `onData` from the PTY
  (shell is ready), not a fixed timeout. Rationale (spec deviation acknowledged): a login shell
  resolves PATH so `claude` in `~/.local/bin` is found, and exiting claude drops back to a live
  shell - the stronger design; matches strIDEterm's command-in-shell model.
- Test-mode shell seam: when `JARVIS_E2E=1`, `resolveShell`/`buildSpawn` spawn a no-rc shell
  (`zsh -f`) so xterm output is deterministic across machines/CI. Production default stays `-l`.
  E2E asserts on a unique token the test itself echoes, never on the prompt string.

### 16.13 E2E userData isolation + quit durability
- E2E passes `--user-data-dir=<tmp>` to `_electron.launch({ args })` (Chromium switch Electron
  honors before ready; `app.getPath('userData')` reflects it) and reuses the dir across the
  quit/relaunch pair. `openDatabase` reads a single `JARVIS_USER_DATA_DIR` env override too.
- `app.on('before-quit')`: `killAll()` PTYs, then `db.close()` (forces WAL checkpoint) so the
  relaunch reliably sees committed state.
- Add an Electron-runtime DB parity smoke to E2E (migrate + CRUD + reorder round-trip inside the
  shipped Node 24.17 node:sqlite) so the RC engine is exercised beyond the happy-path restart.

### 16.14 Tab reorder affordance + geometry ownership + scope
- Tab reorder UI: **move-left / move-right** actions in the TabItem context menu (drag-and-drop
  remains a deferred nice-to-have). E2E reorder step drives these.
- `renderer/src/shared/layout/geometry.ts` has genuine cross-slice consumers: terminal slice
  (`SplitStage`/`LayoutPicker` use `slotsForLayout`+grid templates) and tabs store
  (`reconcilePanes` on tab delete). Legit shared primitive; documented.
- **Drop `@xterm/addon-web-links`** (the one product addition beyond spec) to honor "build only
  what's specified". Clickable links can be added trivially later.

### 16.15 node:sqlite test/prod fidelity - explicit trade-off
Repo unit tests run on host Node 25.9's node:sqlite; production ships Electron's Node 24.17
node:sqlite (a different RC build). Verified logic ≠ verified shipped engine. Mitigation: keep all
node:sqlite in the repo layer (swappable), and rely on the §16.13 Electron-runtime parity smoke to
exercise the shipped engine. Trade-off accepted for MVP.

### 16.17 Correctness-review reconciliation (runtime robustness)
A dedicated correctness/robustness review surfaced several runtime bugs to fix as first-class
requirements (all adopted):

- **(blocker) Register-before-spawn.** The PTY emits its prompt within ~1ms of `pty.spawn`. If
  the renderer registers its data sink only *after* `await terminal.spawn` resolves, the initial
  prompt / Claude banner is routed to a missing sink and silently lost. FIX: because `sessionId`
  is deterministic, construct the xterm `Terminal` + `router.register(sessionId, sink)` FIRST,
  then `await terminal.spawn(...)`. xterm buffers `write()` before `open()`, so nothing is lost.
- **(major) Latch the Claude write.** `onData` fires repeatedly; gate `claude\r` on the FIRST
  data event and latch it (unsubscribe / boolean) so it is written exactly once.
- **(major) Validate cwd.** A workspace folder may be deleted/moved externally. `sessionManager`
  checks `fs.existsSync(cwd)` and falls back to `os.homedir()` (writing a one-line notice into the
  terminal) instead of throwing an un-actionable spawn error.
- **(major) Kill PTYs by sessionId prefix on workspace delete.** `sessionManager.killWorkspace(wsId)`
  iterates its Map keys with prefix `` `${wsId}:` `` and kills matches - no DB enumeration, so it
  works even after the cascade removed the tab rows. Called in the `workspaces.remove` handler.
- **(major) Backpressure.** Implement the watermark scheme: spawn with node-pty
  `handleFlowControl: true`; renderer counts outstanding bytes via xterm `write(data, cb)`, and
  crossing a high watermark sends `terminal:pause` (main writes XOFF `\x13`), dropping below a low
  watermark sends `terminal:resume` (main writes XON `\x11`). Prevents runaway output (`cat huge`,
  `yes`) from hanging/OOMing the renderer. Adds channels `terminal:pause` / `terminal:resume`.
- **(major) tabs.remove reselects active tab in-transaction.** If the removed tab is the
  workspace's `active_tab_id`, set it to a sibling (by sort_order) or null in the SAME transaction,
  so no dangling ref persists in the DB (it is deliberately not an FK).
- **reconcilePanes hardening + applied on load AND setLayout:** never place `activeTabId` in slot 0
  if it already owns a slot (no double-render); clear any `pane_slot >= slotCount(layout)`;
  reconcile is the single authoritative transform run on `setLayout` (persisted) and at load.
- **Invariants (all sessions):** `route/write/resize/kill` are no-ops on an unknown sessionId;
  xterm disposal is idempotent (guarded Map entry); exactly ONE module-scope `terminal:data`
  listener for the renderer's lifetime; the `ResizeObserver` observes the persisted `mountDiv`
  (which travels between panes), not the pane node.
- **(decision) Quit on window close.** Single-window app: `window-all-closed -> app.quit()` on all
  platforms (overriding the macOS stay-resident convention) to avoid a dock-reactivate showing a
  live window with dead shells. `before-quit`: `killAll()` then `db.close()` (WAL checkpoint).
  No separate `killAll()` on window `'closed'`.
- **(nit) Env hygiene:** pass `env` derived from `process.env` but strip `ELECTRON_RUN_AS_NODE` and
  other `ELECTRON_*` vars (confuse node CLIs); set `TERM=xterm-256color`. Keep `-l` login shell
  (that is what resolves PATH for `claude`).
- **(nit) Future migrations** must avoid statements that implicitly COMMIT, or the per-migration
  rollback guarantee breaks.

### 16.16 Manifests are append-only (not "one coupling point")
Adding a slice appends to: `app/registerFeatures.ts`, the app boot/hydrate sequence,
`src/common/ipc.ts` + `domain.ts`, and `migrations.ts`. All are append-only manifests that add no
inter-slice coupling. (Wording fix vs §2's "one coupling point".)
