# PR Review redesign - board, ADO-like detail, interactive threads

Approved 2026-07-10 via Lavish review session (`.lavish/pr-review-redesign.html`).

## Goal

Rework the PR Review module UX to mirror Azure DevOps pull requests: the PR list moves out of
the sidebar into the main area as a three-column action board, the PR detail gets Overview/Files
tabs, changed files render as a collapsible directory tree, existing ADO comment threads show
inline in the diff and on a single Overview page, and commenting happens through an inline
composer instead of the "Comment on cursor line" button + `window.prompt()`.

Guiding principle: function over form - the board is the morning worklist; every review action
(comment, reply, resolve, vote) works without leaving the app.

## Current problems

- The PR list lives in the sidebar under the module menu; the menu will grow with future modules
  and the list is cramped and unreadable there.
- "Changed files" is a flat list with truncated paths - no orientation in 30+ file PRs.
- "Existing threads" is a flat section below the diff mixing ADO system messages ("Policy status
  has been updated") with real comments, disconnected from the code they refer to.
- "Comment on cursor line" is a two-step toolbar button that opens `window.prompt()`.
- Threads are read-only; replying or resolving requires the browser.

## Design

### Navigation model

```
Sidebar "PR Review" (+ badge = count of PRs needing my action)
  -> BOARD (main area, 3 columns of PR cards)
     -> click card -> DETAIL (fills the main area; breadcrumb "<- Pull requests" + Esc go back)
        -> tab Files (default) | tab Overview
```

- The sidebar PR list (`PrList`) is removed. The sidebar section registers no body component
  (`SidebarSection.component` becomes optional); the rail button shows a badge with the count of
  PRs in the "needs my action" column.
- While a "Review with Claude Code" session runs, the detail area shows the terminal as today.

### Board

Three columns read left-to-right as a pipeline (do -> wait -> done):

1. **Vyžaduje mou akci** - I am a reviewer and have not voted, or the author pushed new changes
   since my vote (`newChangesSinceMyReview`); OR I am the author and a reviewer voted
   Rejected/Waiting for author, or the PR has unresolved non-system threads.
2. **Čeká na ostatní** - everything else.
3. **Schváleno** - every reviewer vote is approved/approvedWithSuggestions (at least one
   reviewer).

Classification is a pure function `boardColumn(pr): 'action' | 'waiting' | 'approved'` in
`src/common` so the renderer and tests share it.

Card contents: title, author, repository, relative age, role badge (Reviewer/Author), a **reason
chip** explaining the column ("bez tvého hlasu", "nové změny od tvého review", "2 nevyřešené
komentáře", "čeká na NR, KM"), and reviewer vote rings (green approved, yellow waiting, red
rejected). Board header keeps the Sync button + last-sync time; background sync unchanged.

### Detail - Files tab (default)

- Left: compact collapsible directory tree built from the flat change paths. Single-child
  directory chains merge into one row (`src/Skoda.Spot.Api/Features/Planning`). Everything starts
  expanded; a collapsed directory shows the count of files inside. Files show a change-type badge
  (A/M/D) and the count of unresolved comments.
- Right: the existing side-by-side Monaco diff.
- Existing ADO threads render inline as view zones under their anchor line: full conversation,
  status tag (Active/Resolved), Reply input, Resolve/Reactivate button. React content is rendered
  into the zones via portals (extension of the mechanism drafts already use).
- New comment: hovering a line number shows a "+"; clicking opens an inline composer zone under
  the line (textarea, Ctrl+Enter saves, Esc cancels). The toolbar button and `window.prompt()`
  are removed.
- The "Draft comments" section (Claude + manual drafts pending publication) stays below the diff.

### Detail - Overview tab

All PR threads on one page, ADO-style:

- Filter: **Active** (default) / All / Resolved / Mine.
- File-level threads show a `path:line` chip; clicking it switches to Files, opens the file and
  reveals the line. PR-level threads show a "PR-level" chip.
- Each thread: full conversation, Reply input, Resolve/Reactivate.
- "+ PR-level komentář" composer at the top.
- System threads (vote changes, policy updates - `commentType != text`) are hidden everywhere.

### Publish flow (decision)

Manually written comments and replies publish to ADO immediately under my identity (exact ADO
behaviour, one step). The draft pipeline (pending -> approve -> publish) remains exclusively the
guardrail for Claude-generated comments. Resolve/Reactivate is a direct action.

### Data & backend changes

- `PrThread.isSystem` mapped from ADO comment `commentType` (fallback: a thread with no file
  context and `commentType != text` is treated as system).
- `PullRequest.activeThreadCount` - unresolved non-system threads, computed during sync.
  `syncMyPrs` fetches threads for all PRs in parallel; a single PR's failure degrades only its
  count (0 + warning), never the whole sync.
- New `adoService` methods over the existing ADO MCP server (capabilities verified):
  - `replyToThread(repositoryId, prId, threadId, body)` -> `add_pull_request_comment` with
    `threadId`.
  - `setThreadStatus(repositoryId, prId, threadId, status)` -> `update_pull_request_thread_status`
    (active/fixed).
- New IPC channels for reply + set-thread-status, wired through preload and the renderer API.

## Implementation phases

1. **Domain + enriched sync** - `isSystem`, `activeThreadCount`, `boardColumn()` + unit tests
   (role x votes x new-changes x threads matrix); parallel thread fetch in `syncMyPrs`; e2e stub
   data extended.
2. **Reply + resolve in main** - `adoService` methods, IPC channels, preload, renderer API +
   tests. Mutations return the fresh thread list.
3. **Board + navigation** - store `view: 'board' | 'detail'`, column selector, `PrBoard`/`PrCard`
   components, sidebar body removal (optional `component` in the registry), rail badge, Esc +
   breadcrumb navigation.
4. **Detail skeleton + file tree** - `PrDetail` (header, tabs, votes, Claude review + terminal),
   `FileTree` with pure tree-building logic (`fileTree.ts`) + unit tests.
5. **Diff inline threads + composer** - `ThreadZone`, `CommentComposer` view zones with React
   portals; remove "Comment on cursor line".
6. **Overview tab** - `OverviewTab` + shared `ThreadCard`, filter, cross-tab navigation to a
   file line, PR-level composer.
7. **E2E + cleanup** - rewrite `e2e/prInbox.spec.ts`, `e2e/prvote.spec.ts` over `adoE2eStub`,
   new scenarios (board columns, tree, inline thread, reply, resolve, composer); delete dead code
   (`PrList`, old threads section). E2E runs only after explicit user approval.

## Risks

| Risk | Mitigation |
| --- | --- |
| Slower sync (one threads request per PR over MCP stdio) | Parallel fetch; per-PR failure degrades only that PR's count |
| Interactive React content in Monaco view zones (focus, zone height) | Portals + content-driven height recompute; drafts already use view zones |
| `commentType` mapping may differ across ADO versions | Conservative fallback + unit tests on real payloads |
| Large e2e selector churn | Dedicated phase 7; `data-testid` on all new components from the start |

## Out of scope (deliberately later)

ADO Updates/Commits tabs, code-snippet context above Overview threads, board filters by
repository.
