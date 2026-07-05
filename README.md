# Jarvis

A personal, single-user macOS desktop app that consolidates a developer's daily tools into one
modular workspace. This first vertical slice is a **workspace & terminal manager**: named folder
workspaces, real terminal tabs (your shell or Claude Code), and split layouts - all persisted
locally and restored exactly as you left them.

Clean-room React/Electron implementation, inspired by strIDEterm's UX.

## Features (this MVP)

- **Workspaces** - a workspace is a named reference to a folder. Add via the native folder picker
  (name defaults to the folder's basename, editable inline), rename, and delete. Deleting only
  removes app state; it never touches the filesystem.
- **Terminal tabs** - two presets, each a real PTY rooted at the workspace folder:
  - **Shell** - your `$SHELL` (falls back to `/bin/zsh`), as a login shell so `PATH` resolves.
  - **Claude Code** - the same shell with `claude` typed in once it's ready.
  - Create, close, rename, and reorder (move left/right from the tab's context menu).
- **Split layouts** - Single, Columns, Rows, and a 2×2 Grid. Assign tabs to panes from the empty
  pane or the tab context menu. Layout and pane assignment persist per workspace.
- **Persistence** - SQLite (`node:sqlite`) in `~/Library/Application Support/Jarvis/jarvis.db`.
  On launch the selected workspace, its tabs, layout, and pane assignment are restored.

## Tech stack

Electron 43 · electron-vite 5 · React 19 · TypeScript 5.9 · Zustand 5 · `@xterm/xterm` 6 ·
`node-pty` 1.1 · `node:sqlite` (built-in) · Vitest 4 · Playwright (`_electron`).

## Getting started

```bash
npm install      # node-pty ships N-API prebuilds; no native rebuild step needed
npm run dev      # launch the app with HMR
```

Requires Node 20.19+/22.12+ (Node 24 LTS recommended) and macOS with Xcode Command Line Tools.

### Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Run the app in development with hot reload |
| `npm run build` | Type-check and build main/preload/renderer into `out/` |
| `npm start` | Preview the built app |
| `npm test` | Unit + integration tests (Vitest) |
| `npm run e2e` | End-to-end tests against the built app (Playwright + Electron) |
| `npm run typecheck` | Type-check the node and web projects |
| `npm run lint` | ESLint (enforces slice boundaries + `node-pty` confinement) |

For E2E: `npm run build` first, then `npm run e2e`.

## Architecture

Organized by **vertical slice**, not technical layer. Each slice owns its components, store, IPC,
and registration, and is understandable in isolation. ESLint forbids reaching into another slice's
internals (imports must go through its `index.ts` barrel).

```
src/
  common/            # cross-process contracts: domain types, IPC surface, pure layout logic
  main/              # Electron main process
    db/              # node:sqlite connection, migrations, repositories (transaction-agnostic)
    pty/             # session manager (injectable spawn), shell spec builder, node-pty adapter
    ipc/             # one handler module per slice (pure factories + thin ipcMain binding)
    index.ts         # app lifecycle: open DB, wire IPC, window, quit teardown
  preload/           # typed contextBridge -> window.jarvis (contextIsolation + sandbox)
  renderer/src/
    app/             # shell: App, Sidebar, feature registration
    shared/          # renderer primitives: registries, UI kit, ipc client, theme
    features/
      workspaces/    # list + selection + CRUD (owns the sidebar section + main area)
      tabs/          # the selected workspace's terminal view: tabs, layout, active, pane slots
      terminal/      # imperative xterm controller + split stage + panes
e2e/                 # Playwright _electron specs
```

### Extensibility seam

Two dead-simple registries let future slices plug in without restructuring:

- **Sidebar section registry** - slices push `{ id, order, icon, label, component, mainComponent }`;
  the shell renders sections and the active section's main content from the registry, so nothing is
  hardcoded to "workspaces".
- **Command registry** - a `Map` of `{ id, title, handler }` (e.g. `workspaces.create`,
  `terminal.layoutColumns`). Data structure only - a future command palette will consume it.

Adding a slice is append-only: its `register()` call in `app/registerFeatures.ts`, additive IPC
contracts, and a new migration. No existing slice changes.

### Notable decisions

- **`node:sqlite` over better-sqlite3** - the built-in module needs no native ABI rebuild, so the
  same code runs under Electron's Node and under Vitest's host Node. This makes the database logic
  directly unit-testable against an in-memory DB with zero build dance.
- **`node-pty` N-API prebuilds** - ABI-stable across Node and Electron, so no `@electron/rebuild`.
  Its `spawn-helper` executable bit is restored at startup (a known packaging quirk).
- **Imperative terminal controller** - xterm instances live in a `Map` outside React and are
  attached/detached from panes, never remounted, so scrollback and cursor survive tab/layout
  switches. The data sink is registered before the PTY spawns so the first prompt is never lost.
- **Backpressure** - the renderer watermarks xterm's write buffer and XOFF/XON's the child so a
  firehose (`cat huge.log`) can't hang the UI.

### Testing

Business logic is test-driven (Vitest): registries, DB repositories + migrations against in-memory
`node:sqlite`, pure layout reconciliation, session-manager teardown with an injected fake spawn,
IPC handler composition, and store logic with mocked IPC. Terminal PTY plumbing and visual layout
are verified end-to-end with Playwright driving the real Electron app (including restart survival).
