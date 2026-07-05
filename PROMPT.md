# Build "Jarvis" — Personal macOS Dashboard App (MVP: Workspace & Terminal Manager)

## Context and Vision

You are building the first usable version of a personal, single-user macOS desktop application codenamed **Jarvis**, for a senior .NET software engineer and team lead. The long-term goal of this app is to reduce context-switching cost across the many tools this person uses daily (terminals, Claude Code sessions, Azure DevOps, Jira, Notion, calendar, etc.) by consolidating them into one modular app.

**This prompt scopes only the first vertical slice: a workspace and terminal manager**, heavily inspired by an existing open-source project called `strIDEterm` (a Vue-based Electron app at `../strideterm` relative to this repo, if available on this machine — read its `src/`, `electron/`, and `docs/` for UX and architectural inspiration, but do **not** copy Vue code or its license verbatim; this is a clean-room React implementation, inspired by its UX only).

Future slices (PR review inbox for Azure DevOps, a command palette, a "My Work / Today" aggregator, custom time tracking) are **out of scope** for this prompt. Do not implement them. However, the architecture must not preclude adding them later without a rewrite — see "Extensibility" below.

## Tech Stack

- **Electron** (main process) + **React** + **TypeScript** (renderer)
- **node-pty** for terminal process spawning, **xterm.js** for terminal rendering in the renderer
- **SQLite** (e.g. via `better-sqlite3`) for local persistence, main-process-owned, accessed by the renderer only through IPC
- State management in the renderer: your choice (Zustand is a good default fit for this architecture, but decide based on what you scaffold)
- Package manager, bundler (Vite recommended), linting/formatting: your choice, follow common conventions for an Electron + React + TS app in 2026
- Single main window only. No multi-window, no profiles, no remote access — all out of scope.

## Architecture: Vertical Slices + Light Extensibility

Organize the renderer codebase by **feature (vertical slice)**, not by technical layer. Each slice owns its own components, hooks, local state, and IPC contracts:

```
src/
  features/
    workspaces/     # workspace CRUD, sidebar list, folder picker
    terminal/        # xterm.js integration, PTY session lifecycle
    tabs/            # tab bar, tab presets (shell / Claude Code), split layouts
  shared/            # cross-slice primitives only (UI kit, IPC helpers) — keep this small
electron/
  main.ts
  ipc/               # one IPC handler module per slice, mirroring src/features/*
  db/                # SQLite schema + migrations
```

Each feature folder should be understandable in isolation: what it does, how other code uses it (its public exports), and what it depends on. Don't let slices reach into each other's internals.

**Extensibility requirement:** Implement a **lightweight registration mechanism** now, even though only one module (workspaces/terminal) will use it in this MVP. Concretely:

- A **sidebar section registry**: a simple ordered list that feature slices push a section descriptor into (icon, label, component) so the main sidebar renders sections without hardcoding "workspaces" as the only possible entry.
- A **command registry** (data structure only, no UI yet): each slice can register named commands with a handler (e.g. `workspaces.create`, `terminal.splitRight`). This does not need a visible command palette UI in this MVP — just the registry itself, since a future command palette slice will consume it.

Keep both registries dead simple (an array/map with a `register()` function) — no plugin loader, no dynamic imports, no config files. This is about leaving a seam, not building a plugin system.

## MVP Feature Spec

### Workspaces
- A workspace = a named reference to a folder on disk (the working directory for its tabs).
- Sidebar lists all workspaces. Add a workspace via a native folder picker (Electron `dialog.showOpenDialog`); default the workspace name to the folder's basename, editable.
- Support rename and delete of a workspace (deleting a workspace does not touch the filesystem, only app state).
- Persist workspaces in SQLite; reload them on app start exactly as left (selected workspace, its tabs, layout).

### Terminal Tabs
Two tab presets, both spawning a real PTY via node-pty rooted at the workspace's working directory:
1. **Shell** — spawns the user's default shell (`$SHELL`, fallback `zsh`).
2. **Claude Code** — spawns `claude` in the workspace directory.

Tabs belong to a workspace. Support: create tab (via preset picker), close tab, rename tab, reorder tabs (drag and drop is nice-to-have, not required for MVP — a simple move-left/right affordance is sufficient if drag-and-drop adds too much complexity).

Terminal rendering: xterm.js in the renderer, PTY process lifecycle owned by the main process, output/input streamed over IPC. Handle resize (PTY resize on pane resize) and clean process teardown when a tab closes or the app quits — don't leak orphaned shell processes.

### Split Layouts
Within a workspace, support arranging multiple tabs visible simultaneously in these layouts (mirror strIDEterm's tab split concept, simplified):
- Single (one tab fullscreen — default)
- Columns (2 tabs side by side)
- Rows (2 tabs stacked)
- 2×2 grid (up to 4 tabs)

The user assigns a tab to a pane (e.g. by dragging a tab into a pane, or a simpler "open in split" action from the tab's context menu — pick whichever is less complex to implement correctly). Persist the chosen layout and pane assignment per workspace.

### Persistence
SQLite database in the app's user data directory (e.g. `~/Library/Application Support/Jarvis/jarvis.db`, i.e. Electron's default `app.getPath('userData')` — don't invent a custom directory unless there's a clear reason). Schema covers: workspaces, tabs (with preset type and workspace FK), layout/pane-assignment state. Use a simple migration approach (even a single versioned schema-creation script is fine for MVP — no need for a migration framework).

## UI / Visual Design

Minimalist, functional dark theme — this is a personal productivity tool, not a marketing surface, but it should still feel deliberate and polished, not like unstyled default components.

**Before implementing any UI component, invoke the `frontend-design:frontend-design` skill** for guidance on typography, spacing, color, and layout choices so the result reads as intentional rather than templated defaults. Apply this consistently across the sidebar, tab bar, split panes, and dialogs.

## Non-Goals (explicitly do not build)

- File manager pane, Git pane, embedded browser tabs, Docker manager, SSH support
- Command palette UI, Azure DevOps / GitHub PR review, calendar/"My Work" aggregation, time tracking
- Multi-window, profiles, remote access, plugins loaded from external sources
- Auth/login of any kind — this is a fully local, single-user app

Do not scaffold empty stubs or placeholder screens for out-of-scope features. Build only what's specified above, plus the two lightweight registries described in Extensibility.

## Quality Bar and Process

- Follow standard TDD where it applies (business logic in slices — workspace CRUD, layout persistence, IPC contracts). Terminal PTY plumbing and pure UI layout code can be verified manually/visually instead of unit-tested where automated testing adds little value.
- Keep changes surgical and scoped to this spec — no speculative abstractions beyond the two registries explicitly requested.
- After scaffolding, actually run the app (`npm run dev` or equivalent) and verify end-to-end: create a workspace, open both tab presets, split panes, restart the app, and confirm state survived. Report explicitly if you could not verify something end-to-end (e.g. no display available) rather than claiming it works.
- Initialize a git repository if one doesn't exist, and commit logical milestones as you go, but only if the environment allows it — do not push anywhere.

## Deliverable

A running Electron app in this repository that satisfies the MVP feature spec above, structured as vertical slices with the two extension-point registries in place, ready for the next slice (a command palette) to be added without restructuring existing code.
