# Product decisions

Intersect is its owner's personal work app. It exists to make one developer and team lead faster
at daily work: terminals and Claude Code sessions, pull request review in Azure DevOps, work
items, time tracking, 1:1s and TODOs. Judge a feature or a UX choice by how much it speeds up those
workflows, not by general app-design taste.

The owner decides functionality and major technical direction (see `AGENTS.md`). This file records
what they have already decided, so that plans and reviews start from it instead of reopening it.
The fuller design record is `docs/2026-07-07-intersect-final-form-design.md`, and feature specs
are in `docs/specs/`. Where those predate a decision below, this file wins.

## Principles

- **Functionality over form.** The app must be practical, not pretty. Prefer dense,
  information-rich, keyboard-friendly UI. Skip decorative styling, animation and visual polish that
  serves no workflow. When two options trade off, choose the one that makes a workflow faster.
- **Readability comes first** among visual qualities.
- **Order and structure over free-form layouts** where the owner scans for state, as on the
  Dashboard.

## Visual design (Intersect 2.0)

The tokens live in `src/renderer/src/shared/ui/theme.css`.

- Dark, but not black: background `#171d28`, surfaces `#1d2532` and `#242e3e`.
- Primary accent cyan `#4cc9e8`. Session status hues stay: working blue, waiting yellow, done
  green.
- Base font 14px with line height 1.55, secondary text kept light enough to read, radii 8/6/12.

## Dashboard

A fixed four-zone structure: needs action, running sessions, time today with the timer, and
system status.

## Time tracking

- Fully native. The Toggl integration was removed and stays removed.
- The week is Monday to Friday, with no weekend columns.
- Overlapping parallel sessions are not flattened into one timeline.
- A duration is capped to the session's active, non-suspended time.
- Description and duration are both editable inline.

## Pull requests

- Azure DevOps only. There is no GitHub provider for the PR inbox.
- The inbox is a dense status table, one row per pull request, in the style of Azure DevOps.
  - Tabs: To review, Mine, All active.
  - The leftmost column is the owner's next action as a verb: RESPOND (own PR, the author is
    blocked), REVIEW, RE-REVIEW, WAIT, DONE. Verbs derive from the rules in `src/common/prBoard.ts`.
  - Rows sort by verb rank; within the actionable ranks the oldest waiting comes first, and within
    WAIT and DONE the newest comes first.
  - A vote status column rolls the votes up (rejected, waiting for author, n of m approved,
    approved, no votes yet), and reviewer votes show as avatar badges with a glyph.
  - The owner's own pull requests are marked.
- The PR detail view mirrors Azure DevOps: it lands on an Overview tab with the description and
  every comment thread, and a Files tab shows the comments inline in the diff.
- PR sync runs when the app gains focus. There are no PR event notifications at any cadence.

## Declined: do not propose again

- Unifying the UI language.
- Keyboard-driven PR review (j/k navigation plus a Reject vote).
- Settings validation polish.
- Edit-in-place for the agent tooling view.
- A UTF-8 locale forced on the PTY environment.
- Pre-accepting Claude Code's worktree trust dialog.
- PR event notifications, at any cadence.
- A GitHub provider for the PR inbox.
- A cross-repository dirty-working-tree radar.
- Token usage attributed per work item.
- Migration failure recovery beyond what issue #117 covers.
- A tray icon, nested splits, headless review with permission bypass, automatic worklogs, billing
  and contracts, a notes module, an embedded Teams window, a hosted data plane, Wake-on-LAN.

Postponed, not declined: undo for closing a tab.

## Accepted backlog

The issues labelled `watchtower-review` (#132 to #140) were accepted together. Build order: #132,
then #139 (blocked by #132), #133, #134, #135, #136, #137, and last #138 (today's meetings on the
Dashboard) together with #140 (suggested time entries from the same meetings fetch) in one
release. #134 creates a decision log; seed it from this file when it is built.
