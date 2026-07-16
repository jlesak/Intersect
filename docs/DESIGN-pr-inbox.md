# Intersect - Design (Slice 2: PR Review Inbox)

> **Current-state supersession (2026-07-16, issues #32 and #33):** The locked-sandbox and
> fixed-Czech-prompt decisions preserved later in this historical design are no longer current.
> PR Review now launches the user's ordinary interactive Claude Code through the same login shell
> as Sessions, in the PR worktree. Claude therefore resolves from the user's shell and loads the
> standard user/project/local settings, CLAUDE.md files, skills, agents, plugins, hooks, MCP servers,
> and permissions. Intersect adds its local draft MCP config without strict mode or closed tool and
> setting-source restrictions. The initial prompt is configurable in Settings (the Czech guide is
> only the default). Claude records PR findings as local drafts; publishing to Azure DevOps still
> requires explicit human approval through Intersect.

Additive vertical slice over the MVP (see `DESIGN.md`). Consolidates Azure DevOps pull
requests where I am author or reviewer, renders their diffs (Monaco), and runs an
AI-assisted review as an isolated, guardrailed **classic (interactive) Claude Code session**
in a git worktree that drafts review comments I approve before they reach Azure DevOps.

This document is the implementation/review contract for the slice. It follows the established
patterns catalogued for the MVP (slice cookbook: `src/common` contract -> `src/main/db` repos +
migration -> `src/main/ipc` handler factory -> `src/preload` bridge -> `src/renderer/src/features/<slice>`
-> append to `app/registerFeatures.ts`). Only NEW decisions and the slice-specific pieces are
spelled out here.

Settled by the user (2026-07-06):
- **U1** Review runs as a **classic interactive Claude Code session** (spawned `claude` in a PTY),
  NOT headless `-p`. Guardrail is delivered via CLI flags; the draft-comment tool is a **standalone
  Intersect-owned stdio MCP server** process.
- **U2** The review worktree is built by **reusing an existing local clone** (a Intersect workspace
  folder whose git origin matches the PR's repo). No clone-on-demand. Assumes git is already
  authenticated to `devops.skoda.vwgroup.com`.
- **U3** During verification I **pause before any real publish** - the full flow is exercised live
  up to (but not through) posting a comment to a real PR; the real write happens only after an
  explicit go-ahead on a specific PR.

Environment facts (verified):
- ADO is **on-prem Azure DevOps Server** `https://devops.skoda.vwgroup.com/projects/SkodaAuto/`,
  default project `SPOT` (needs VPN). MCP server `@tiberriver256/mcp-server-azure-devops@0.1.46`,
  configured in `~/.claude.json` under `mcpServers.azureDevOps` (command `npx -y ...`, env carries
  `AZURE_DEVOPS_*` incl. the PAT). The same `AZURE_DEVOPS_*` vars are also in the shell env.
- `claude` v2.1.201 at `~/.local/bin/claude`; login via macOS Keychain (no `ANTHROPIC_API_KEY`).

---

## 1. Dependencies to add

| Package | Version | Where | Why |
|---|---|---|---|
| `monaco-editor` | `^0.55.1` | dependency (renderer) | side-by-side syntax-highlighted diff; used raw (no CDN loader) |
| `@modelcontextprotocol/sdk` | `^1.29.0` | dependency (main) | MCP **client** to the ADO server (read + publish) AND the draft **server** |

No React wrapper for Monaco (the `@monaco-editor/react` loader pulls from a CDN, which the
renderer CSP + offline packaging forbid). No `simple-git` (worktree ops are a thin `execFile`
helper). No `@anthropic-ai/claude-agent-sdk` (U1: we spawn the real `claude` CLI, not the SDK).

`electron.vite.config.ts` renderer block gains `worker: { format: 'es' }` (Monaco ESM workers).
The injected CSP `<meta>` gains `worker-src 'self' blob:` (Monaco worker instantiation under
`file://`); `script-src` stays `'self'`.

---

## 2. Domain model (append to `src/common/domain.ts`)

```ts
/** ADO reviewer vote, normalized from ADO's numeric vote codes. */
export const PR_VOTES = ['approved', 'approvedWithSuggestions', 'noVote', 'waiting', 'rejected'] as const
export type PrVote = (typeof PR_VOTES)[number]
// ADO code map: 10 approved, 5 approvedWithSuggestions, 0 noVote, -5 waiting, -10 rejected

export interface PrReviewer {
  id: string
  displayName: string
  vote: PrVote
  isRequired: boolean
}

/** My relationship to a PR (a PR can be both; author wins for display grouping). */
export const PR_ROLES = ['author', 'reviewer'] as const
export type PrRole = (typeof PR_ROLES)[number]

export interface PullRequest {
  prId: number
  repositoryId: string
  repositoryName: string
  projectId: string
  title: string
  authorId: string
  authorName: string
  createdAt: number          // epoch ms
  status: string             // 'active' (we only sync active)
  sourceRefName: string
  targetRefName: string
  url: string
  role: PrRole               // my relationship
  reviewers: PrReviewer[]
}

/** Which side of the diff a comment anchors to. Publishing supports 'right' only (ADO server). */
export const COMMENT_SIDES = ['left', 'right'] as const
export type CommentSide = (typeof COMMENT_SIDES)[number]

export const DRAFT_STATUSES = ['pending', 'approved', 'published', 'discarded'] as const
export type DraftStatus = (typeof DRAFT_STATUSES)[number]

export const DRAFT_SOURCES = ['claude', 'manual'] as const
export type DraftSource = (typeof DRAFT_SOURCES)[number]

/**
 * A review comment that has NOT reached Azure DevOps. Created either by the guardrailed Claude
 * session (via the draft MCP server) or by me manually on the diff. Only an explicitly approved
 * draft is published, under my identity, by Intersect's own code.
 */
export interface DraftComment {
  id: string
  prId: number
  repositoryId: string
  filePath: string
  line: number
  side: CommentSide
  body: string
  status: DraftStatus
  source: DraftSource
  reviewSessionId: string | null
  publishedThreadId: number | null
  createdAt: number
}

export const REVIEW_STATUSES = ['running', 'completed', 'failed', 'cleaned'] as const
export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

/** One AI review run bound to a git worktree. At most one is live at a time (non-goal: batch). */
export interface ReviewSession {
  id: string
  prId: number
  repositoryId: string
  repoDir: string          // the reused local clone
  worktreePath: string
  status: ReviewStatus
  createdAt: number
}

/** A changed file in a PR: unified-diff patch + both sides for Monaco. */
export interface PrChangeFile {
  path: string
  changeType: 'add' | 'edit' | 'delete' | 'rename'
  originalPath: string | null
}

/** An existing ADO comment thread (read-only display of prior review activity). */
export interface PrThread {
  threadId: number
  filePath: string | null
  line: number | null
  status: string
  comments: { authorName: string; body: string; publishedAt: number }[]
}
```

---

## 3. IPC contract (append to `src/common/ipc.ts`)

```ts
export interface IpcApi {
  // ...existing workspaces / tabs / terminal...
  prInbox: {
    sync(): Promise<PullRequest[]>                                   // fan-out fetch + cache, returns fresh list
    list(): Promise<PullRequest[]>                                   // from cache
    getChanges(repositoryId: string, prId: number): Promise<PrChangeFile[]>
    getFileDiff(repositoryId: string, prId: number, filePath: string):
      Promise<{ original: string; modified: string; language: string }>
    getThreads(repositoryId: string, prId: number): Promise<PrThread[]>
    listDrafts(repositoryId: string, prId: number): Promise<DraftComment[]>
    addManualDraft(input: Omit<DraftComment,'id'|'status'|'source'|'reviewSessionId'|'publishedThreadId'|'createdAt'>):
      Promise<DraftComment>
    editDraft(id: string, body: string): Promise<DraftComment>
    discardDraft(id: string): Promise<void>
    publishDraft(id: string): Promise<DraftComment>                  // THE guarded write (§8)
    startReview(repositoryId: string, prId: number): Promise<ReviewSession>
    endReview(): Promise<void>                                       // kill PTY + remove worktree
    // review terminal I/O (single live session)
    reviewInput(data: string): void
    reviewResize(cols: number, rows: number): void
    onReviewData(cb: (data: string) => void): () => void
    onReviewExit(cb: (exitCode: number) => void): () => void
  }
}
```

Channels appended to `Channel` as `'prInbox:<verb>'`. Review terminal uses dedicated channels
(`prInbox:reviewData`, `prInbox:reviewExit` broadcasts; `prInbox:reviewInput`, `prInbox:reviewResize`
fire-and-forget) - deliberately NOT the terminal slice's multiplexed `terminal:data` channel, so
the PR Inbox slice stays fully isolated from the terminal slice (§9 boundary).

---

## 4. Persistence (migration v2, `src/main/db/`)

Append `{ version: 2, up(db) {...} }` to `MIGRATIONS` (never edit v1). Tables:

```sql
CREATE TABLE pr_cache (
  repository_id  TEXT NOT NULL,
  pr_id          INTEGER NOT NULL,
  project_id     TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  title          TEXT NOT NULL,
  author_id      TEXT NOT NULL,
  author_name    TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  status         TEXT NOT NULL,
  source_ref     TEXT NOT NULL,
  target_ref     TEXT NOT NULL,
  url            TEXT NOT NULL,
  my_role        TEXT NOT NULL CHECK (my_role IN ('author','reviewer')),
  reviewers_json TEXT NOT NULL,           -- serialized PrReviewer[]
  synced_at      INTEGER NOT NULL,
  PRIMARY KEY (repository_id, pr_id)
);
CREATE TABLE draft_comment (
  id            TEXT PRIMARY KEY,
  pr_id         INTEGER NOT NULL,
  repository_id TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  line          INTEGER NOT NULL,
  side          TEXT NOT NULL CHECK (side IN ('left','right')),
  body          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','approved','published','discarded')),
  source        TEXT NOT NULL CHECK (source IN ('claude','manual')),
  review_session_id TEXT,
  published_thread_id INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_draft_pr ON draft_comment(repository_id, pr_id);
CREATE TABLE review_session (
  id            TEXT PRIMARY KEY,
  pr_id         INTEGER NOT NULL,
  repository_id TEXT NOT NULL,
  repo_dir      TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('running','completed','failed','cleaned')),
  created_at    INTEGER NOT NULL
);
```

Repos (factory pattern `createXRepo(db, {now,newId})`, message-only errors, deterministic tests):
- `prCacheRepo`: `replaceAll(prs)` (clear + insert in one `tx`, sets `synced_at`), `list()`, `get(repoId, prId)`.
- `draftCommentRepo`: `create(input)`, `listByPr(repoId, prId)`, `get(id)`, `setBody(id, body)`,
  `setStatus(id, status, publishedThreadId?)`, `remove(id)`.
- `reviewSessionRepo`: `create(...)`, `getActive()`, `setStatus(id, status)`, `remove(id)`.

**The standalone draft MCP server writes into `draft_comment` directly** (same `intersect.db`, WAL
allows the extra writer). It receives the DB path, review-session id, pr id, repo id via env. This
is also why drafts survive restart (PROMPT persistence requirement) for free.

---

## 5. ADO integration (main, `src/main/prInbox/`)

### 5.1 `adoClient.ts` - MCP client (read + publish)
Long-lived `@modelcontextprotocol/sdk` `Client` over `StdioClientTransport`, spawning the ADO
server from `resolveAdoServerConfig`: the `~/.claude.json` `mcpServers.azureDevOps` entry supplies
the launcher (command/args/env, incl. PAT), but each connection field (org URL, project, PAT) saved
in the app's Settings slice overrides it per-field, and `process.env.AZURE_DEVOPS_*` is the final
fallback. One persistent child; lazy connect on first use; `onclose`/`onerror` rebuild; saving
changed ADO settings drops the child so the next call reconnects with the fresh config; per-call
`{ timeout }`; `close()` on `before-quit`. Every tool result is a JSON text block -> `JSON.parse`.
A tiny `callTool(name, args)` wrapper is the seam tests mock.

### 5.2 `adoService.ts` - domain mapping + "my PRs" fan-out
- `getMyId()` = `get_me` -> user UUID (cached per process).
- `syncMyPrs()`:
  1. `list_repositories()` (optionally filtered by `INTERSECT_PR_REPOS` env = comma-sep repo names/ids
     - the escape hatch that keeps fan-out bounded without a config UI; default = all project repos).
  2. Per repo, two calls: `list_pull_requests(repositoryId, status:'active', creatorId:myId)` and
     `(..., reviewerId:myId)`. Bounded concurrency (the single stdio pipe serializes anyway; a small
     pool + spinner). Merge/dedupe by `(repositoryId, prId)`; `role='author'` if I'm the creator else
     `'reviewer'`.
  3. Map each to `PullRequest`; reviewers/votes from the PR payload (`mapVote(code)`).
- `getThreads` -> `get_pull_request_comments` -> `PrThread[]`.

Changed-file lists and per-file diffs no longer come from ADO; they are read from the local clone
(§5.3). `adoService` keeps only the fan-out sync, `getThreads`, and the guarded `publishComment`.
- `publishComment(repoId, prId, filePath, line, body)` -> `add_pull_request_comment(pullRequestId,
  content, repositoryId, filePath, lineNumber:line, status:'active')`. **Right side / single line
  only** (server limitation); returns the new `threadId`.

Pure `adoMapping.ts` (vote code -> `PrVote`, PR json -> `PullRequest`, dedupe/role) is unit-tested;
the client I/O is not.

### 5.3 `localDiff.ts` - diffs from the local clone (via `git.ts`)
Changed files and per-file diffs are computed locally against the reused clone, not fetched from
Azure DevOps. `git.ts` is a thin promisified `execFile('git', ['-C', repoDir, ...])` helper (no shell
-> no injection) with a lock-retry variant for the user's live clone. `createLocalDiffService`
resolves each PR to its clone once (cached `resolveRepoDir`, shared with the worktree matcher §6),
fetches the PR's source/target commits if not already present, then answers from git objects:
- `getChanges` -> `git diff --merge-base --name-status -M <targetCommit> <sourceCommit>` (three-dot,
  so target-side commits not part of the PR are excluded, matching the ADO web diff) -> `PrChangeFile[]`
  (path, changeType, originalPath for renames).
- `getFileDiff` -> resolve the merge base, then `git show <mergeBase>:<path>` (original side) and
  `git show <sourceCommit>:<path>` (modified side); `''` for the missing side of an add/delete, and
  a path that genuinely does not exist at that revision maps to `''`. Any other git failure surfaces
  rather than masking a wrong all-added/all-deleted diff. `language` = detected from path.
- Paths keep the ADO leading-slash convention (`/path`) so thread matching, comment badges, and draft
  publishing all key off the same shape; git commands strip the slash and set `core.quotePath=false`
  so non-ASCII paths round-trip.
- Binary (NUL heuristic) or oversize (either side over 512 KiB, or a blob past git's `maxBuffer`)
  content is withheld and flagged (`binary`/`tooLarge`) for a placeholder, never loaded into Monaco.

Requires a local clone: `resolveRepoDir` throws a clear "add a workspace" message when none matches,
which the detail pane surfaces as an inline **Diff unavailable** notice.

---

## 6. Git worktree (main, `src/main/prInbox/worktreeManager.ts`)

Thin promisified `execFile('git', ['-C', repoDir, ...])` helper (no shell -> no injection). Worktrees
live under `join(app.getPath('userData'), 'pr-review-worktrees')/<uuid>`.
- `resolveRepoDir(pr, workspaces)`: match the PR's repo to a workspace clone by normalized origin
  remote URL (`git -C <folder> remote get-url origin`, compare case-insensitively ignoring `.git`
  suffix and auth/user prefixes and http/ssh form). Returns the folder or throws a clear message
  ("No local clone found for <repo> - add a workspace pointing at a clone of it."). The URL
  normalization is a pure, unit-tested function.
- `createWorktree(repoDir, ref)`: try `rev-parse --verify ref^{commit}`; on miss `fetch --no-tags
  origin refs/pull/<prId>/merge` then use `FETCH_HEAD`; `worktree add --detach <path> <sha>`.
- `removeWorktree(path, repoDir)`: `worktree remove --force`; fallback `rm -rf`; `worktree prune`.
- `pruneStale(repoDirs)`: on boot, force-remove any registered worktree under our root + prune +
  nuke orphan dirs. The crash-safe guarantee. Uses `getActive()` review rows + the managed root.

---

## 7. AI review session (main, `src/main/prInbox/`)

### 7.1 `draftServer.ts` - the Intersect-owned MCP server (separate process)
A standalone entry (built as a second electron-vite main input -> `out/main/draftServer.js`) that
`@modelcontextprotocol/sdk` `Server` + `StdioServerTransport` exposes exactly one tool:

```
record_draft_comment(filePath: string, line: number, side: 'left'|'right', body: string)
```

Its handler opens `intersect.db` (path from `env.INTERSECT_DB_PATH`) and inserts a `draft_comment` row
(`source='claude'`, `status='pending'`, `review_session_id`/`pr_id`/`repository_id` from env). It has
**no Azure DevOps access whatsoever** - it cannot publish. The insert logic is a pure function
(`recordDraft(db, env, args)`) unit-tested against an in-memory DB.

### 7.2 `reviewSpawn.ts` - pure guardrail spec builder (unit-tested)
`buildReviewSpawnSpec({ claudePath, worktreePath, mcpConfigPath, prompt })` -> `{ file, args, cwd }`
with, verified against `claude --help`:
```
--mcp-config <mcpConfigPath> --strict-mcp-config
--allowed-tools "mcp__azureDevOps__get_pull_request mcp__azureDevOps__get_pull_request_changes
                 mcp__azureDevOps__get_pull_request_comments mcp__azureDevOps__get_file_content
                 mcp__intersectReview__record_draft_comment Read Grep Glob"
--disallowed-tools "mcp__azureDevOps__add_pull_request_comment
                    mcp__azureDevOps__update_pull_request_thread_status
                    mcp__azureDevOps__create_pull_request mcp__azureDevOps__update_pull_request
                    mcp__azureDevOps__create_branch mcp__azureDevOps__create_commit
                    Bash Write Edit"
--permission-mode dontAsk
--append-system-prompt "<read-only + draft-only instruction>"
<prompt>
```
Guardrail layers (defense in depth): `--strict-mcp-config` (only our two servers exist) + hard
`--disallowed-tools` on every ADO write + `--permission-mode dontAsk` (allowlisted approved, rest
denied without prompting) + system-prompt instruction. Publishing to ADO exists ONLY in Intersect's
`publishDraft` handler (§8), never reachable from the session.

### 7.3 `reviewManager.ts` - orchestration + single-session PTY
- `start(repoId, prId, deps)`: resolve repoDir -> create worktree -> write the mcp-config JSON
  (intersectReview: `node out/main/draftServer.js` with env; azureDevOps: cloned from `~/.claude.json`)
  to a temp path -> build spec -> spawn PTY (injected `spawn` seam, defaults to `nodePtySpawn` - the
  sanctioned node-pty wrapper; single live session) -> wire `onData -> prInbox:reviewData`,
  `onExit -> prInbox:reviewExit` + mark `completed` -> persist `review_session`.
- `input/resize/kill`; `end()` kills PTY + `removeWorktree` + status `cleaned`.
- cwd validation + env hygiene reuse the MVP's proven approach.

The initial prompt tells Claude: this is a read-only PR review of the checked-out worktree; use
the read-only ADO tools for PR context; record every comment via `record_draft_comment`; do not
attempt to publish.

---

## 8. Publish path (`publishDraft`, the guarded write)

`publishDraft(id)`:
1. Load draft; require `side === 'right'` (ADO server can only anchor right-side single-line) - else
   throw a clear message. Require status `pending`/`approved`.
2. `adoService.publishComment(repoId, prId, filePath, line, body)` -> `threadId`.
3. `draftCommentRepo.setStatus(id, 'published', threadId)`.

Only this handler ever calls an ADO write tool. **Verification (U3): I will not invoke this against a
real PR without an explicit go-ahead on a specific PR id.**

---

## 9. Renderer slice (`src/renderer/src/features/prInbox/`) + the one shell change

Standard slice: `ipc.ts` (thin seam), `store.ts` (status/byId/order + selectedPrId + drafts + review
state, write-through + `reportError`), `register.ts`, `index.ts` barrel, `components/`.

Components:
- `PrList.tsx` (sidebar `component`): synced PRs grouped author/reviewer; each row title, author,
  created date, reviewer votes (colored chips); a **Sync** button (manual, no polling).
- `PrInboxView.tsx` (`mainComponent`): master-detail for the selected PR - changed-file list ->
  `DiffViewer` (Monaco side-by-side) -> existing threads (read-only) -> **drafts panel** (approve /
  edit / discard per draft, inline on the diff via a Monaco view zone) -> **Review with Claude Code**
  button -> `ReviewTerminal` (xterm) when a session is live.
- `DiffViewer.tsx`: raw `monaco.editor.createDiffEditor`, `renderSideBySide`, read-only, dark; view
  zones + glyph decorations to pin draft-comment cards on lines (right side).
- `ReviewTerminal.tsx`: a single xterm bound to the `prInbox:review*` channels (own tiny controller +
  pure data buffer; does NOT import the terminal slice).
- `DraftCard.tsx`: body (editable), source badge (Claude/manual), Approve/Edit/Discard.

`register.ts`: `registerSidebarSection({ id:'prInbox', order:1, label:'PR Review', icon:IconInbox,
component: PrList, mainComponent: PrInboxView })` + commands `prInbox.sync`, `prInbox.review`.

### The shell change (the single allowed edit outside the slice)
The MVP `App.tsx` renders the FIRST section with a `mainComponent` and has no way to switch. Adding a
second main-owning section forces introducing **active-section state** into the app shell:
- `app/shellStore.ts`: tiny zustand `{ activeSectionId, setActiveSection }`, defaulting to the first
  registered section that has a `mainComponent`.
- `Sidebar.tsx`: render an icon rail (one button per section, highlighting the active one, driven by
  `getSidebarSections()` + `shellStore`) plus the **active** section's `component` below (instead of
  stacking all).
- `App.tsx`: render the active section's `mainComponent`.
- `registerFeatures.ts`: append `registerPrInboxFeature()`. `main.tsx`: append
  `void usePrInboxStore.getState().hydrate()` (loads cached PRs; no network at boot).

This realizes the `mainComponent` seam the MVP explicitly reserved for this slice. It touches only
app-shell files (composition root), never another feature slice.

---

## 10. Boundary & isolation compliance

- No feature slice is modified. The terminal slice is untouched: the review terminal has its own
  minimal PTY manager (main) + xterm controller (renderer) + dedicated channels. The only shared
  main-side reuse is `nodePtySpawn` (the sanctioned node-pty seam) and `tx`/`RepoDeps`/`openDatabase`
  DB infra - shared infrastructure, not a sibling slice.
- Cross-slice reads (matching a PR repo to a workspace folder) go through the `@renderer/features/
  workspaces` barrel on the renderer side and `workspaceRepo` on the main side - no internal imports.
- `node-pty` import stays confined to `nodePtySpawn.ts` (lint rule holds).
- Manifests appended: `common/ipc.ts`, `common/domain.ts`, `migrations.ts`, `main/index.ts` wireIpc,
  `preload/index.ts`, `app/registerFeatures.ts`, `main.tsx`, and the second build input for
  `draftServer.js`. All append-only.

---

## 11. Test plan (TDD - pure/logic units; PTY/Monaco/live-MCP are E2E/manual per PROMPT)

Vitest (node project unless noted):
1. `adoMapping.test.ts`: vote code -> `PrVote`; PR json -> `PullRequest`; author/reviewer dedupe + role.
2. `prCacheRepo.test.ts`: `replaceAll` clears + inserts + stamps `synced_at`; `list`/`get`.
3. `draftCommentRepo.test.ts`: create; `listByPr`; status transitions incl. `published`+threadId;
   `setBody`; `remove`; CHECK rejects bad side/status/source.
4. `reviewSessionRepo.test.ts`: create/getActive/setStatus/remove.
5. `worktreeMatch.test.ts`: remote-URL normalization + matching (https/ssh/PAT-embedded/.git forms).
6. `reviewSpawn.test.ts`: `buildReviewSpawnSpec` emits strict-mcp-config, exact allow/deny tool sets,
   dontAsk, cwd - the guardrail is asserted without spawning.
7. `draftServer.test.ts`: `recordDraft(db, env, args)` inserts a pending Claude draft against an
   in-memory DB.
8. `prInbox.ipc.test.ts`: handlers with injected fake `adoService`/`reviewManager`/`worktree`: `sync`
   caches + returns; `listDrafts`; `addManualDraft`; `publishDraft` calls `publishComment` + marks
   published; `publishDraft` on a left-side draft throws; `discardDraft`; `startReview` resolves the
   repo (fake) and returns a session; `startReview` with no matching clone throws.
9. `store.test.ts` (dom): `vi.mock('./ipc')`; hydrate/sync/select/draft-action status + write-through.
10. `migrations.test.ts`: v2 tables + CHECK constraints exist; idempotent re-run to v2.

E2E / manual (needs VPN + real ADO): sync a real PR list; open a diff (Monaco renders side-by-side);
start a review (worktree created, claude spawns in it, records a draft via the tool); approve a draft
-> **pause before real post** (U3). Report explicitly what couldn't be verified live.

---

## 12. Build sequence

1. Deps + config (monaco, mcp sdk, vite worker format, CSP worker-src, second build input). (commit)
2. TDD contracts + migration v2 + repos (§2,§4,§11.1-4,10). (commit)
3. TDD ADO mapping + adoClient/adoService (client I/O manual). (commit)
4. TDD worktreeManager (match + lifecycle) + reviewSpawn spec + draftServer. (commit)
5. TDD prInbox IPC handlers + reviewManager + preload + main wiring. (commit)
6. Monaco integration (workers/config) + DiffViewer. (commit)
7. Renderer slice store/components + the shell active-section change + register. (commit)
8. Adversarial code review -> fix. (commit)
9. Run app + E2E/manual live verification (pause before publish); finalize. (commit)

---

## 13. Known limitations / accepted trade-offs

- **Publish anchoring**: ADO MCP server only anchors a new thread to the RIGHT side, single line,
  offset 1. Left-side / multi-line / column anchoring is out (would need the raw ADO REST API).
  Draft UI + the draft tool steer to right-side line comments; `publishDraft` rejects left-side.
- **"My PRs" fan-out** is O(repos) serialized through one MCP stdio pipe; a manual Sync with a
  spinner. `INTERSECT_PR_REPOS` bounds scope without a config UI.
- **Packaged-app follow-ups** (not blocking dev verification): the draft MCP server + Monaco workers
  must be `asarUnpack`ed / bundled; `claude` login via Keychain may need re-auth under the packaged
  app identity. Tracked, not solved in this slice's dev milestone.

---

## 14. Design-review reconciliation (adopted - OVERRIDES sections above where they differ)

An adversarial three-lens review (requirements/guardrail-security, architecture/boundary/build,
correctness/robustness) raised findings; the following are adopted as the authoritative delta.

### 14.1 Guardrail: the review session gets NO Azure DevOps server at all (security blocker)
The earlier plan handed the session the full `azureDevOps` MCP server (13 write tools) and relied on
an enumerated `--disallowed-tools` list. That list was incomplete (missed `create_work_item`,
`update_work_item`, `trigger_pipeline`, `create_wiki_page`, `manage_work_item_link`,
`create_commit`, ...) and, worse, the effective allowlist is silently widened by ambient
`~/.claude/settings.json` `permissions.allow` rules (verified live: `WebFetch(domain:*)` and
`WebSearch` leak into a `dontAsk` session). Adopted:
- **The session's `--mcp-config` contains ONLY the `intersectReview` draft server.** The ADO server is
  not present, so no ADO write tool exists in the session at all. This is exactly decision #2's
  "dedicated, local, Intersect-owned MCP server ... no Azure DevOps access at all."
- **PR context is injected, not fetched by the session.** Intersect writes a `REVIEW_CONTEXT.md` into
  the worktree (PR title, description, author, changed-file list, existing threads) fetched via
  Intersect's own client. The session reviews the checked-out code with `Read`/`Grep`/`Glob` + that
  file. No `get_file_content`/`get_pull_request*` tools needed.
- **Pin setting sources** so ambient allow rules cannot widen the session: pass `--setting-sources`
  restricted to sources Intersect controls (verify empirically that ambient `user` allow rules -
  `WebFetch`/`WebSearch` - are denied in the resulting session; do NOT use `--bare`, which forces
  `ANTHROPIC_API_KEY` and breaks the Keychain login).
- `buildReviewSpawnSpec` allowlist becomes `Read Grep Glob mcp__intersectReview__record_draft_comment`;
  `--disallowed-tools "Bash Write Edit"` kept as belt only; guarantee rests on strict-mcp-config +
  the closed allowlist + the ADO server's absence.
- **The guardrail is verified empirically, not just by asserting the flag string:** the verification
  plan adds a live negative check - the running session is told to publish a comment / read
  `~/.claude.json` and reach the network, and each is confirmed impossible. `--permission-mode
  dontAsk` and the tool-list delimiter are confirmed against `claude` v2.1.201 before relying on them.
- **Temp mcp-config** is written `0600` and deleted on session end; it carries no PAT (no ADO server).

### 14.2 Draft capture via a Unix-domain socket to main (not a second DB writer)
The draft MCP server does NOT open `intersect.db`. Instead `reviewManager` creates a UDS under
`userData` (path passed to the draft server via `INTERSECT_DRAFT_SOCK`); `record_draft_comment` connects
and sends the draft JSON; **main is the single SQLite writer** (`draftCommentRepo.create`) and
immediately **broadcasts `prInbox:draftAdded` to the renderer** so drafts appear live during the
review. This removes the two-writer `SQLITE_BUSY`/busy-timeout surface and closes the live-refresh
gap. The unit-tested pure unit becomes `handleDraftMessage(repo, sessionCtx, payload)` (socket
payload -> repo create); the draft server itself is thin I/O. New channel `prInbox:draftAdded`
(broadcast) + `onDraftAdded(cb)` in `IpcApi.prInbox`.

### 14.3 Diff from the local clone (three-dot merge-base), with edge-case handling
Superseded the original ADO-content plan: changed files and per-file diffs are read from the reused
local clone via `localDiff.ts` + the `git.ts` helper (§5.3), not from `get_pull_request_changes` /
`get_file_content`.
- `getChanges` uses `git diff --merge-base --name-status -M <targetCommit> <sourceCommit>` for the
  file list + `changeType` (+ `originalPath` for renames) - three-dot, so target-side commits not in
  the PR are excluded, matching the ADO web diff.
- `getFileDiff` reads full sides from git objects: modified = `git show <sourceCommit>:<path>`,
  original = `git show <mergeBase>:<path>` (merge base of target and source, so the left side is the
  PR's baseline rather than the target tip). Requires the commits locally; they are fetched on demand
  when absent.
- Edge cases: `add` -> original = `''` (no read); `delete` -> modified = `''` (no read); a path that
  genuinely does not exist at that revision -> `''`, while any other git failure surfaces instead of
  masking a wrong all-added/all-deleted diff; **binary** files (NUL heuristic) and files over the size
  cap (or past git's `maxBuffer`) render a placeholder in the UI, never loaded into Monaco.

### 14.4 Fan-out correctness
- **Pagination**: `list_pull_requests` defaults `top=10`; loop `skip += top` (top=100) until a page
  returns `< top`, for both the `creatorId` and `reviewerId` queries. No silent truncation.
- **Partial-failure tolerance**: fan-out uses `Promise.allSettled`; a forbidden/offline repo does not
  abort the whole sync. `replaceAll` runs only if at least one repo succeeded; failed repos are
  surfaced as a partial-result warning. On total failure the existing cache is kept (not nuked).
- **Identity**: `get_me` UUID is used for `creatorId`/`reviewerId`; verified against real Server data
  that reviewer/creator ids match, with a client-side fallback matching the reviewer/creator
  sub-object if the Server's identity id differs.

### 14.5 Publish path is race- and partial-failure-safe (writes to production)
`DRAFT_STATUSES` gains `'publishing'`. `publishDraft`:
1. Validate `side==='right'`, and validate `filePath`/`line` against the PR's actual changed files
   (reject hallucinated anchors).
2. **Atomic claim**: `UPDATE draft_comment SET status='publishing' WHERE id=? AND status IN
   ('pending','approved')`; proceed only if a row was affected (rejects double-approve / TOCTOU).
3. Call `add_pull_request_comment(...)`; **log the returned `threadId` before** the DB update.
4. `setStatus(id,'published',threadId)`. On a step-4 failure the logged threadId + `publishing`
   status let a retry detect the already-published comment instead of re-posting.
On a step-3 ADO failure, revert status to `pending`.

### 14.6 Review-session lifecycle robustness
- **Single-session enforced**: `startReview` rejects with a clear message if `getActive()` returns a
  running session (non-goal: batch review). The review terminal is a single broadcast channel pair.
- **Exit mapping**: a non-zero PTY exit marks the session `failed`, not `completed`.
- **cwd/ref**: primary ref is the concrete source commit SHA from the PR payload
  (`lastMergeSourceCommit`); `refs/pull/<id>/merge` is best-effort only (on-prem ADO Server does not
  reliably expose merge refs). Fetch that SHA then `worktree add --detach`.
- **Reused clone contention**: `fetch`/`worktree add` into the user's live clone can hit
  `index.lock` if the user is mid-git-op; retry-on-lock with a short backoff, and surface a clear
  message rather than a raw git error. Startup `pruneStale` reclaims worktrees under the managed root
  even if the owning clone/workspace was removed (rm the dir; prune the clone only if still present).
- **Drafts outlive the PR cache**: `replaceAll` on sync must not delete `draft_comment` rows; a PR
  that merged away keeps its drafts (no orphan cascade). (Reaching them in the UI when the PR is gone
  is out of scope; they are retained, not surfaced.)

### 14.7 MCP client lifecycle
Lazy connect guarded by a single shared in-flight promise (no double-spawn on `onclose`+lazy-call
race). A per-call timeout forces a reconnect (drops the wedged child), not just a rejected promise.
Track the child PID and kill the process group on `before-quit` (npx spawns a grandchild that can
orphan).

### 14.8 draftServer build/runtime
- `draftServer.ts` is a second electron-vite **main** input -> `out/main/draftServer.js`; the
  mcp-config references it by **absolute** path (Claude spawns MCP servers with cwd = worktree, so a
  relative path fails).
- `@modelcontextprotocol/sdk` is **bundled** into the main outputs (not externalized) to avoid the
  ESM-only-vs-CJS-`require` pitfall and the packaged-`node_modules`-in-asar problem; only Node
  builtins + `electron` stay external. `draftServer.ts` must never import `electron` (runs under
  plain `node`) and, per 14.2, never `node:sqlite`.
- Pure, node-vitest-importable modules (`adoMapping`, `worktreeMatch` URL-normalize,
  `buildReviewSpawnSpec`, `handleDraftMessage`) live in `electron`-free / MCP-SDK-free files so the
  node test project can import them without dragging in `electron`/the ESM SDK (same discipline as
  `shell.ts` being node-pty-free).

### 14.9 Shell change: preserve live terminals across section switch
Switching the active section must not kill running terminals. The MVP keeps xterm instances in a
module-level Map disposed only on tab delete, but this must be verified: if unmounting `WorkspaceView`
(when switching to PR Review) triggers `disposeSession`, terminals die. Verified approach - if
unmount is not safe, the shell renders the active `mainComponent` while keeping the workspaces view
mounted-but-hidden (CSS) rather than unmounting. `shellStore` (zustand) is a conscious, better
substitute for the "app-shell local state" the MVP §16.2 anticipated. This remains a
composition-root-only change (no feature slice edited); it is a deviation from the MVP's "register a
section, zero shell edits" wording because the section-switching logic was never built - surfaced,
not hidden.

### 14.10 Misc
- Add an `IconInbox` to the shared UI kit for the sidebar section.
- CSP `worker-src 'self' blob:` must be verified under `file://` in a packaged build (dev has no CSP
  meta); Monaco module-worker loading under `sandbox:true` is the risk to confirm.
- Manual drafts are **forced to `side:'right'`** at creation in the UI (a left-gutter click cannot
  produce an unpublishable draft), matching the publish constraint.

---

## 15. Implementation-review reconciliation (applied) + verification

A three-lens adversarial review of the implemented code (guardrail-security, main-integration
correctness, renderer) plus live probes drove these fixes (all applied):

**Guardrail (security):**
- The review session's `--allowed-tools` is a closed allowlist and `--setting-sources ''` was
  **empirically confirmed** to load no ambient settings (an ambient `WebSearch` allow is denied).
  Hardened further: `--disallowed-tools` now also blocks every egress/subagent tool
  (`WebFetch`, `WebSearch`, `Task`, `NotebookEdit`) so a prompt-injected session cannot exfiltrate
  what it reads; a `--settings` `permissions.deny` list blocks reads of credential files
  (`.claude.json`, `.ssh`, `.aws`, `.gnupg`, `.netrc`, `.config`, `.npmrc`, `/etc`); and the spawn
  env strips `AZURE_DEVOPS_*` + any `PAT|TOKEN|SECRET|PASSWORD` key (keeping `ANTHROPIC_/CLAUDE_`
  for auth). **Empirically verified** with the exact emitted flags: reading `~/.claude.json` is
  DENIED, `WebFetch` is unavailable, and a legitimate worktree read still succeeds - no secret
  leaked. Residual (documented follow-up, not blocking dev): reads are not fully OS-sandboxed to the
  worktree; a determined injection could read some non-denied on-disk file into model context, but
  it cannot reach the network and every draft is human-reviewed before publish. A future hardening
  is to run `claude` inside an OS sandbox (seatbelt) rooted at the worktree with no network.

**Main correctness:**
- **Quit race fixed:** `reviewManager.shutdown()` is synchronous and DB-free; `before-quit` calls it
  before `db.close()`, and the async PTY-exit handler is neutered by a `disposed` flag, so no write
  hits a closed DB.
- **Concurrent `startReview` fixed:** a synchronous `starting` guard (plus the `live` check) closes
  the interleave window the DB `getActive()` check alone left open.
- **Partial-start rollback:** `start()` now rolls back the worktree/socket/config and marks the
  session `failed` on any failure after worktree creation, so a transient error can't wedge the
  feature with an orphaned `running` row.
- **Socket hardening:** per-connection `error` handler (a peer reset on kill can't crash main) and
  the socket file is `chmod 0600`.
- **Publish is now genuinely exactly-once:** on an ADO-write failure the claim is released to
  `pending`; on a post-success-but-bookkeeping-failure the draft is NOT reverted (which would
  double-post) - the thread id is logged and a clear error is surfaced.
- **Diff fidelity:** `fetchContent` only maps a genuine not-found to an empty side; transient errors
  surface instead of silently rendering an all-added/all-deleted diff. Pagination has a hard cap.

**Renderer:**
- **Review terminal output persists** across section switches and captures from spawn time: output
  is buffered in the store (subscribed at module scope, before spawn) and the xterm replays the
  buffer on (re)mount - fixing both lost-scrollback-on-switch and the dropped initial banner.
- `openFile`/`select` stale-response guards key on the selected PR (no cross-PR clobber, no toast for
  an abandoned PR, `allSettled` so one failed sub-load doesn't blank the pane); `DraftCard` disables
  publish while in flight; PR rows are keyboard-selectable.

**Verification performed:**
- 200 unit/integration tests (repos, ADO mapping, worktree matching, guardrail spec, draft handler,
  IPC handlers incl. the publish race/left-side/file-not-in-PR paths), node+web typecheck, lint,
  and a full production build (Monaco workers bundle; the second `draftServer.js` entry emits and
  loads under plain `node`).
- **Draft-capture path** verified in isolation end-to-end (MCP client -> draftServer -> Unix socket
  -> payload with the session id).
- **Guardrail** verified empirically against `claude` v2.1.201 with the real flags.
- **Deterministic E2E** (Playwright `_electron`): the slice registers, the rail switches to it and
  back, and its Monaco-importing view renders with zero renderer console errors.
- **Live E2E against real on-prem ADO** (`INTERSECT_LIVE_E2E=1`, gated/skipped by default): synced 2
  real PRs, loaded a PR's 50 changed files, and rendered the real side-by-side Monaco diff.
- **Not verified live (by design):** starting an actual Claude review in a worktree (needs a local
  clone registered as a workspace; the spawn spec + worktree lifecycle + draft path are unit/smoke
  tested) and publishing a drafted comment to a real PR (deliberately not exercised - U3).
