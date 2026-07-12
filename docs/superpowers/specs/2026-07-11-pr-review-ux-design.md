# PR Review UX - local diffs, injected review guide, persistent review session

Approved 2026-07-11 via brainstorming interview.

## Goal

Make the PR Review workflow fast and fit the single-user, worktree-based process:

1. **Local diffs** - render diffs from the local git clone instead of fetching each file's content
   from Azure DevOps (today: two REST content calls per file, lazily per click). We already clone
   the repos and check branches out into worktrees, so the commits are (or can cheaply be made)
   local.
2. **Czech, styled review comments** - the AI review session writes its draft comments in Czech:
   short, factual, well-formatted markdown, no severity labels, one comment per changed line.
3. **A versioned review guide** the app always injects into the review session - the review
   methodology for this tool, not a Claude Code skill file (the sandbox forbids that).
4. **Persistent, navigable review session** - "End review" stops being the primary action. While a
   review runs, the user freely switches between the terminal and the drafted changes, leaves to
   the board and comes back, and continues prompting the same session. The session ends only on an
   explicit, demoted "Ukončit review" (or app quit).
5. **Defer foreign comments** - existing ADO threads no longer load on PR open; they load lazily
   when the Overview tab is first opened.

Guiding principle: speed on the hot path (open PR -> see diffs) and a review session that behaves
like a workspace, not a modal takeover.

## Current behavior (baseline)

- **Diff:** opening a PR calls `getChanges` (ADO `get_pull_request_changes`); each file click calls
  `getFileDiff`, which fetches both sides via `get_file_content` (`fetchContent`). Network roundtrip
  per file - the slow point. Diff semantics are two-dot (target tip vs source tip).
- **Worktree:** created only at `startReview`; the diff never uses it.
- **Review session:** `claude` spawned in a locked sandbox (`--strict-mcp-config`, closed
  `--allowed-tools` = `Read/Grep/Glob/mcp__intersectReview__record_draft_comment`,
  `--setting-sources ''`, `--permission-mode dontAsk`, deny-read globs). Drafts arrive over a local
  unix socket. `REVIEW_PROMPT` / `REVIEW_SYSTEM_PROMPT` are English and say nothing about comment
  language or style.
- **Run UX:** while `review.status === 'running'`, `PrDetail` hides everything and shows only
  `ReviewTerminal` plus a red primary `End review`. Drafts are visible only outside the run, in the
  Files tab.
- **Foreign comments:** `getThreads` (ADO) runs on every PR open; Overview tab + `ThreadCard` +
  FileTree comment indicators consume it.

## Design

### 1. Local diff engine

**Shared git helper.** Extract `git()` and `gitWithLockRetry()` from `worktreeManager.ts` into a new
`src/main/prInbox/git.ts`; both `worktreeManager` and the new diff module import them. No behavior
change to the extracted helpers.

**New module `src/main/prInbox/localDiff.ts`** exposing a `LocalDiffService`:

- `resolveRepoDir(repoName, workspaceFolders)` - reuse the existing clone-matching logic (move the
  shared bits or delegate to `worktreeManager`'s resolver).
- `prepareDiff(pr, workspaceFolders)` - resolve the repo dir and ensure both `sourceCommitId` and
  `targetCommitId` are present in the object DB. When a commit is missing, one
  `git fetch --no-tags origin <sourceRefName>` (and the target ref if needed), reusing
  `gitWithLockRetry`. Returns the resolved `repoDir`. Idempotent and cheap once the commits exist.
- `getChanges(repoDir, pr)` -> `PrChangeFile[]` from
  `git diff --merge-base --name-status -M <targetCommit> <sourceCommit>`. Parse status codes
  (`A/M/D/R###`) to `changeType` (`add/edit/delete/rename`) and fill `originalPath` for renames.
- `getFileDiff(repoDir, pr, filePath, change)` -> `FileDiff`:
  - `mergeBase = git merge-base <targetCommit> <sourceCommit>`.
  - `original` = `git show <mergeBase>:<originalPath|filePath>` (empty for `add`).
  - `modified` = `git show <sourceCommit>:<filePath>` (empty for `delete`).
  - Keep the existing binary / `MAX_DIFF_BYTES` guards and `langFromPath`.

**Diff semantics change (deliberate):** move from two-dot to **three-dot (merge-base)** so the diff
shows only what the PR introduced relative to the merge base - matching the ADO web UI and removing
unrelated target-side noise. Documented here because it changes what the reviewer sees.

**Caching.** The IPC handler caches the resolved `repoDir` per `prKey` after the first `prepareDiff`,
so subsequent file diffs are pure local git with no fetch.

**No local clone.** When `resolveRepoDir` finds no clone, `getChanges`/`prepareDiff` throw a
typed, user-facing error. The detail view renders a clear message ("Repozitář není naklonovaný -
přidej jeho složku jako workspace") instead of a diff. No ADO diff fallback - the slow ADO diff path
is removed.

**Removed / rewired:**
- `adoService`: delete `getChanges`, `getFileDiff`, and `fetchContent` (and the `get_file_content`
  usage for diffs). The ADO service keeps threads, comments, votes, and PR listing.
- IPC handlers `getChanges` / `getFileDiff` call the `LocalDiffService`.
- Both other `getChanges` callers switch to the local changes list:
  - `buildReviewContext` (review context markdown at `startReview`),
  - `publishDraft` path-validation ("draft anchors to a file changed in this PR").

### 2. Review guide + Czech comments

**New `src/main/prInbox/reviewGuide.ts`** exporting a `REVIEW_GUIDE` string constant (Czech) - the
versioned review methodology for this tool. A compiled-in constant (not a runtime-read `.md`) so it
bundles cleanly in dev and prod and is unit-testable without path resolution. The app:

- injects it via `--append-system-prompt` (replaces the inline `REVIEW_SYSTEM_PROMPT` constant),
- writes it into the worktree as `REVIEW_GUIDE.md`, and `REVIEW_PROMPT` references it in Czech.

Guide content (the rules the session must follow):
- Reviewuj změny v tomto worktree; kontext a seznam souborů je v `REVIEW_CONTEXT.md`.
- Komentáře piš **česky**, stručně a věcně, v markdownu, **bez štítků závažnosti**, bez omáček.
- Jeden `record_draft_comment` na jeden komentář, ukotvený na řádek **RIGHT (nové)** strany.
- Read-only: nic nepublikuj, needituj, nespouštěj - jediný výstup k člověku je přes
  `record_draft_comment`.

Sandbox flags (`REVIEW_ALLOWED_TOOLS`, `REVIEW_DISALLOWED_TOOLS`, `REVIEW_DENY_READ_GLOBS`,
`--strict-mcp-config`, `--setting-sources ''`, `--permission-mode dontAsk`) are unchanged.

### 3. Persistent, navigable review session

Decouple "a review is running" from "what the detail shows".

**Store additions:**
- `reviewView: 'terminal' | 'changes'` - which face of a running review is shown.
- `reviewPrKey: string | null` - the PR whose session is live (survives `goBack`).
- `goBack()` no longer touches the review; the session and its buffer persist.
- `endReview()` stays the only teardown (plus app-quit `shutdown`).

UI chrome stays in English to match the rest of the app (only Claude's review comments are Czech).

**PrDetail header while running:**
- Segmented toggle **`Terminal | Changes`**. `Changes` shows a badge = draft count; the badge appears
  / bumps as drafts arrive. Starting a review defaults to `Terminal`.
- Primary idle action `Zkontrolovat s Claude Code` is replaced by the toggle while running.
- `End review` is demoted from red primary to a quiet ghost action, shown in the terminal view.

**Views while running:**
- `Terminál` -> `ReviewTerminal` (interactive; user keeps prompting the same session).
- `Změny` -> the existing Files layout (`FileTree` + `DiffViewer` + `DraftCard`s), so the user reads
  the drafts against the diff and switches back to the terminal to continue.

**Leaving to the board:** the session stays alive. `PrCard` for `reviewPrKey` shows a `● reviewing`
indicator; clicking the PR reopens the live terminal (the global `reviewOutput` buffer replays the
full history, as it does today on remount).

**Boundary (explicit):** continuing in the terminal means more *read-only* review prompts - the
sandbox is read-only. Handing off to a full read/write Claude session that fixes code is out of
scope for this work.

**Concurrency:** still one live review at a time. Starting a review while one runs is blocked with a
clear Czech message (existing guard), now more reachable because sessions persist across navigation.

### 4. Lazy foreign comments

- Remove `getThreads` from `select()`; PR open no longer waits on it.
- Load threads when the Overview tab is first opened for a PR (lazy), tracked by a
  `threadsLoaded`/`threadsLoading` flag keyed to the selection; a manual refresh re-fetches.
- FileTree comment indicators populate once threads are loaded (absent until then).
- `ThreadCard`, Overview, composer, reply/resolve stay as-is.

### 5. Cleanup and tests

- Delete the dead ADO diff path; extract `git.ts`; rewire callers.
- Tests (Vitest + integration where behavior demands it, per house rule "reproduce first"):
  - `localDiff` integration over a throwaway git repo: add / edit / delete / rename, binary,
    too-large, three-dot semantics, missing-clone error.
  - `git.ts` helper parity with the previous inline helpers.
  - `reviewSpawn` includes the injected guide in the spawn spec / system prompt.
  - review context + `publishDraft` validation use the local changes list.
  - store: `reviewView` toggle, `reviewPrKey` set on start / cleared on end, session + buffer
    survive `goBack`, draft-count badge source.
  - lazy threads: `select()` issues no `getThreads`; opening Overview triggers exactly one load.

## Non-goals

- No language setting - Czech is hardcoded in the guide (single-user, Czech developer).
- No ADO diff fallback for non-cloned repos.
- No write-capable / fix-applying review handoff.
- No change to the sandbox security model, PR listing, votes, or comment publishing.

## Success criteria

- Opening a PR and clicking through files renders diffs from local git with no per-file ADO call;
  only the first open may fetch once.
- Review drafts arrive in Czech, short, unlabeled, line-anchored, valid markdown.
- A running review survives switching Terminál/Změny and leaving to the board; it ends only via
  `Ukončit review` or app quit; the board shows which PR is under review.
- Overview threads load only when the Overview tab is opened.
- `npm run typecheck`, `npm test`, `npm run lint` pass.
