# Command Palette - Design

## Goal

Add a keyboard-driven command palette that lets the user run any registered command
without the mouse. It is the first consumer of the existing `commandRegistry` seam left
in place by the MVP; adding it requires no change to how slices register commands.

## Placement

The palette is a *consumer* of the command registry, not a registrant. It does not own a
sidebar section and registers no commands of its own, so it does not fit the
sidebar/command registration pattern. It is a global overlay - exactly like the existing
`<Toaster />` - and mounts directly in `App.tsx` alongside it. That is the single shell
edit this slice requires.

## Structure

New slice `src/renderer/src/features/commandPalette/`:

- `fuzzy.ts` - pure `filterCommands(query, commands): Command[]`. Subsequence match with
  ranking. The business logic of the slice; unit-tested.
- `components/CommandPalette.tsx` - the overlay: backdrop, search input, ranked result
  list, keyboard navigation. Owns the global Cmd+K listener via `useEffect`.
- `index.ts` - exports `CommandPalette`.

## Behavior

- **Cmd+K** toggles the palette open/closed (global `keydown`, `preventDefault`).
- **On open:** snapshot `getAllCommands()`, reset query to empty, selection to the first
  row, autofocus the input.
- **Typing** re-ranks live via `filterCommands`. Empty query lists all commands in
  registry insertion order. Selection clamps to the first row on every query change.
- **ArrowDown / ArrowUp** move the selection, clamped (no wrap).
- **Enter** invokes the selected command's handler, then closes.
- **Escape** or a backdrop click closes without running anything.
- Clicking a row invokes its command and closes.
- The palette registers no command for itself, so it never appears in its own list.

Command handlers already guard themselves (e.g. `tabs.newShell` no-ops when no workspace
is selected) and report their own failures via toast, so the palette needs no
enable/disable logic and no error handling around `handler()`.

## Fuzzy matching

`filterCommands` matches the query as a case-insensitive subsequence of the command
title. It drops non-matches and ranks survivors by:

- contiguous run of matched characters (a tighter match ranks higher),
- earlier first match position,
- match starting at a word boundary.

Empty query returns every command unranked, in registry order.

## Testing

- `fuzzy.test.ts` (unit): subsequence match, case-insensitivity, ranking order
  (contiguous beats scattered, earlier beats later), empty-query passthrough, non-match
  exclusion.
- One Playwright E2E: press Cmd+K, type to filter, press Enter to run a command, assert
  the resulting effect and that the palette closed.
- Overlay visuals verified manually (per project guidance that pure UI needs no unit
  test), styled with the existing theme tokens via the `frontend-design` skill.
