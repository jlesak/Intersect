# Per-pane tab groups

Date: 2026-08-19

## Problem

The terminal area renders one global tab bar above the whole split stage. In a two-column
layout both tab names sit in that single strip at the top left, so nothing above a pane says
which terminal it holds. Every other multi-pane application (VS Code, iTerm) puts the name
above the pane it belongs to.

## Decision

Each pane becomes a tab group with its own tab bar, in the VS Code editor-group sense: a group
owns an ordered list of tabs, shows one of them, and the global tab bar disappears.

Settled by the product owner during design:

- The fixed layout presets stay. `single` / `columns` / `rows` / `grid` keep their picker and
  their persisted divider shares; a pane is a group. A group with no tabs stays on screen as an
  empty pane.
- Tabs move between groups by drag onto another group's bar, with the existing
  "Open in pane N" context-menu entries kept as the non-mouse path.
- Shrinking the layout merges the disappearing groups into the surviving ones. Nothing is ever
  hidden or lost.
- Keyboard shortcuts and the new-tab button act on the focused group.
- The workspace tools (layout picker, all-tabs overflow) live at the right end of the top-right
  group's bar.

## Data model

`Tab.paneSlot` changes meaning from "which pane, or nowhere" to "which group". It is always a
number, and the unplaced-tab concept is removed.

| field | change |
| --- | --- |
| `tabs.pane_slot` | always written; `NULL` normalized to `0` on read |
| `tabs.sort_order` | renumbered per group, `0..n-1` inside each slot |
| `tabs.last_active_at` | new `INTEGER`, stamped on activation |
| `workspaces.active_tab_id` | unchanged: the globally focused tab |

Two things are derived rather than stored:

- A group's **visible tab** is the tab in that group with the greatest `last_active_at`, falling
  back to the first by `sort_order`.
- The **focused group** is the `paneSlot` of `workspaces.active_tab_id`.

`pane_slot` remains nullable at the SQL level. SQLite cannot add `NOT NULL` to an existing
column, and rebuilding `tabs` would cascade-delete `work_item_ref` rows through its
`ON DELETE CASCADE` foreign key while `PRAGMA foreign_keys = ON`. `tabRepo` enforces the
invariant instead: every write supplies a slot, and every read coalesces `NULL` to `0`.

### Migration 27

Applied in this order:

1. `ALTER TABLE tabs ADD COLUMN last_active_at INTEGER;`
2. Stamp `last_active_at` on rows whose `pane_slot` is currently non-null. These are the tabs
   visible in panes today, and stamping them keeps them visible after the merge.
3. Stamp `last_active_at` on every `workspaces.active_tab_id`, which covers workspaces in the
   `single` layout where no tab carries a slot.
4. `UPDATE tabs SET pane_slot = 0 WHERE pane_slot IS NULL;`
5. Renumber `sort_order` per `(workspace_id, pane_slot)`.

## Layout remapping

`reconcilePanes` in `src/common/layout.ts` is replaced by `remapSlots(from, to)`. The correct
merge is positional, so it is an explicit table:

```
grid    -> columns   [0, 1, 0, 1]   the left column stays left
grid    -> rows      [0, 0, 1, 1]   the top row stays top
grid    -> single    [0, 0, 0, 0]
columns -> single    [0, 0]
rows    -> single    [0, 0]
columns <-> rows     identity
single  -> anything  identity; groups 1..n-1 start empty
```

Merged tabs append after the target group's existing tabs with their relative order preserved.
A slot outside the target layout's range clamps to `n - 1`.

## Core

- `tabRepo`: `setPaneSlot`, `setPaneSlots` and `clearPaneSlot` (the one-tab-per-slot eviction)
  give way to `moveToGroup(id, slot, index)`, which renumbers both affected groups inside one
  `tx`, plus `remapGroups(workspaceId, from, to)` and `touchActive(id, at)`.
- `tabs.ipc`: `assignToPane(id, slot)` becomes `moveTab(id, slot, index)`; `setActive` also
  stamps `last_active_at`; `create` inserts at the end of a caller-supplied slot.
- `workspaces.ipc.setLayout` calls `remapGroups` in place of `reconcilePanes`.

## Renderer state

`useTabsStore` keeps `byId` and `order`, with `order` sorted by `paneSlot` then `sortOrder`, and
gains `selectGroupTabs(slot)`, `selectGroupVisibleTab(slot)` and `selectFocusedSlot`. `nextTab`,
`jumpToTab` and `createTab` act on the focused group. `moveTab(id, slot, index)` is new. Clicking
or typing in a pane activates that group's visible tab, which is how focus moves between groups.

`attentionWiring.ts` keeps reporting a single active session. Its meaning becomes "the pane the
user is working in", and a visible but unfocused pane keeping its attention dot matches VS Code.
Widening it to a set of sessions would reach into the main-process API for no gain.

## Components

`TabBar.tsx` currently holds five responsibilities in one file. It splits into:

- `PaneTabBar.tsx`: one group's strip, its tabs, its `+`, and the workspace tools when it is the
  top-right group (`single` → 0, `columns` → 1, `rows` → 0, `grid` → 1).
- `TabItem.tsx`: one tab, with preset badge, work-item chip, inline rename, close button and drag
  handlers.
- `tabDrag.ts`: drag state and drop-index calculation.

`SplitStage` renders a `PaneTabBar` inside each `Panel`, above `ix-pane__host`. `WorkspaceView`
stops rendering a tab bar. An empty group shows a bar carrying only `+`, over a body offering
Shell and Claude Code. Drag follows the native HTML5 pattern already used in `TodoView.tsx`, with
a drop indicator at the insert point. The focused group's bar carries an accent. `.ix-tabbar`
drops from 42px to 32px, since it can now appear four times on screen.

## Testing

- `remapSlots` table-driven across every from/to pair; per-group renumbering; a migration 27
  upgrade-path test from a v26 database asserting merged groups and preserved visible tabs.
- Store: focused-group scoping of `nextTab`, `jumpToTab` and `createTab`; `moveTab` across groups.
- Components: `PaneTabBar` renders only its own group; the tools appear in exactly one bar; a
  drag from group 0 to group 1 moves the tab.
- E2E: split to columns and assert each pane carries its own bar with its own title above it;
  drag a tab across; collapse to single and find everything merged into one bar.

## Out of scope

Dynamic split and collapse, dragging a tab into a terminal body to create a split, cross-workspace
drag, and MRU tab cycling, which `last_active_at` would make cheap to add later.
