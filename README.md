# Intersect

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
- **Persistence** - SQLite (`node:sqlite`) in `~/Library/Application Support/Intersect/intersect.db`.
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
| `npm run dev:debug` | The same, with the renderer exposed on Chrome DevTools port 9222 |
| `npm run build` | Type-check and build main/preload/renderer into `out/` |
| `npm start` | Preview the built app |
| `npm test` | Unit + integration tests (Vitest) |
| `npm run e2e` | Build, then end-to-end tests against the built app (Playwright + Electron) |
| `npm run e2e:nobuild` | The same suite against the existing build in `out/` |
| `npm run typecheck` | Type-check the node and web projects |
| `npm run lint` | ESLint (enforces slice boundaries + `node-pty` confinement) |

The E2E suite runs against `out/`, so a run started without a build would report on code you are
not looking at. Every Playwright entry point - `npm run e2e`, `npm run e2e:nobuild`, and a bare
`npx playwright test` - therefore refuses to start unless `out/main`, `out/preload` and
`out/renderer` have all been built and *every file* in them is newer than every build input.
Nothing weaker holds: `npm run dev` rebuilds main and preload but serves the renderer from memory,
so after a dev session a single newer file - a `.DS_Store` from opening `out/renderer` in Finder
will do - would otherwise vouch for a renderer that was never rebuilt.

Build inputs are `src/`, `electron.vite.config.*`, `package.json`, `package-lock.json`, the root
`tsconfig*.json`, and the root `.env` files Vite actually loads. Editing a test file in place
(`*.test.*`, `*.spec.*`, anything under `__tests__/`) never trips the guard, because no bundle
entry imports one - but creating, deleting or renaming one does, through its parent directory.
That is deliberate: the same directory signal is the only thing that catches a deleted or renamed
production file. Editing only `e2e/` never trips it either, so `npm run e2e:nobuild` stays the fast
loop while iterating on specs.

A refusal names whatever beat the build, and the fix, `npm run build`. `E2E_ALLOW_STALE=1`, and
only that exact value, runs against a stale build anyway and says so in the log. It does not
override a missing build or a check the guard could not complete.

The suite launches the app well over a hundred times, and it does so off screen: the harness asks
main for a hidden window (`INTERSECT_HIDDEN_WINDOW=1`), the app never shows one and never appears
in the Dock, so macOS does not activate it and a run leaves the keyboard and the foreground to you.
Playwright drives the window over the debugging protocol, so clicks, typing, focus assertions and
screenshots work unchanged. `E2E_HEADED=1`, and only that exact value, brings the window back on
screen for watching a spec run.

### Diagnostics

Structured logs are written as one JSON object per line to
`~/Library/Application Support/Intersect/logs/intersect-<date>.jsonl`, covering Electron main, the
headless core, and the renderer. Records from all three processes interleave, so sort by `ts`:

```bash
cat ~/Library/Application\ Support/Intersect/logs/intersect-*.jsonl \
  | jq -s 'sort_by(.ts) | .[] | select(.level == "error")'
```

`INTERSECT_LOG_LEVEL` sets the floor (`error`, `warn`, `info`, `debug`); it defaults to `debug` in
development and `info` when packaged. Files older than 7 days are pruned at startup.

`npm run dev:debug` additionally exposes the renderer on `http://127.0.0.1:9222` for a Chrome
DevTools client.

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
  preload/           # typed contextBridge -> window.intersect (contextIsolation + sandbox)
  renderer/src/
    app/             # shell: App, Sidebar, feature registration
    shared/          # renderer primitives: registries, UI kit, ipc client, theme
    features/
      workspaces/    # list + selection + CRUD (owns the sidebar section + main area)
      tabs/          # the selected workspace's terminal view: tabs, layout, active, pane slots
      terminal/      # imperative xterm controller + split stage + panes
e2e/                 # Playwright _electron specs
tooling/             # repo tooling outside the app: the E2E build-freshness guard and app register
```

### Extensibility seam

Two dead-simple registries let future slices plug in without restructuring:

- **Sidebar section registry** - slices push `{ id, order, icon, label, component, mainComponent,
  placement }`; the shell renders sections and the active section's main content from the registry,
  so nothing is hardcoded to "workspaces". `placement` pins utility sections (Settings) to the
  sidebar footer instead of the main rail.
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
- **Backpressure** - the renderer watermarks xterm's write buffer and pauses/resumes the child PTY
  so a firehose (`cat huge.log`) can't hang the UI.

### Testing

Business logic is test-driven (Vitest): registries, DB repositories + migrations against in-memory
`node:sqlite`, pure layout reconciliation, session-manager teardown with an injected fake spawn,
IPC handler composition, and store logic with mocked IPC. Terminal PTY plumbing and visual layout
are verified end-to-end with Playwright driving the real Electron app (including restart survival).
