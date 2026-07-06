# Build "PR Review Inbox" — Jarvis Slice 2

## Context and Vision

Jarvis's MVP (workspace & terminal manager) is done. This prompt scopes the next vertical
slice: a **PR Review Inbox** that consolidates Azure DevOps pull requests you're involved in,
and lets you run an AI-assisted code review via Claude Code without leaving the app or
disturbing your active working directory.

This slice is additive: follow the existing vertical-slice architecture (`src/renderer/src/features/<slice>`,
one main-process IPC module per slice, `src/common` for cross-process contracts, registries for
sidebar/commands) exactly as established for `workspaces`/`tabs`/`terminal`. No existing slice
should need to change except the app-level composition root (registering the new slice).

## Business Requirements

### PR list
- Show all pull requests in the configured Azure DevOps org/project where I am **author or
  reviewer** (active PRs).
- Each entry shows: title, author, created date, and review status (who has reviewed, their
  vote — approved / approved-with-suggestions / waiting / rejected).
- Refresh is manual (a "Sync" action) — no background polling.

### PR detail
- Clicking a PR opens a detail view showing the code diff, rendered like Azure DevOps's own
  diff view (side-by-side, syntax highlighted).
- I can add my own manual review comments directly on the diff, same as I would in the ADO web
  UI.

### AI-assisted review
- From the PR detail, I can trigger "Review with Claude Code."
- The review runs against an isolated **git worktree** for that PR so it never interferes with
  whatever I'm working on in other tabs/workspaces.
- Claude reviews the PR's changes and proposes review comments anchored to specific lines in
  the diff.
- Proposed comments are **drafts only** — they never reach Azure DevOps automatically.
- I review each proposed comment individually: approve as-is, edit, or discard.
- Only comments I explicitly approve are published to the PR, posted **under my own identity**
  (via my Azure DevOps PAT), through the same Azure DevOps integration already configured on
  this machine.

## Key Technical Decisions (settled — implementer decides the rest)

1. **Reuse the existing `azureDevOps` MCP server** (`@tiberriver256/mcp-server-azure-devops`,
   already configured globally for Claude Code with org/project/PAT) as the **sole integration
   point with Azure DevOps** — for listing PRs, fetching diffs/threads, and publishing approved
   comments. Do not hand-roll a separate ADO REST client or PAT storage; Jarvis's main process
   connects to it as an MCP client for the read paths, and reuses the same server/config to
   publish comments after my approval.
2. **Guardrail against unapproved writes**: the Claude Code review session must never be able
   to call the `azureDevOps` server's write tools (e.g. posting comments, changing thread
   status) directly — that would bypass my approval step. Enforce this with (a) a dedicated,
   local, Jarvis-owned MCP server exposed only to the review session, whose only capability is
   recording a *draft* comment (no Azure DevOps access at all), and (b) an explicit system-prompt
   instruction restricting the review session to read-only Azure DevOps tools plus that draft
   tool. All actual publishing to Azure DevOps happens only from Jarvis's own code, only after my
   explicit approval of a specific draft.
3. **Isolation**: each AI review runs in its own git worktree, created/cleaned up by Jarvis, so
   it never touches the working tree of any open workspace/tab.
4. **Diff rendering**: use Monaco's diff editor for both the plain PR detail view and inline
   display of Claude's proposed comments.
5. **Sync model**: manual refresh, no background polling/webhooks.
6. **Scope of PRs shown**: author or reviewer, within the org/project already configured for the
   `azureDevOps` MCP server (no separate multi-repo config UI needed for this slice unless the
   implementer finds the existing config insufficient).
7. **Persistence**: follows the existing `node:sqlite` pattern (one repo module, migrations
   appended to the existing migration list) — cache fetched PRs and store draft comments locally
   so review state survives restarts before publishing.
8. **Extensibility seam**: use the existing sidebar registry's `mainComponent` field (already
   added for this exact purpose) to mount the PR Inbox as a new sidebar section — no changes to
   the app shell itself.

## Non-Goals (explicitly out of scope for this slice)

- Background polling / webhooks / notifications for new PRs.
- Approving/voting on PRs (the ADO "approve" action itself) — only comment authoring.
- Multi-repo / multi-org configuration UI.
- Editing or resolving *other people's* existing review threads beyond posting new comments.
- Batch review across multiple PRs at once.
- Any other future slice (My Work/Today aggregator, time tracking, command palette).

## Quality Bar and Process

- Follow the same TDD discipline used for the MVP slices: business logic (draft comment
  lifecycle, repo/persistence, worktree bookkeeping) is unit-tested; PTY/Claude session behavior
  and Monaco diff rendering are verified manually/E2E, consistent with the existing test plan
  approach.
- Keep the slice isolated per the existing lint-enforced boundary rules.
- Run the app end-to-end and verify: sync a real PR list, open a diff, trigger a Claude review in
  a worktree, approve a drafted comment, confirm it's posted to the actual PR in Azure DevOps.
  Report explicitly if any step couldn't be verified live.
