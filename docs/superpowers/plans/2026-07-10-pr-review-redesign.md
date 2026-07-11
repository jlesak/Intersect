# PR Review Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the PR Review module UX as an ADO-like experience: action board in the main area, detail with Files/Overview tabs, collapsible file tree, inline diff threads with reply/resolve, inline comment composer.

**Architecture:** Data enrichment flows main -> renderer: sync additionally fetches every PR's threads to compute `activeThreadCount`; a pure `boardColumn()` in `src/common` classifies PRs into three columns. New IPC channels expose immediate comment/reply/resolve (manual comments skip the draft pipeline; drafts remain the Claude guardrail). The renderer swaps the sidebar list for a main-area board + detail view; Monaco view zones host React content via portals.

**Tech Stack:** Electron (main/preload/renderer), TypeScript, zustand, monaco-editor, node:sqlite, vitest, Playwright e2e over `adoE2eStub`.

**Spec:** `docs/superpowers/specs/2026-07-10-pr-review-redesign-design.md`

## Global Constraints

- NEVER `git commit` - stage only (`git add`). The user commits himself. Each task's final step stages files.
- UI copy is English (matches existing "Approve", "Sync", "Draft comments").
- No em dashes in copy or comments; plain dash.
- Do not rewrite existing comments; new doc comments describe business meaning.
- New components get `data-testid` attributes from the start (phase 7 e2e depends on them).
- E2E/UAT app-launching runs require the user's explicit approval first; unit tests (`npx vitest run`) may run freely. Typecheck: `npm run typecheck` (verify script name in package.json before first use; fall back to `npx tsc --noEmit -p tsconfig.web.json` / node config if absent).
- Vote enum values (`PrVote`): `approved | approvedWithSuggestions | waiting | rejected | noVote`.

---

### Task 1: Domain types + `boardColumn()` classification

**Files:**
- Modify: `src/common/domain.ts` (PrThread, PullRequest)
- Create: `src/common/prBoard.ts`
- Test: `src/common/prBoard.test.ts`

**Interfaces:**
- Produces: `PrThread.isSystem: boolean`; `PullRequest.activeThreadCount: number`; `boardColumn(pr: PullRequest): BoardColumn` with `type BoardColumn = 'action' | 'waiting' | 'approved'`; `boardReason(pr: PullRequest): string | null`; `isThreadUnresolved(t: PrThread): boolean`.
- Every later task takes these names as given.

- [ ] **Step 1: Extend domain types**

In `src/common/domain.ts`, extend `PrThread` (line ~210) and `PullRequest` (line ~104):

```ts
/** An existing ADO comment thread (prior review activity, replies and resolution included). */
export interface PrThread {
  threadId: number
  filePath: string | null
  line: number | null
  status: string
  /** True for ADO housekeeping threads (vote changes, policy updates); hidden from every view. */
  isSystem: boolean
  comments: { authorName: string; body: string; publishedAt: number }[]
}
```

On `PullRequest`, after `newChangesSinceMyReview`:

```ts
  /**
   * Unresolved, non-system comment threads counted at the last sync. Drives the author-side
   * "needs my action" board signal; 0 when the thread fetch for this PR failed.
   */
  activeThreadCount: number
```

- [ ] **Step 2: Write the failing tests**

`src/common/prBoard.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import type { PrReviewer, PullRequest } from './domain'
import { boardColumn, boardReason, isThreadUnresolved } from './prBoard'

const reviewer = (vote: PrReviewer['vote'], name = 'R'): PrReviewer => ({
  id: name,
  displayName: name,
  vote,
  isRequired: false
})

const pr = (over: Partial<PullRequest>): PullRequest => ({
  prId: 1,
  repositoryId: 'repo',
  repositoryName: 'repo',
  projectId: 'p',
  title: 't',
  authorId: 'a',
  authorName: 'A',
  createdAt: 0,
  status: 'active',
  sourceRefName: 'refs/heads/f',
  targetRefName: 'refs/heads/main',
  sourceCommitId: 's',
  targetCommitId: 't',
  url: 'u',
  role: 'reviewer',
  myVote: null,
  myReviewerId: null,
  reviewers: [],
  newChangesSinceMyReview: false,
  activeThreadCount: 0,
  ...over
})

describe('boardColumn', () => {
  test('reviewer without a vote needs action', () => {
    expect(boardColumn(pr({ role: 'reviewer', myVote: null }))).toBe('action')
    expect(boardColumn(pr({ role: 'reviewer', myVote: 'noVote' }))).toBe('action')
  })

  test('reviewer with new changes since their vote needs action', () => {
    expect(
      boardColumn(pr({ role: 'reviewer', myVote: 'approved', newChangesSinceMyReview: true }))
    ).toBe('action')
  })

  test('reviewer who voted and is caught up waits', () => {
    expect(boardColumn(pr({ role: 'reviewer', myVote: 'waiting' }))).toBe('waiting')
  })

  test('author with a rejected or waiting vote needs action', () => {
    expect(boardColumn(pr({ role: 'author', reviewers: [reviewer('rejected')] }))).toBe('action')
    expect(boardColumn(pr({ role: 'author', reviewers: [reviewer('waiting')] }))).toBe('action')
  })

  test('author with unresolved threads needs action', () => {
    expect(boardColumn(pr({ role: 'author', activeThreadCount: 2 }))).toBe('action')
  })

  test('author waiting on reviews waits', () => {
    expect(boardColumn(pr({ role: 'author', reviewers: [reviewer('noVote')] }))).toBe('waiting')
    expect(boardColumn(pr({ role: 'author', reviewers: [] }))).toBe('waiting')
  })

  test('every reviewer approved -> approved (author view)', () => {
    expect(
      boardColumn(
        pr({ role: 'author', reviewers: [reviewer('approved'), reviewer('approvedWithSuggestions', 'S')] })
      )
    ).toBe('approved')
  })

  test('every reviewer approved -> approved (reviewer view, my vote in)', () => {
    expect(
      boardColumn(pr({ role: 'reviewer', myVote: 'approved', reviewers: [reviewer('approved')] }))
    ).toBe('approved')
  })

  test('author with unresolved threads stays action even when all approved', () => {
    expect(
      boardColumn(pr({ role: 'author', activeThreadCount: 1, reviewers: [reviewer('approved')] }))
    ).toBe('action')
  })
})

describe('boardReason', () => {
  test('explains the action column', () => {
    expect(boardReason(pr({ role: 'reviewer', myVote: null }))).toBe('no vote yet')
    expect(
      boardReason(pr({ role: 'reviewer', myVote: 'approved', newChangesSinceMyReview: true }))
    ).toBe('new changes since your review')
    expect(boardReason(pr({ role: 'author', reviewers: [reviewer('rejected')] }))).toBe(
      'review response needed'
    )
    expect(boardReason(pr({ role: 'author', activeThreadCount: 2 }))).toBe('2 unresolved comments')
    expect(boardReason(pr({ role: 'author', activeThreadCount: 1 }))).toBe('1 unresolved comment')
  })

  test('explains waiting, silent on approved', () => {
    expect(
      boardReason(pr({ role: 'author', reviewers: [reviewer('noVote', 'Marek Kral')] }))
    ).toBe('waiting for Marek Kral')
    expect(boardReason(pr({ role: 'reviewer', myVote: 'approved' }))).toBe('voted')
    expect(boardReason(pr({ role: 'author', reviewers: [reviewer('approved')] }))).toBeNull()
  })
})

describe('isThreadUnresolved', () => {
  test('active and pending are unresolved; fixed, closed, wontFix are not', () => {
    const t = (status: string) => ({
      threadId: 1,
      filePath: null,
      line: null,
      status,
      isSystem: false,
      comments: []
    })
    expect(isThreadUnresolved(t('active'))).toBe(true)
    expect(isThreadUnresolved(t('pending'))).toBe(true)
    expect(isThreadUnresolved(t('fixed'))).toBe(false)
    expect(isThreadUnresolved(t('closed'))).toBe(false)
    expect(isThreadUnresolved(t('wontFix'))).toBe(false)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/common/prBoard.test.ts`
Expected: FAIL (module `./prBoard` not found). Existing suites will also fail to typecheck where `PullRequest`/`PrThread` literals miss the new fields - that is Step 5's cleanup.

- [ ] **Step 4: Implement `src/common/prBoard.ts`**

```ts
import type { PrThread, PullRequest } from './domain'

/**
 * Which board column a PR belongs to. The board reads left to right as a pipeline:
 * do (action) -> wait (waiting) -> done (approved).
 */
export type BoardColumn = 'action' | 'waiting' | 'approved'

const APPROVING = new Set(['approved', 'approvedWithSuggestions'])

/** A thread that still asks for a reaction (ADO statuses `active` and `pending`). */
export function isThreadUnresolved(thread: PrThread): boolean {
  return thread.status === 'active' || thread.status === 'pending'
}

/**
 * Classify a PR by what it needs from me. As reviewer I owe a vote (or a re-review after new
 * pushes); as author I owe a reaction to negative votes or unresolved comments. A PR whose
 * reviewers all approved is done.
 */
export function boardColumn(pr: PullRequest): BoardColumn {
  if (pr.role === 'reviewer') {
    if (!pr.myVote || pr.myVote === 'noVote') return 'action'
    if (pr.newChangesSinceMyReview) return 'action'
  } else {
    if (pr.reviewers.some((r) => r.vote === 'rejected' || r.vote === 'waiting')) return 'action'
    if (pr.activeThreadCount > 0) return 'action'
  }
  if (pr.reviewers.length > 0 && pr.reviewers.every((r) => APPROVING.has(r.vote))) {
    return 'approved'
  }
  return 'waiting'
}

/** The chip on a board card explaining why the PR sits in its column; null when self-evident. */
export function boardReason(pr: PullRequest): string | null {
  const column = boardColumn(pr)
  if (column === 'action') {
    if (pr.role === 'reviewer') {
      if (!pr.myVote || pr.myVote === 'noVote') return 'no vote yet'
      return 'new changes since your review'
    }
    if (pr.reviewers.some((r) => r.vote === 'rejected' || r.vote === 'waiting')) {
      return 'review response needed'
    }
    return `${pr.activeThreadCount} unresolved comment${pr.activeThreadCount === 1 ? '' : 's'}`
  }
  if (column === 'waiting') {
    if (pr.role === 'reviewer') return 'voted'
    const pending = pr.reviewers.filter((r) => !APPROVING.has(r.vote)).map((r) => r.displayName)
    if (pending.length === 0) return null
    const shown = pending.slice(0, 2).join(', ')
    return `waiting for ${shown}${pending.length > 2 ? ` +${pending.length - 2}` : ''}`
  }
  return null
}
```

- [ ] **Step 5: Fix compile fallout across existing code and tests**

Every place constructing a `PullRequest` literal gains `activeThreadCount: 0`; every `PrThread` literal gains `isSystem: false`. Known sites (verify with `npm run typecheck` and `grep -rln "newChangesSinceMyReview" src e2e`):

- `src/main/prInbox/adoMapping.ts` - `mapPullRequest` return object: add `activeThreadCount: 0` (enriched later in `syncMyPrs`).
- `src/main/db/prCacheRepo.ts` - `toPr`: add `activeThreadCount: 0` for now (Task 2 adds the real column).
- `src/main/prInbox/adoService.ts` - `toThread`: add `isSystem: false` for now (Task 3 maps it).
- `src/main/prInbox/adoE2eStub.ts` - `basePr` gains `activeThreadCount: 0`.
- Test fixtures: `src/renderer/src/features/prInbox/store.test.ts`, `src/main/ipc/prInbox.ipc.test.ts`, `src/main/prInbox/adoMapping.test.ts`, `src/main/prInbox/reviewWatermark.test.ts`, `src/main/prInbox/worktreeMatch.test.ts` (wherever literals fail to compile).

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run src/common/prBoard.test.ts` -> PASS.
Run: `npm run typecheck` -> clean.
Run: `npx vitest run` -> full unit suite green.

- [ ] **Step 7: Stage**

```bash
git add src/common/domain.ts src/common/prBoard.ts src/common/prBoard.test.ts src/main src/renderer e2e
```

---

### Task 2: Persist `activeThreadCount` in the PR cache

**Files:**
- Modify: `src/main/db/migrations.ts` (new migration, version 11)
- Modify: `src/main/db/prCacheRepo.ts`
- Test: `src/main/db/migrations.test.ts`, `src/main/db/prCacheRepo.test.ts` (extend existing suites; create the repo test file only if it does not exist - check first)

**Interfaces:**
- Consumes: `PullRequest.activeThreadCount` from Task 1.
- Produces: `pr_cache.active_thread_count INTEGER NOT NULL DEFAULT 0` column; `PrCacheRepo` round-trips the field.

- [ ] **Step 1: Write failing test**

In `src/main/db/migrations.test.ts`, follow the existing per-version test pattern (read neighbors first) and add:

```ts
test('v11 adds pr_cache.active_thread_count with default 0', () => {
  const db = openWith(11)
  const cols = db.prepare(`PRAGMA table_info(pr_cache)`).all() as { name: string }[]
  expect(cols.map((c) => c.name)).toContain('active_thread_count')
})
```

(Adapt `openWith` to whatever helper the file actually uses - mirror the v10 test verbatim.)

Also extend the pr cache repo round-trip test (in its existing test file) so a stored PR with `activeThreadCount: 3` lists back with 3.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/db` -> new assertions FAIL.

- [ ] **Step 3: Implement migration + repo mapping**

`migrations.ts` - append after version 10, same shape as neighbors:

```ts
  {
    version: 11,
    up(db) {
      db.exec(`ALTER TABLE pr_cache ADD COLUMN active_thread_count INTEGER NOT NULL DEFAULT 0;`)
    }
  }
```

`prCacheRepo.ts`:
- `PrRow` gains `active_thread_count: number`.
- `toPr` maps `activeThreadCount: row.active_thread_count ?? 0` (replace the Task 1 stub).
- `replaceAll` INSERT adds the column and one more `?`; `stmt.run` passes `pr.activeThreadCount`.
- If `updateVote` rewrites whole rows, keep it untouched (it updates columns in place).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/db` -> PASS. Then `npm run typecheck`.

- [ ] **Step 5: Stage**

```bash
git add src/main/db/migrations.ts src/main/db/migrations.test.ts src/main/db/prCacheRepo.ts src/main/db/*.test.ts
```

---

### Task 3: ADO service - system threads, status normalization, sync enrichment

**Files:**
- Modify: `src/main/prInbox/adoService.ts`
- Modify: `src/main/prInbox/adoE2eStub.ts`
- Test: `src/main/prInbox/adoService.test.ts` (create)

**Interfaces:**
- Consumes: `isThreadUnresolved` from `@common/prBoard`.
- Produces: `toThread` maps `isSystem` + normalizes numeric statuses to `active|fixed|wontFix|closed|byDesign|pending`; `syncMyPrs` returns PRs with real `activeThreadCount`.

- [ ] **Step 1: Write failing tests**

`src/main/prInbox/adoService.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import type { AdoClient } from './adoClient'
import { createAdoService } from './adoService'

/** Fake MCP client answering from a canned tool->result map (functions get the args). */
function fakeClient(handlers: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>): AdoClient {
  return {
    async callTool(name, args) {
      if (!(name in handlers)) throw new Error(`Unexpected tool call: ${name}`)
      const h = handlers[name]
      return (typeof h === 'function' ? (h as (a: Record<string, unknown>) => unknown)(args) : h) as never
    },
    async close() {}
  }
}

const deps = (client: AdoClient) => ({
  client,
  resolveIdentity: async () => ({ id: 'me-uuid', displayName: 'Me', uniqueName: 'me@x' }),
  projectId: () => 'SPOT',
  resolveVoteCredentials: () => ({ orgUrl: 'https://o', pat: 'p' })
})

describe('getThreads', () => {
  test('maps system threads and normalizes numeric status', async () => {
    const svc = createAdoService(
      deps(
        fakeClient({
          get_pull_request_comments: {
            value: [
              {
                id: 1,
                status: 1,
                threadContext: { filePath: '/a.cs', rightFileStart: { line: 4 } },
                comments: [{ author: { displayName: 'X' }, content: 'real', commentType: 'text' }]
              },
              {
                id: 2,
                status: 'unknown',
                comments: [{ author: { displayName: 'Sys' }, content: 'Policy status updated', commentType: 'system' }]
              }
            ]
          }
        })
      )
    )
    const threads = await svc.getThreads('repo', 7)
    expect(threads[0]).toMatchObject({ threadId: 1, status: 'active', isSystem: false, line: 4 })
    expect(threads[1]).toMatchObject({ threadId: 2, isSystem: true })
  })
})

describe('syncMyPrs thread enrichment', () => {
  const rawPr = {
    pullRequestId: 9,
    title: 'T',
    status: 'active',
    createdBy: { id: 'other', displayName: 'O' },
    reviewers: [{ id: 'me-uuid', displayName: 'Me', vote: 0 }],
    repository: { id: 'repo-1', name: 'repo', project: { id: 'SPOT' } },
    sourceRefName: 'refs/heads/f',
    targetRefName: 'refs/heads/main'
  }

  test('counts unresolved non-system threads per PR', async () => {
    const svc = createAdoService(
      deps(
        fakeClient({
          list_repositories: [{ id: 'repo-1', name: 'repo' }],
          list_pull_requests: (args) => ({ value: args.reviewerId ? [rawPr] : [] }),
          get_pull_request_comments: {
            value: [
              { id: 1, status: 'active', comments: [{ content: 'c', commentType: 'text' }] },
              { id: 2, status: 'fixed', comments: [{ content: 'c', commentType: 'text' }] },
              { id: 3, status: 'active', comments: [{ content: 's', commentType: 'system' }] }
            ]
          }
        })
      )
    )
    const { prs } = await svc.syncMyPrs()
    expect(prs).toHaveLength(1)
    expect(prs[0].activeThreadCount).toBe(1)
  })

  test('a failing thread fetch degrades to 0 without failing the sync', async () => {
    const svc = createAdoService(
      deps(
        fakeClient({
          list_repositories: [{ id: 'repo-1', name: 'repo' }],
          list_pull_requests: (args) => ({ value: args.reviewerId ? [rawPr] : [] }),
          get_pull_request_comments: () => {
            throw new Error('boom')
          }
        })
      )
    )
    const { prs } = await svc.syncMyPrs()
    expect(prs[0].activeThreadCount).toBe(0)
  })
})
```

Note: check `AdoRawPullRequest` in `adoMapping.ts` for the exact raw field names (`pullRequestId` vs `codeReviewId` etc.) and adjust the fixture so `mapPullRequest` accepts it - read `adoMapping.ts` before writing the fixture.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/prInbox/adoService.test.ts` -> FAIL (no `commentType` mapping, no enrichment).

- [ ] **Step 3: Implement in `adoService.ts`**

Raw shape + mapper:

```ts
interface RawThread {
  id?: number
  threadId?: number
  status?: string | number
  threadContext?: { filePath?: string; rightFileStart?: { line?: number } }
  comments?: Array<{
    author?: AdoPerson
    content?: string
    publishedDate?: string
    commentType?: string
  }>
}

/** ADO wire codes for thread status; strings pass through unchanged. */
const THREAD_STATUS_BY_CODE: Record<number, string> = {
  1: 'active',
  2: 'fixed',
  3: 'wontFix',
  4: 'closed',
  5: 'byDesign',
  6: 'pending'
}

function toThread(raw: RawThread): PrThread {
  const comments = raw.comments ?? []
  return {
    threadId: raw.id ?? raw.threadId ?? 0,
    filePath: raw.threadContext?.filePath ?? null,
    line: raw.threadContext?.rightFileStart?.line ?? null,
    status:
      typeof raw.status === 'number'
        ? (THREAD_STATUS_BY_CODE[raw.status] ?? String(raw.status))
        : (raw.status ?? 'unknown'),
    // ADO marks housekeeping comments (vote/policy updates) with a non-text commentType.
    isSystem: comments.length > 0 && comments.every((c) => (c.commentType ?? 'text') !== 'text'),
    comments: comments.map((c) => ({
      authorName: c.author?.displayName ?? '',
      body: c.content ?? '',
      publishedAt: c.publishedDate ? Date.parse(c.publishedDate) : 0
    }))
  }
}
```

Extract the thread fetch into an inner function so both `getThreads` and the sync share it:

```ts
  async function fetchThreads(repositoryId: string, prId: number): Promise<PrThread[]> {
    const raw = await d.client.callTool<{ value?: RawThread[] } | RawThread[]>(
      'get_pull_request_comments',
      { repositoryId, pullRequestId: prId, projectId: d.projectId() }
    )
    const threads = Array.isArray(raw) ? raw : (raw.value ?? [])
    return threads.map(toThread)
  }
```

In `syncMyPrs`, before `return`, enrich (import `isThreadUnresolved` from `@common/prBoard`):

```ts
      const merged = mergeMyPrs(prs)
      // Thread counts feed the board's author-side "needs my action" signal. One PR's failure
      // must not fail the sync; that PR just reads as having no unresolved comments this round.
      const enriched = await Promise.all(
        merged.map(async (pr) => {
          try {
            const threads = await fetchThreads(pr.repositoryId, pr.prId)
            const count = threads.filter((t) => !t.isSystem && isThreadUnresolved(t)).length
            return { ...pr, activeThreadCount: count }
          } catch (err) {
            console.warn(`Thread fetch failed for PR ${pr.prId} in ${pr.repositoryName}`, err)
            return pr
          }
        })
      )
      return { prs: enriched, failedRepos }
```

`getThreads` delegates to `fetchThreads`. Remove the Task 1 `isSystem: false` stub.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/prInbox` -> PASS. `npm run typecheck` -> clean.

- [ ] **Step 5: Stage**

```bash
git add src/main/prInbox/adoService.ts src/main/prInbox/adoService.test.ts
```

---

### Task 4: Reply + resolve + immediate comment (main, IPC, preload, renderer API)

**Files:**
- Modify: `src/main/prInbox/adoService.ts` (two new methods)
- Modify: `src/common/domain.ts` (`NewPrComment`, `PrThreadStatusInput` types)
- Modify: `src/common/ipc.ts` (3 channels + `IpcApi.prInbox` methods)
- Modify: `src/main/ipc/prInbox.ipc.ts` (handlers + registration)
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/features/prInbox/ipc.ts`
- Modify: `src/main/prInbox/adoE2eStub.ts` (in-memory thread mutations)
- Test: `src/main/ipc/prInbox.ipc.test.ts` (extend), `src/main/prInbox/adoService.test.ts` (extend)

**Interfaces:**
- Produces on `AdoService`:
  - `replyToThread(input: { repositoryId: string; prId: number; threadId: number; body: string }): Promise<void>`
  - `setThreadStatus(input: { repositoryId: string; prId: number; threadId: number; status: 'active' | 'fixed' }): Promise<void>`
- Produces on `IpcApi['prInbox']` (each returns the fresh thread list so the UI never guesses):
  - `addComment(input: NewPrComment): Promise<PrThread[]>`
  - `replyToThread(repositoryId: string, prId: number, threadId: number, body: string): Promise<PrThread[]>`
  - `setThreadStatus(repositoryId: string, prId: number, threadId: number, status: 'active' | 'fixed'): Promise<PrThread[]>`
- Domain: `interface NewPrComment { repositoryId: string; prId: number; filePath: string | null; line: number | null; body: string }` (null path = PR-level comment).

- [ ] **Step 1: Write failing service tests** (extend `adoService.test.ts`)

```ts
describe('thread mutations', () => {
  test('replyToThread posts into the thread', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const svc = createAdoService(
      deps(
        fakeClient({
          add_pull_request_comment: (args) => {
            calls.push({ name: 'add_pull_request_comment', args })
            return { id: 5 }
          }
        })
      )
    )
    await svc.replyToThread({ repositoryId: 'repo', prId: 7, threadId: 42, body: 'hi' })
    expect(calls[0].args).toMatchObject({ pullRequestId: 7, threadId: 42, content: 'hi' })
  })

  test('setThreadStatus updates the thread status', async () => {
    const calls: Array<Record<string, unknown>> = []
    const svc = createAdoService(
      deps(fakeClient({ update_pull_request_thread_status: (args) => (calls.push(args), {}) }))
    )
    await svc.setThreadStatus({ repositoryId: 'repo', prId: 7, threadId: 42, status: 'fixed' })
    expect(calls[0]).toMatchObject({ pullRequestId: 7, threadId: 42, status: 'fixed' })
  })
})
```

And failing handler tests (extend `prInbox.ipc.test.ts`, mirroring its existing fake-`AdoService` pattern - read the file's fixtures first and reuse them):

```ts
test('addComment publishes immediately and returns fresh threads', async () => {
  // fake ado.publishComment resolves 77; fake ado.getThreads returns one thread
  const h = makeHandlers(/* existing helper */)
  const threads = await h.addComment({ repositoryId: 'r', prId: 1, filePath: '/a.cs', line: 3, body: 'b' })
  expect(adoCalls.publishComment).toMatchObject({ filePath: '/a.cs', line: 3, body: 'b' })
  expect(threads).toHaveLength(1)
})

test('replyToThread and setThreadStatus return fresh threads', async () => {
  const h = makeHandlers()
  await h.replyToThread('r', 1, 42, 'reply')
  expect(adoCalls.replyToThread).toMatchObject({ threadId: 42, body: 'reply' })
  await h.setThreadStatus('r', 1, 42, 'fixed')
  expect(adoCalls.setThreadStatus).toMatchObject({ threadId: 42, status: 'fixed' })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/prInbox/adoService.test.ts src/main/ipc/prInbox.ipc.test.ts` -> FAIL.

- [ ] **Step 3: Implement**

`adoService.ts` (interface + impl):

```ts
  /** Post a reply into an existing thread, immediately and under my identity. */
  replyToThread(input: { repositoryId: string; prId: number; threadId: number; body: string }): Promise<void>
  /** Resolve or reactivate a thread ('fixed' | 'active'). */
  setThreadStatus(input: { repositoryId: string; prId: number; threadId: number; status: 'active' | 'fixed' }): Promise<void>
```

```ts
    async replyToThread(input) {
      await d.client.callTool('add_pull_request_comment', {
        pullRequestId: input.prId,
        repositoryId: input.repositoryId,
        projectId: d.projectId(),
        threadId: input.threadId,
        content: input.body
      })
    },

    async setThreadStatus(input) {
      await d.client.callTool('update_pull_request_thread_status', {
        pullRequestId: input.prId,
        repositoryId: input.repositoryId,
        projectId: d.projectId(),
        threadId: input.threadId,
        status: input.status
      })
    },
```

`publishComment` also needs to accept a PR-level comment (`filePath: null`): make `filePath`/`line` nullable in its input and omit `filePath`/`lineNumber` keys from the tool args when null. Existing draft publish keeps passing non-null values.

`src/common/domain.ts`:

```ts
/** A comment written by me in the app and published to ADO immediately (no draft step). */
export interface NewPrComment {
  repositoryId: string
  prId: number
  /** Null anchors the comment to the PR itself instead of a file line. */
  filePath: string | null
  line: number | null
  body: string
}
```

`src/common/ipc.ts` - channels:

```ts
  prInboxAddComment: 'prInbox:addComment',
  prInboxReplyToThread: 'prInbox:replyToThread',
  prInboxSetThreadStatus: 'prInbox:setThreadStatus',
```

`IpcApi.prInbox` additions (after `getThreads`):

```ts
    /** Publish my own comment immediately (ADO behaviour); returns the PR's fresh threads. */
    addComment(input: NewPrComment): Promise<PrThread[]>
    replyToThread(repositoryId: string, prId: number, threadId: number, body: string): Promise<PrThread[]>
    setThreadStatus(
      repositoryId: string,
      prId: number,
      threadId: number,
      status: 'active' | 'fixed'
    ): Promise<PrThread[]>
```

`prInbox.ipc.ts` handlers:

```ts
    async addComment(input) {
      await d.ado.publishComment({
        repositoryId: input.repositoryId,
        prId: input.prId,
        filePath: input.filePath,
        line: input.line,
        body: input.body
      })
      return d.ado.getThreads(input.repositoryId, input.prId)
    },

    async replyToThread(repositoryId, prId, threadId, body) {
      await d.ado.replyToThread({ repositoryId, prId, threadId, body })
      return d.ado.getThreads(repositoryId, prId)
    },

    async setThreadStatus(repositoryId, prId, threadId, status) {
      await d.ado.setThreadStatus({ repositoryId, prId, threadId, status })
      return d.ado.getThreads(repositoryId, prId)
    },
```

Registration in `registerPrInboxHandlers`:

```ts
  ipcMain.handle(Channel.prInboxAddComment, (_e, input: NewPrComment) => h.addComment(input))
  ipcMain.handle(Channel.prInboxReplyToThread, (_e, repositoryId: string, prId: number, threadId: number, body: string) =>
    h.replyToThread(repositoryId, prId, threadId, body)
  )
  ipcMain.handle(Channel.prInboxSetThreadStatus, (_e, repositoryId: string, prId: number, threadId: number, status: 'active' | 'fixed') =>
    h.setThreadStatus(repositoryId, prId, threadId, status)
  )
```

`src/preload/index.ts` (inside `prInbox`):

```ts
    addComment: (input) => ipcRenderer.invoke(Channel.prInboxAddComment, input),
    replyToThread: (repositoryId, prId, threadId, body) =>
      ipcRenderer.invoke(Channel.prInboxReplyToThread, repositoryId, prId, threadId, body),
    setThreadStatus: (repositoryId, prId, threadId, status) =>
      ipcRenderer.invoke(Channel.prInboxSetThreadStatus, repositoryId, prId, threadId, status),
```

`features/prInbox/ipc.ts`:

```ts
export const addComment = (input: NewPrComment): Promise<PrThread[]> =>
  ipc().prInbox.addComment(input)
export const replyToThread = (
  repositoryId: string,
  prId: number,
  threadId: number,
  body: string
): Promise<PrThread[]> => ipc().prInbox.replyToThread(repositoryId, prId, threadId, body)
export const setThreadStatus = (
  repositoryId: string,
  prId: number,
  threadId: number,
  status: 'active' | 'fixed'
): Promise<PrThread[]> => ipc().prInbox.setThreadStatus(repositoryId, prId, threadId, status)
```

`adoE2eStub.ts` - hold threads in memory so e2e can exercise the full loop:

```ts
  // Threads per PR, mutated by comment/reply/resolve during the run (radar mode only).
  const threadsByPr = new Map<number, PrThread[]>([
    [501, [
      {
        threadId: 9001,
        filePath: '/src/app/sync/rateLimiter.ts',
        line: 12,
        status: 'active',
        isSystem: false,
        comments: [{ authorName: 'Marek Kral', body: 'Should the limit be configurable?', publishedAt: Date.now() - 3_600_000 }]
      },
      {
        threadId: 9002,
        filePath: null,
        line: null,
        status: 'unknown',
        isSystem: true,
        comments: [{ authorName: 'ADO', body: 'Policy status has been updated', publishedAt: Date.now() - 7_200_000 }]
      }
    ]]
  ])
  let nextThreadId = 9100
```

- `getThreads(_repositoryId, prId)` returns `threadsByPr.get(prId) ?? []`.
- `publishComment` (radar mode) pushes a new active thread authored by `'Jan Lesak'` and returns its id.
- `replyToThread` appends a comment to the matching thread; `setThreadStatus` sets its status.
- `syncMyPrs` computes each canned PR's `activeThreadCount` from `threadsByPr` (unresolved non-system), so PR 501 lands in the author-action column.
- `getChanges` (radar mode) returns canned files exercising the tree:

```ts
      return [
        { path: '/src/app/sync/rateLimiter.ts', changeType: 'edit', originalPath: null },
        { path: '/src/app/sync/queue.ts', changeType: 'edit', originalPath: null },
        { path: '/src/app/config/limits.ts', changeType: 'add', originalPath: null },
        { path: '/tests/sync/rateLimiter.test.ts', changeType: 'edit', originalPath: null }
      ]
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/main` -> PASS. `npm run typecheck` -> clean.

- [ ] **Step 5: Stage**

```bash
git add src/main/prInbox src/main/ipc/prInbox.ipc.ts src/common src/preload/index.ts src/renderer/src/features/prInbox/ipc.ts
```

---

### Task 5: Store - board/detail navigation, tabs, thread actions

**Files:**
- Modify: `src/renderer/src/features/prInbox/store.ts`
- Test: `src/renderer/src/features/prInbox/store.test.ts` (extend)

**Interfaces:**
- Consumes: renderer `ipc.ts` functions from Task 4; `boardColumn` from `@common/prBoard`.
- Produces (new store state + actions used by Tasks 6-8):
  - `view: 'board' | 'detail'`, `activeTab: 'files' | 'overview'`, `threadFilter: 'active' | 'all' | 'resolved'`, `pendingReveal: { path: string; line: number | null } | null`
  - `openDetail(repositoryId: string, prId: number): Promise<void>` (replaces direct `select` use from the UI; `select` stays as the data loader it is)
  - `goBack(): void`, `setTab(tab: 'files' | 'overview'): void`, `setThreadFilter(f: ...): void`
  - `addComment(filePath: string | null, line: number | null, body: string): Promise<void>`
  - `replyToThread(threadId: number, body: string): Promise<void>`
  - `setThreadStatus(threadId: number, status: 'active' | 'fixed'): Promise<void>`
  - `revealThread(path: string, line: number | null): void` (switch to files tab, open file, remember line), `clearReveal(): void`
  - Selector `selectBoardColumns(state): { action: PullRequest[]; waiting: PullRequest[]; approved: PullRequest[] }` (each column sorted newest first)
  - Selector `selectActionCount(state): number`

- [ ] **Step 1: Write failing tests** (extend `store.test.ts`; reuse its `pr`/`thread` fixtures, add `activeThreadCount`/`isSystem` fields):

```ts
describe('board navigation', () => {
  test('openDetail loads the PR and switches view; goBack returns to board', async () => {
    vi.mocked(api.getChanges).mockResolvedValue([])
    vi.mocked(api.listDrafts).mockResolvedValue([])
    vi.mocked(api.getThreads).mockResolvedValue([])
    usePrInboxStore.setState({ prsByKey: { 'r:1': pr('r', 1) }, order: ['r:1'] })
    await usePrInboxStore.getState().openDetail('r', 1)
    expect(usePrInboxStore.getState().view).toBe('detail')
    expect(usePrInboxStore.getState().activeTab).toBe('files')
    usePrInboxStore.getState().goBack()
    expect(usePrInboxStore.getState().view).toBe('board')
    expect(usePrInboxStore.getState().selectedKey).toBeNull()
  })
})

describe('selectBoardColumns', () => {
  test('splits PRs by boardColumn', () => {
    usePrInboxStore.setState({
      prsByKey: {
        'r:1': pr('r', 1, { role: 'reviewer', myVote: null }),
        'r:2': pr('r', 2, { role: 'reviewer', myVote: 'approved' }),
        'r:3': pr('r', 3, {
          role: 'author',
          reviewers: [{ id: 'x', displayName: 'X', vote: 'approved', isRequired: false }]
        })
      },
      order: ['r:1', 'r:2', 'r:3']
    })
    const cols = selectBoardColumns(usePrInboxStore.getState())
    expect(cols.action.map((p) => p.prId)).toEqual([1])
    expect(cols.waiting.map((p) => p.prId)).toEqual([2])
    expect(cols.approved.map((p) => p.prId)).toEqual([3])
  })
})

describe('thread actions', () => {
  test('replyToThread refreshes threads from the response', async () => {
    const fresh = [thread(42, { status: 'active' })]
    vi.mocked(api.replyToThread).mockResolvedValue(fresh)
    usePrInboxStore.setState({ prsByKey: { 'r:1': pr('r', 1) }, order: ['r:1'], selectedKey: 'r:1' })
    await usePrInboxStore.getState().replyToThread(42, 'ok')
    expect(api.replyToThread).toHaveBeenCalledWith('r', 1, 42, 'ok')
    expect(usePrInboxStore.getState().threads).toEqual(fresh)
  })

  test('setThreadStatus refreshes threads', async () => {
    vi.mocked(api.setThreadStatus).mockResolvedValue([thread(42, { status: 'fixed' })])
    usePrInboxStore.setState({ prsByKey: { 'r:1': pr('r', 1) }, order: ['r:1'], selectedKey: 'r:1' })
    await usePrInboxStore.getState().setThreadStatus(42, 'fixed')
    expect(usePrInboxStore.getState().threads[0].status).toBe('fixed')
  })

  test('addComment publishes and refreshes threads', async () => {
    vi.mocked(api.addComment).mockResolvedValue([thread(43, {})])
    usePrInboxStore.setState({ prsByKey: { 'r:1': pr('r', 1) }, order: ['r:1'], selectedKey: 'r:1' })
    await usePrInboxStore.getState().addComment('/a.cs', 3, 'new comment')
    expect(api.addComment).toHaveBeenCalledWith({
      repositoryId: 'r',
      prId: 1,
      filePath: '/a.cs',
      line: 3,
      body: 'new comment'
    })
    expect(usePrInboxStore.getState().threads.map((t) => t.threadId)).toContain(43)
  })
})

describe('revealThread', () => {
  test('switches to files tab, opens the file, remembers the line', async () => {
    vi.mocked(api.getFileDiff).mockResolvedValue({
      path: '/a.cs', original: '', modified: '', language: 'plaintext', binary: false, tooLarge: false
    })
    usePrInboxStore.setState({
      prsByKey: { 'r:1': pr('r', 1) }, order: ['r:1'], selectedKey: 'r:1', activeTab: 'overview'
    })
    usePrInboxStore.getState().revealThread('/a.cs', 12)
    expect(usePrInboxStore.getState().activeTab).toBe('files')
    expect(usePrInboxStore.getState().pendingReveal).toEqual({ path: '/a.cs', line: 12 })
  })
})
```

Add a `thread` fixture helper next to the existing `pr`/`draft` helpers:

```ts
const thread = (threadId: number, over: Partial<PrThread> = {}): PrThread => ({
  threadId,
  filePath: '/a.cs',
  line: 3,
  status: 'active',
  isSystem: false,
  comments: [{ authorName: 'X', body: 'b', publishedAt: 0 }],
  ...over
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/renderer/src/features/prInbox/store.test.ts` -> FAIL.

- [ ] **Step 3: Implement store changes**

State additions + initial values:

```ts
  view: 'board' as 'board' | 'detail',
  activeTab: 'files' as 'files' | 'overview',
  threadFilter: 'active' as 'active' | 'all' | 'resolved',
  pendingReveal: null as { path: string; line: number | null } | null,
```

Actions (inside `create`):

```ts
  async openDetail(repositoryId, prId) {
    set({ view: 'detail', activeTab: 'files', pendingReveal: null })
    await get().select(repositoryId, prId)
  },

  goBack() {
    set({ view: 'board', selectedKey: null, pendingReveal: null })
  },

  setTab(tab) {
    set({ activeTab: tab })
  },

  setThreadFilter(threadFilter) {
    set({ threadFilter })
  },

  async addComment(filePath, line, body) {
    const pr = selectSelectedPr(get())
    if (!pr) return
    try {
      const threads = await api.addComment({ repositoryId: pr.repositoryId, prId: pr.prId, filePath, line, body })
      set({ threads })
    } catch (e) {
      reportError('Could not publish the comment to Azure DevOps', e)
    }
  },

  async replyToThread(threadId, body) {
    const pr = selectSelectedPr(get())
    if (!pr) return
    try {
      const threads = await api.replyToThread(pr.repositoryId, pr.prId, threadId, body)
      set({ threads })
    } catch (e) {
      reportError('Could not publish the reply to Azure DevOps', e)
    }
  },

  async setThreadStatus(threadId, status) {
    const pr = selectSelectedPr(get())
    if (!pr) return
    try {
      const threads = await api.setThreadStatus(pr.repositoryId, pr.prId, threadId, status)
      set({ threads })
    } catch (e) {
      reportError('Could not update the thread status', e)
    }
  },

  revealThread(path, line) {
    set({ activeTab: 'files', pendingReveal: { path, line } })
    void get().openFile(path)
  },

  clearReveal() {
    set({ pendingReveal: null })
  },
```

Selectors (module scope, import `boardColumn` from `@common/prBoard`):

```ts
/** The board's three columns, newest PRs first within each. */
export function selectBoardColumns(state: PrInboxState): {
  action: PullRequest[]
  waiting: PullRequest[]
  approved: PullRequest[]
} {
  const cols = { action: [] as PullRequest[], waiting: [] as PullRequest[], approved: [] as PullRequest[] }
  for (const pr of selectPrList(state)) cols[boardColumn(pr)].push(pr)
  for (const list of Object.values(cols)) list.sort((a, b) => b.createdAt - a.createdAt)
  return cols
}

/** How many PRs currently need my action (the sidebar badge). */
export function selectActionCount(state: PrInboxState): number {
  return selectPrList(state).filter((pr) => boardColumn(pr) === 'action').length
}
```

Update the `PrInboxState` interface accordingly. Remove nothing existing.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/renderer/src/features/prInbox/store.test.ts` -> PASS. `npm run typecheck`.

- [ ] **Step 5: Stage**

```bash
git add src/renderer/src/features/prInbox/store.ts src/renderer/src/features/prInbox/store.test.ts
```

---

### Task 6: Board UI + sidebar cleanup + badge

**Files:**
- Create: `src/renderer/src/features/prInbox/components/PrBoard.tsx`, `PrCard.tsx`
- Modify: `src/renderer/src/features/prInbox/register.ts` (drop sidebar list, add badge)
- Modify: `src/renderer/src/shared/registries/sidebarRegistry.ts` (`component` optional, `badge` slot)
- Modify: `src/renderer/src/app/Sidebar.tsx` (render badge, tolerate missing component)
- Modify: `src/renderer/src/features/prInbox/components/PrInboxView.tsx` (board/detail switch)
- Delete: `src/renderer/src/features/prInbox/components/PrList.tsx`
- Modify: `src/renderer/src/shared/ui/app.css` (board styles)
- Test: none new beyond compile + existing suites (visual components; e2e covers behaviour in Task 10)

**Interfaces:**
- Consumes: `selectBoardColumns`, `selectActionCount`, `openDetail`, `sync` from the store; `boardReason` from `@common/prBoard`.
- Produces: `PrInboxView` renders `PrBoard` when `view === 'board'`; `PrDetail` placeholder slot for Task 7 (until Task 7 lands, detail renders the existing header + `ix-pr-detail` block extracted as-is).

- [ ] **Step 1: Registry + Sidebar**

`sidebarRegistry.ts`:

```ts
  /** Renders inside the sidebar rail; omit when the section has no sidebar body. */
  component?: ComponentType
  /** Small live indicator rendered inside the section's rail button (e.g. an action count). */
  badge?: ComponentType
```

`Sidebar.tsx` - in `railButton`, after the label:

```tsx
    const Badge = section.badge
    ...
        <span className="ix-rail__label">{section.label}</span>
        {Badge && <Badge />}
```

(`const Section = active?.component` already tolerates `undefined` - verify the render guard `{!collapsed && Section && ...}` stays.)

`app.css` - badge style next to `.ix-rail__label` (~line 623):

```css
.ix-rail__badge {
  margin-left: auto;
  min-width: 17px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--accent-soft);
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  text-align: center;
}
```

- [ ] **Step 2: PrCard + PrBoard**

`PrCard.tsx`:

```tsx
import type { PrReviewer, PullRequest } from '@common/domain'
import { boardReason } from '@common/prBoard'
import { usePrInboxStore } from '../store'

/** Compact relative age (e.g. "3d", "2h", "just now") from an epoch-ms timestamp. */
function relativeAge(createdAt: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - createdAt) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

const initials = (name: string): string =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '?'

function VoteChip({ reviewer }: { reviewer: PrReviewer }) {
  return (
    <span className={`ix-pr-vote ix-pr-vote--${reviewer.vote}`} title={reviewer.displayName}>
      {initials(reviewer.displayName)}
    </span>
  )
}

export function PrCard({ pr, urgent }: { pr: PullRequest; urgent: boolean }) {
  const reason = boardReason(pr)
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="pr-card"
      className={`ix-board-card${urgent ? ' ix-board-card--urgent' : ''}`}
      onClick={() => void usePrInboxStore.getState().openDetail(pr.repositoryId, pr.prId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          void usePrInboxStore.getState().openDetail(pr.repositoryId, pr.prId)
        }
      }}
    >
      <div className="ix-board-card__title">{pr.title}</div>
      <div className="ix-board-card__meta">
        {pr.authorName} · {pr.repositoryName} · {relativeAge(pr.createdAt)}
      </div>
      <div className="ix-board-card__row">
        <span className="ix-chip">{pr.role === 'author' ? 'Author' : 'Reviewer'}</span>
        {reason && <span className={`ix-chip${urgent ? ' ix-chip--accent' : ''}`}>{reason}</span>}
        {pr.reviewers.length > 0 && (
          <span className="ix-board-card__votes">
            {pr.reviewers.map((r) => (
              <VoteChip key={r.id} reviewer={r} />
            ))}
          </span>
        )}
      </div>
    </div>
  )
}
```

(`relativeAge` and `initials`/`VoteChip` move here from the deleted `PrList.tsx`.)

`PrBoard.tsx`:

```tsx
import { useShallow } from 'zustand/react/shallow'
import type { PullRequest } from '@common/domain'
import { selectBoardColumns, usePrInboxStore } from '../store'
import { PrCard } from './PrCard'

const COLUMNS: Array<{ key: 'action' | 'waiting' | 'approved'; label: string }> = [
  { key: 'action', label: 'Needs my action' },
  { key: 'waiting', label: 'Waiting on others' },
  { key: 'approved', label: 'Approved' }
]

/** The PR Review landing view: every synced PR as a card in one of three action columns. */
export function PrBoard() {
  const cols = usePrInboxStore(useShallow(selectBoardColumns))
  const syncing = usePrInboxStore((s) => s.syncing)
  const empty = COLUMNS.every((c) => cols[c.key].length === 0)

  return (
    <div className="ix-main">
      <div className="ix-board-head">
        <span className="ix-eyebrow">Pull requests</span>
        <button
          type="button"
          className="ix-btn"
          disabled={syncing}
          data-testid="pr-sync"
          onClick={() => void usePrInboxStore.getState().sync()}
        >
          {syncing && <span className="ix-spinner" aria-hidden />}
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
      </div>
      {empty ? (
        <div className="ix-empty">
          <span className="ix-eyebrow">No pull requests</span>
          <div className="ix-empty__title">Nothing to review</div>
          <p className="ix-empty__hint">Sync to load your pull requests from Azure DevOps.</p>
        </div>
      ) : (
        <div className="ix-board" data-testid="pr-board">
          {COLUMNS.map((col) => (
            <div key={col.key} className="ix-board-col" data-testid={`pr-col-${col.key}`}>
              <div className="ix-board-col__head">
                <span className={`ix-eyebrow ix-board-col__label--${col.key}`}>{col.label}</span>
                <span className="ix-board-col__count">{cols[col.key].length}</span>
              </div>
              {cols[col.key].map((pr: PullRequest) => (
                <PrCard key={`${pr.repositoryId}:${pr.prId}`} pr={pr} urgent={col.key === 'action'} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: register.ts + PrInboxView switch + delete PrList**

`register.ts`:

```ts
import { registerCommand } from '@renderer/shared/registries/commandRegistry'
import { registerSidebarSection } from '@renderer/shared/registries/sidebarRegistry'
import { IconInbox } from '@renderer/shared/ui/icons'
import { PrInboxView } from './components/PrInboxView'
import { selectActionCount, usePrInboxStore } from './store'

/** The PR Review section's registry id, exported so other slices can navigate to it. */
export const PR_INBOX_SECTION_ID = 'prInbox'

/** Live count of PRs needing my action, shown on the rail button. */
function PrActionBadge() {
  const count = usePrInboxStore(selectActionCount)
  if (count === 0) return null
  return (
    <span className="ix-rail__badge" data-testid="pr-badge">
      {count}
    </span>
  )
}

/** Registers the PR-review sidebar section (owning the main area) and its commands. */
export function registerPrInboxFeature(): void {
  registerSidebarSection({
    id: PR_INBOX_SECTION_ID,
    order: 1,
    label: 'PR Review',
    icon: IconInbox,
    badge: PrActionBadge,
    mainComponent: PrInboxView
  })
  registerCommand({
    id: 'prInbox.sync',
    title: 'Sync Pull Requests',
    handler: () => usePrInboxStore.getState().sync()
  })
  registerCommand({
    id: 'prInbox.review',
    title: 'Review PR with Claude Code',
    handler: () => usePrInboxStore.getState().startReview()
  })
}
```

`PrInboxView.tsx` becomes the switch (the current detail markup moves to `PrDetail.tsx` in Task 7; for this task, temporarily inline the existing detail JSX unchanged under `view === 'detail'`):

```tsx
export function PrInboxView() {
  const view = usePrInboxStore((s) => s.view)
  if (view === 'board') return <PrBoard />
  return <PrDetailLegacy />  /* current markup, renamed in place; replaced by PrDetail in Task 7 */
}
```

Delete `PrList.tsx`. Search for imports of it (`grep -rn "PrList" src e2e`) and remove them.

- [ ] **Step 4: Board CSS** (append to `app.css` near the existing `ix-pr-*` block):

```css
/* --- PR board (main area) --- */
.ix-board-head { display: flex; align-items: center; gap: 12px; padding: 14px 18px 6px; }
.ix-board {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  padding: 10px 18px 18px;
  overflow-y: auto;
  align-items: start;
  flex: 1;
  min-height: 0;
}
.ix-board-col { min-width: 0; }
.ix-board-col__head { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
.ix-board-col__label--action { color: var(--accent); }
.ix-board-col__label--approved { color: var(--status-done); }
.ix-board-col__count {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-faint);
  background: var(--panel-2);
  border-radius: 9px;
  padding: 0 7px;
}
.ix-board-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
  margin-bottom: 9px;
  cursor: pointer;
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.ix-board-card:hover { background: var(--panel-2); border-color: var(--border-strong); }
.ix-board-card--urgent { border-left: 3px solid var(--accent); }
.ix-board-card__title { font-size: 13px; font-weight: 600; margin-bottom: 3px; }
.ix-board-card__meta { font-size: 11.5px; color: var(--text-faint); }
.ix-board-card__row { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; margin-top: 7px; }
.ix-board-card__votes { margin-left: auto; display: flex; gap: 3px; }
.ix-chip {
  font-family: var(--font-mono);
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 9px;
  border: 1px solid var(--border-strong);
  color: var(--text-dim);
  white-space: nowrap;
}
.ix-chip--accent { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck` -> clean. `npx vitest run src/renderer` -> green (fix any test importing `PrList`).

- [ ] **Step 6: Stage**

```bash
git add src/renderer/src/features/prInbox src/renderer/src/shared/registries/sidebarRegistry.ts src/renderer/src/app/Sidebar.tsx src/renderer/src/shared/ui/app.css
git rm src/renderer/src/features/prInbox/components/PrList.tsx 2>/dev/null || true
```

---

### Task 7: File tree (pure logic + component) and PrDetail skeleton with tabs

**Files:**
- Create: `src/renderer/src/features/prInbox/fileTree.ts`
- Create: `src/renderer/src/features/prInbox/components/FileTree.tsx`
- Create: `src/renderer/src/features/prInbox/components/PrDetail.tsx`
- Modify: `src/renderer/src/features/prInbox/components/PrInboxView.tsx` (use PrDetail, drop legacy)
- Modify: `src/renderer/src/shared/ui/app.css`
- Test: `src/renderer/src/features/prInbox/fileTree.test.ts`

**Interfaces:**
- Consumes: store state (`activeTab`, `setTab`, `goBack`, `openFile`, `threads`, `changes`), `PrVoteButtons`, `ReviewTerminal`, `DraftCard`, `DiffViewer` (existing props until Task 8).
- Produces:
  - `buildFileTree(changes: PrChangeFile[], commentCounts: Map<string, number>): TreeDir`
  - `interface TreeDir { path: string; label: string; dirs: TreeDir[]; files: TreeFile[] }`
  - `interface TreeFile { path: string; name: string; changeType: PrChangeFile['changeType']; commentCount: number }`
  - `fileCount(dir: TreeDir): number`
  - `<FileTree changes threads activeFilePath onOpen(path) />`
  - `<PrDetail />` with tabs; keyboard Esc calls `goBack()`.

- [ ] **Step 1: Write failing tree tests**

`src/renderer/src/features/prInbox/fileTree.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import type { PrChangeFile } from '@common/domain'
import { buildFileTree, fileCount } from './fileTree'

const f = (path: string, changeType: PrChangeFile['changeType'] = 'edit'): PrChangeFile => ({
  path,
  changeType,
  originalPath: null
})

describe('buildFileTree', () => {
  test('groups files under compacted single-child directory chains', () => {
    const tree = buildFileTree(
      [
        f('/src/api/features/planning/Service.cs'),
        f('/src/api/features/planning/Algorithm.cs', 'add'),
        f('/tests/planning/ServiceTests.cs')
      ],
      new Map()
    )
    expect(tree.dirs.map((d) => d.label)).toEqual(['src/api/features/planning', 'tests/planning'])
    const planning = tree.dirs[0]
    expect(planning.files.map((x) => x.name)).toEqual(['Algorithm.cs', 'Service.cs'])
    expect(planning.files[0].changeType).toBe('add')
  })

  test('does not compact a directory that has files or several children', () => {
    const tree = buildFileTree(
      [f('/src/a/one.ts'), f('/src/b/two.ts'), f('/src/root.ts')],
      new Map()
    )
    expect(tree.dirs.map((d) => d.label)).toEqual(['src'])
    const src = tree.dirs[0]
    expect(src.files.map((x) => x.name)).toEqual(['root.ts'])
    expect(src.dirs.map((d) => d.label)).toEqual(['a', 'b'])
  })

  test('attaches unresolved comment counts by path', () => {
    const tree = buildFileTree([f('/src/a.ts')], new Map([['/src/a.ts', 2]]))
    expect(tree.dirs[0].files[0].commentCount).toBe(2)
  })

  test('fileCount counts files recursively', () => {
    const tree = buildFileTree([f('/src/a/one.ts'), f('/src/b/two.ts'), f('/src/root.ts')], new Map())
    expect(fileCount(tree.dirs[0])).toBe(3)
  })

  test('directories sort before files, both alphabetically', () => {
    const tree = buildFileTree([f('/z.ts'), f('/a/b.ts')], new Map())
    expect(tree.dirs.map((d) => d.label)).toEqual(['a'])
    expect(tree.files.map((x) => x.name)).toEqual(['z.ts'])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/renderer/src/features/prInbox/fileTree.test.ts` -> FAIL.

- [ ] **Step 3: Implement `fileTree.ts`**

```ts
import type { PrChangeFile } from '@common/domain'

export interface TreeFile {
  path: string
  name: string
  changeType: PrChangeFile['changeType']
  /** Unresolved comment threads anchored to this file. */
  commentCount: number
}

/** A directory node; `label` may span several path segments when the chain had single children. */
export interface TreeDir {
  path: string
  label: string
  dirs: TreeDir[]
  files: TreeFile[]
}

interface MutableDir {
  path: string
  label: string
  dirs: Map<string, MutableDir>
  files: TreeFile[]
}

/**
 * Build the changed-files tree ADO-style: nested directories with single-child chains compacted
 * into one row, directories first, everything sorted alphabetically.
 */
export function buildFileTree(changes: PrChangeFile[], commentCounts: Map<string, number>): TreeDir {
  const root: MutableDir = { path: '', label: '', dirs: new Map(), files: [] }
  for (const change of changes) {
    const segments = change.path.split('/').filter(Boolean)
    const name = segments.pop() ?? change.path
    let node = root
    let path = ''
    for (const seg of segments) {
      path = `${path}/${seg}`
      let child = node.dirs.get(seg)
      if (!child) {
        child = { path, label: seg, dirs: new Map(), files: [] }
        node.dirs.set(seg, child)
      }
      node = child
    }
    node.files.push({
      path: change.path,
      name,
      changeType: change.changeType,
      commentCount: commentCounts.get(change.path) ?? 0
    })
  }
  return finalize(root)
}

function finalize(node: MutableDir): TreeDir {
  let dirs = [...node.dirs.values()].map(finalize)
  // Compact: a directory with exactly one subdirectory and no files merges into its child.
  dirs = dirs.map((d) => {
    let current = d
    while (current.dirs.length === 1 && current.files.length === 0) {
      const only = current.dirs[0]
      current = { ...only, label: `${current.label}/${only.label}` }
    }
    return current
  })
  dirs.sort((a, b) => a.label.localeCompare(b.label))
  const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name))
  return { path: node.path, label: node.label, dirs, files }
}

/** Total files under the directory, recursively (shown on a collapsed directory). */
export function fileCount(dir: TreeDir): number {
  return dir.files.length + dir.dirs.reduce((sum, d) => sum + fileCount(d), 0)
}
```

- [ ] **Step 4: Run tree tests** -> PASS.

- [ ] **Step 5: FileTree component**

`FileTree.tsx`:

```tsx
import { useMemo, useState } from 'react'
import type { PrChangeFile, PrThread } from '@common/domain'
import { isThreadUnresolved } from '@common/prBoard'
import { buildFileTree, fileCount, type TreeDir } from '../fileTree'

interface FileTreeProps {
  changes: PrChangeFile[]
  threads: PrThread[]
  activeFilePath: string | null
  onOpen(path: string): void
}

const TYPE_LETTER: Record<PrChangeFile['changeType'], string> = {
  add: 'A',
  edit: 'M',
  delete: 'D',
  rename: 'R'
}

/** Collapsible changed-files tree; everything starts expanded, a click on a directory toggles it. */
export function FileTree({ changes, threads, activeFilePath, onOpen }: FileTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const tree = useMemo(() => {
    const counts = new Map<string, number>()
    for (const t of threads) {
      if (t.filePath && !t.isSystem && isThreadUnresolved(t)) {
        counts.set(t.filePath, (counts.get(t.filePath) ?? 0) + 1)
      }
    }
    return buildFileTree(changes, counts)
  }, [changes, threads])

  const toggle = (path: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const renderDir = (dir: TreeDir, depth: number) => {
    const isCollapsed = collapsed.has(dir.path)
    return (
      <div key={dir.path}>
        <button
          type="button"
          className="ix-tree__node ix-tree__node--dir"
          style={{ paddingLeft: 8 + depth * 14 }}
          data-testid="tree-dir"
          onClick={() => toggle(dir.path)}
        >
          <span className="ix-tree__arrow">{isCollapsed ? '▸' : '▾'}</span>
          <span className="ix-tree__label" title={dir.path}>{dir.label}</span>
          {isCollapsed && <span className="ix-tree__count">{fileCount(dir)}</span>}
        </button>
        {!isCollapsed && renderChildren(dir, depth + 1)}
      </div>
    )
  }

  const renderChildren = (dir: TreeDir, depth: number) => (
    <>
      {dir.dirs.map((d) => renderDir(d, depth))}
      {dir.files.map((file) => (
        <button
          key={file.path}
          type="button"
          className={`ix-tree__node ix-tree__node--file${file.path === activeFilePath ? ' ix-tree__node--active' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          title={file.path}
          data-testid="tree-file"
          onClick={() => onOpen(file.path)}
        >
          <span className={`ix-pr-file__type ix-pr-file__type--${file.changeType}`}>
            {TYPE_LETTER[file.changeType]}
          </span>
          <span className="ix-tree__label">{file.name}</span>
          {file.commentCount > 0 && <span className="ix-tree__count">💬 {file.commentCount}</span>}
        </button>
      ))}
    </>
  )

  if (changes.length === 0) return <span className="ix-faint">No changes.</span>
  return <div className="ix-tree">{renderChildren(tree, 0)}</div>
}
```

- [ ] **Step 6: PrDetail with tabs**

`PrDetail.tsx` (moves the header/actions/terminal logic out of the old `PrInboxView`; Overview tab content arrives in Task 9 - until then render a placeholder `<div />` guarded by the tab):

```tsx
import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { isThreadUnresolved } from '@common/prBoard'
import { selectDrafts, selectSelectedPr, usePrInboxStore } from '../store'
import { DiffViewer } from './DiffViewer'
import { DraftCard } from './DraftCard'
import { FileTree } from './FileTree'
import { PrVoteButtons } from './PrVoteButtons'
import { ReviewTerminal } from './ReviewTerminal'

const shortRef = (ref: string): string => ref.replace(/^refs\/heads\//, '')

/** ADO-like PR detail: breadcrumb header, vote actions, Files/Overview tabs. Esc goes back. */
export function PrDetail() {
  const pr = usePrInboxStore(selectSelectedPr)
  const activeTab = usePrInboxStore((s) => s.activeTab)
  const changes = usePrInboxStore(useShallow((s) => s.changes))
  const threads = usePrInboxStore(useShallow((s) => s.threads))
  const activeFilePath = usePrInboxStore((s) => s.activeFilePath)
  const fileDiff = usePrInboxStore((s) => s.fileDiff)
  const diffLoading = usePrInboxStore((s) => s.diffLoading)
  const drafts = usePrInboxStore(useShallow(selectDrafts))
  const reviewStatus = usePrInboxStore((s) => s.review.status)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') usePrInboxStore.getState().goBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!pr) return null
  const running = reviewStatus === 'running'
  const commentCount = threads.filter((t) => !t.isSystem && isThreadUnresolved(t)).length

  return (
    <div className="ix-main">
      <div className="ix-pr-header">
        <button
          type="button"
          className="ix-btn ix-btn--ghost"
          data-testid="pr-back"
          onClick={() => usePrInboxStore.getState().goBack()}
        >
          ← Pull requests
        </button>
        <div className="ix-pr-header__title">{pr.title}</div>
        <div className="ix-pr-header__refs">
          <span className="ix-faint">{pr.authorName}</span>
          <span className="ix-pr-ref">{shortRef(pr.sourceRefName)}</span>
          <span className="ix-faint">→</span>
          <span className="ix-pr-ref">{shortRef(pr.targetRefName)}</span>
        </div>
        <div className="ix-row" style={{ gap: 8, marginLeft: 'auto' }}>
          <PrVoteButtons pr={pr} />
          <button
            type="button"
            className="ix-btn ix-btn--primary"
            disabled={running}
            onClick={() => void usePrInboxStore.getState().startReview()}
          >
            Review with Claude Code
          </button>
          {running && (
            <button
              type="button"
              className="ix-btn ix-btn--danger"
              onClick={() => void usePrInboxStore.getState().endReview()}
            >
              End review
            </button>
          )}
        </div>
      </div>

      {running ? (
        <ReviewTerminal />
      ) : (
        <>
          <div className="ix-tabs">
            {(['files', 'overview'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                className={`ix-tab${activeTab === tab ? ' ix-tab--active' : ''}`}
                data-testid={`pr-tab-${tab}`}
                onClick={() => usePrInboxStore.getState().setTab(tab)}
              >
                {tab === 'files' ? `Files` : `Overview`}
                <span className="ix-board-col__count">
                  {tab === 'files' ? changes.length : commentCount}
                </span>
              </button>
            ))}
          </div>

          {activeTab === 'files' ? (
            <div className="ix-pr-detail">
              <div className="ix-pr-files">
                <FileTree
                  changes={changes}
                  threads={threads}
                  activeFilePath={activeFilePath}
                  onOpen={(path) => void usePrInboxStore.getState().openFile(path)}
                />
              </div>
              <div className="ix-pr-content">
                <div className="ix-pr-diff-wrap">
                  <DiffViewer
                    diff={fileDiff}
                    loading={diffLoading}
                    drafts={drafts}
                    onAddDraft={(line, body) =>
                      void usePrInboxStore.getState().addComment(activeFilePath, line, body)
                    }
                  />
                </div>
                <div className="ix-pr-drafts">
                  <span className="ix-eyebrow">Draft comments</span>
                  {drafts.length === 0 ? (
                    <span className="ix-faint">No drafts yet. Run a Claude review to get some.</span>
                  ) : (
                    drafts.map((d) => <DraftCard key={d.id} draft={d} />)
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div data-testid="pr-overview" />
          )}
        </>
      )}
    </div>
  )
}
```

Note: `onAddDraft` now routes to `addComment` (immediate publish per the spec decision); Task 8 replaces this prop wholesale with the composer. The empty-drafts hint changes because manual comments no longer create drafts.

`PrInboxView.tsx` final form:

```tsx
import { usePrInboxStore } from '../store'
import { PrBoard } from './PrBoard'
import { PrDetail } from './PrDetail'

/** PR Review main area: the board, or the selected PR's detail. */
export function PrInboxView() {
  const view = usePrInboxStore((s) => s.view)
  return view === 'board' ? <PrBoard /> : <PrDetail />
}
```

- [ ] **Step 7: Tabs + tree CSS** (append to `app.css`):

```css
/* --- PR detail tabs --- */
.ix-tabs { display: flex; gap: 2px; padding: 0 16px; border-bottom: 1px solid var(--border); }
.ix-tab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 9px 14px 8px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--text-dim);
  font-size: 12.5px;
  cursor: pointer;
}
.ix-tab--active { color: var(--text); border-bottom-color: var(--accent); }

/* --- changed-files tree --- */
.ix-tree { display: flex; flex-direction: column; font-family: var(--font-mono); font-size: 11.5px; }
.ix-tree__node {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 3px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-dim);
  text-align: left;
  cursor: pointer;
  min-width: 0;
}
.ix-tree__node:hover { background: var(--panel-2); }
.ix-tree__node--dir { color: var(--text); }
.ix-tree__node--active { background: var(--accent-soft); color: var(--accent); }
.ix-tree__arrow { flex: none; width: 12px; }
.ix-tree__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ix-tree__count { margin-left: auto; flex: none; font-size: 10px; color: var(--text-faint); }
```

- [ ] **Step 8: Verify + stage**

Run: `npm run typecheck` && `npx vitest run src/renderer` -> green.

```bash
git add src/renderer/src/features/prInbox src/renderer/src/shared/ui/app.css
```

---

### Task 8: Diff view zones - inline threads, inline composer (React portals in Monaco)

**Files:**
- Create: `src/renderer/src/features/prInbox/components/monacoZones.tsx`
- Create: `src/renderer/src/features/prInbox/components/ThreadCard.tsx` (shared with Overview)
- Create: `src/renderer/src/features/prInbox/components/CommentComposer.tsx`
- Modify: `src/renderer/src/features/prInbox/components/DiffViewer.tsx` (rewrite)
- Modify: `src/renderer/src/shared/ui/app.css`
- Test: compile + existing suites (Monaco behaviour is e2e territory, Task 10)

**Interfaces:**
- Consumes: store actions `addComment`, `replyToThread`, `setThreadStatus`, `clearReveal`; `pendingReveal` state.
- Produces:
  - `useMonacoZones(editor: monaco.editor.ICodeEditor | null, specs: ZoneSpec[]): ReactNode` where `interface ZoneSpec { key: string; afterLine: number; node: ReactNode }` - renders portals, keeps zone heights synced to content.
  - `<ThreadCard thread onReply(body) onSetStatus(status) context?: 'inline' | 'overview' onOpenFile?(path, line) />`
  - `<CommentComposer label onSubmit(body) onCancel />` (textarea, Ctrl+Enter submit, Esc cancel, autofocus)
  - `DiffViewer` props change to: `{ diff, loading, drafts, threads: PrThread[], pendingReveal, onReveal(): void }` - comments publish through the store directly.

- [ ] **Step 1: `monacoZones.tsx`**

```tsx
import * as monaco from 'monaco-editor'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface ZoneSpec {
  key: string
  afterLine: number
  node: ReactNode
}

interface MountedZone {
  key: string
  zoneId: string
  host: HTMLDivElement
  observer: ResizeObserver
}

/**
 * Mount React content as Monaco view zones under diff lines. Each zone's height follows its
 * rendered content via a ResizeObserver, so replies and composers can grow freely.
 */
export function useMonacoZones(
  editor: monaco.editor.ICodeEditor | null,
  specs: ZoneSpec[]
): ReactNode {
  const [mounted, setMounted] = useState<MountedZone[]>([])
  const mountedRef = useRef<MountedZone[]>([])

  useEffect(() => {
    if (!editor) return
    const zones: MountedZone[] = []
    editor.changeViewZones((accessor) => {
      for (const spec of specs) {
        const host = document.createElement('div')
        host.className = 'ix-zone-host'
        const zoneId = accessor.addZone({
          afterLineNumber: spec.afterLine,
          heightInPx: 80,
          domNode: host
        })
        const observer = new ResizeObserver(() => {
          const height = host.firstElementChild?.getBoundingClientRect().height ?? 0
          if (height > 0) {
            editor.changeViewZones((a) => a.layoutZone(zoneId))
            // layoutZone re-reads heightInPx from the zone object; Monaco keeps the reference.
          }
        })
        zones.push({ key: spec.key, zoneId, host, observer })
      }
    })
    // Monaco's addZone snapshots heightInPx; to make layoutZone pick up growth we re-add with
    // measured heights instead: observe and swap heights through a mutable zone record.
    for (const z of zones) {
      const spec = specs.find((s) => s.key === z.key)
      if (spec) z.observer.observe(z.host)
    }
    mountedRef.current = zones
    setMounted(zones)
    return () => {
      for (const z of zones) z.observer.disconnect()
      editor.changeViewZones((accessor) => {
        for (const z of zones) accessor.removeZone(z.zoneId)
      })
      mountedRef.current = []
      setMounted([])
    }
    // Recreate when the spec list structurally changes (keys/lines), not on every render.
  }, [editor, specs.map((s) => `${s.key}@${s.afterLine}`).join('|')])

  return (
    <>
      {mounted.map((z) => {
        const spec = specs.find((s) => s.key === z.key)
        return spec ? createPortal(spec.node, z.host, z.key) : null
      })}
    </>
  )
}
```

Implementation note for the executor: Monaco zone height updates work by mutating the zone object you passed to `addZone` (keep a reference: `const zone = { afterLineNumber, heightInPx, domNode }`) and then calling `accessor.layoutZone(id)`. Wire the ResizeObserver callback to set `zone.heightInPx = measured + 12` before `layoutZone`. Verify against monaco-editor's `IViewZone` docs (Context7 `monaco-editor`) while implementing - the sketch above marks intent; the mutable-record mechanism is the required approach.

- [ ] **Step 2: `ThreadCard.tsx`**

```tsx
import { useState } from 'react'
import type { PrThread } from '@common/domain'
import { isThreadUnresolved } from '@common/prBoard'

interface ThreadCardProps {
  thread: PrThread
  onReply(body: string): Promise<void> | void
  onSetStatus(status: 'active' | 'fixed'): Promise<void> | void
  /** 'overview' additionally shows the file:line chip and lets the user jump to the code. */
  context?: 'inline' | 'overview'
  onOpenFile?(path: string, line: number | null): void
}

const timeAgo = (ms: number): string => {
  if (!ms) return ''
  const mins = Math.max(0, Math.floor((Date.now() - ms) / 60000))
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** One ADO comment thread: conversation, status chip, reply box, resolve/reactivate. */
export function ThreadCard({ thread, onReply, onSetStatus, context = 'inline', onOpenFile }: ThreadCardProps) {
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const unresolved = isThreadUnresolved(thread)

  const submit = async (): Promise<void> => {
    const body = reply.trim()
    if (!body || busy) return
    setBusy(true)
    try {
      await onReply(body)
      setReply('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ix-thread" data-testid="pr-thread">
      {context === 'overview' && (
        <button
          type="button"
          className="ix-thread__ctx"
          disabled={!thread.filePath}
          onClick={() => thread.filePath && onOpenFile?.(thread.filePath, thread.line)}
        >
          {thread.filePath ? `${thread.filePath}${thread.line ? `:${thread.line}` : ''}` : 'PR-level'}
        </button>
      )}
      <div className="ix-thread__head">
        <span className={`ix-chip${unresolved ? ' ix-chip--accent' : ''}`}>
          {unresolved ? 'Active' : 'Resolved'}
        </span>
        <button
          type="button"
          className="ix-btn ix-btn--ghost"
          data-testid="pr-thread-toggle"
          disabled={busy}
          onClick={() => void onSetStatus(unresolved ? 'fixed' : 'active')}
        >
          {unresolved ? 'Resolve' : 'Reactivate'}
        </button>
      </div>
      {thread.comments.map((c, i) => (
        <div key={i} className="ix-thread__comment">
          <span className="ix-thread__author">{c.authorName}</span>
          <span className="ix-thread__time">{timeAgo(c.publishedAt)}</span>
          <p className="ix-thread__body">{c.body}</p>
        </div>
      ))}
      <div className="ix-thread__reply">
        <input
          className="ix-input"
          placeholder="Reply…"
          value={reply}
          data-testid="pr-thread-reply"
          disabled={busy}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit()
          }}
        />
        <button type="button" className="ix-btn" disabled={!reply.trim() || busy} onClick={() => void submit()}>
          Reply
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: `CommentComposer.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react'

interface CommentComposerProps {
  label: string
  onSubmit(body: string): Promise<void> | void
  onCancel(): void
}

/** Inline comment box (diff line or PR-level): Ctrl+Enter submits, Esc cancels. */
export function CommentComposer({ label, onSubmit, onCancel }: CommentComposerProps) {
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => ref.current?.focus(), [])

  const submit = async (): Promise<void> => {
    const text = body.trim()
    if (!text || busy) return
    setBusy(true)
    try {
      await onSubmit(text)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ix-composer" data-testid="pr-composer">
      <span className="ix-eyebrow">{label}</span>
      <textarea
        ref={ref}
        className="ix-composer__input"
        rows={2}
        value={body}
        disabled={busy}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            void submit()
          }
          if (e.key === 'Escape') {
            e.stopPropagation()
            onCancel()
          }
        }}
      />
      <div className="ix-composer__actions">
        <button type="button" className="ix-btn ix-btn--ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="ix-btn ix-btn--primary"
          data-testid="pr-composer-submit"
          disabled={!body.trim() || busy}
          onClick={() => void submit()}
        >
          Comment
        </button>
      </div>
    </div>
  )
}
```

Note the composer's Esc handler stops propagation so the window-level Esc (back to board) does not fire.

- [ ] **Step 4: Rewrite `DiffViewer.tsx`**

New props and behaviour (keep the editor/model lifecycle effects as they are):

```tsx
import * as monaco from 'monaco-editor'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DraftComment, FileDiff, PrThread } from '@common/domain'
import { usePrInboxStore } from '../store'
import { CommentComposer } from './CommentComposer'
import { ThreadCard } from './ThreadCard'
import { useMonacoZones, type ZoneSpec } from './monacoZones'

interface DiffViewerProps {
  diff: FileDiff | null
  loading: boolean
  drafts: DraftComment[]
  threads: PrThread[]
  /** Line to scroll to once the diff is up (set by Overview's file:line chip). */
  pendingReveal: { path: string; line: number | null } | null
  onRevealDone(): void
}
```

Inside the component:

1. Keep the create/dispose diff editor effect and the model-swap effect exactly as today.
2. Track the modified editor in state once created: `const [modifiedEditor, setModifiedEditor] = useState<monaco.editor.ICodeEditor | null>(null)` (set after `createDiffEditor`, cleared on dispose).
3. Composer state: `const [composerLine, setComposerLine] = useState<number | null>(null)`.
4. Gutter click opens the composer:

```tsx
  useEffect(() => {
    if (!modifiedEditor) return
    const sub = modifiedEditor.onMouseDown((e) => {
      const t = e.target.type
      if (
        t === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS ||
        t === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN
      ) {
        const line = e.target.position?.lineNumber
        if (line) setComposerLine(line)
      }
    })
    return () => sub.dispose()
  }, [modifiedEditor])
```

5. Zone specs - existing threads for this file (non-system), drafts (right side, as before but as React), plus the composer:

```tsx
  const store = usePrInboxStore.getState
  const zoneSpecs = useMemo<ZoneSpec[]>(() => {
    if (!diff) return []
    const specs: ZoneSpec[] = []
    for (const t of threads) {
      if (t.isSystem || t.filePath !== diff.path || !t.line) continue
      specs.push({
        key: `thread-${t.threadId}`,
        afterLine: t.line,
        node: (
          <ThreadCard
            thread={t}
            onReply={(body) => store().replyToThread(t.threadId, body)}
            onSetStatus={(status) => store().setThreadStatus(t.threadId, status)}
          />
        )
      })
    }
    for (const d of drafts) {
      if (d.filePath !== diff.path || d.side !== 'right') continue
      specs.push({
        key: `draft-${d.id}`,
        afterLine: d.line,
        node: (
          <div className="ix-zone-draft">
            <span className="ix-chip">{d.source === 'claude' ? 'Claude draft' : 'Draft'}</span>
            <p className="ix-thread__body">{d.body}</p>
          </div>
        )
      })
    }
    if (composerLine) {
      specs.push({
        key: 'composer',
        afterLine: composerLine,
        node: (
          <CommentComposer
            label={`New comment · line ${composerLine}`}
            onSubmit={async (body) => {
              await store().addComment(diff.path, composerLine, body)
              setComposerLine(null)
            }}
            onCancel={() => setComposerLine(null)}
          />
        )
      })
    }
    return specs
  }, [diff, threads, drafts, composerLine])

  const portals = useMonacoZones(modifiedEditor, zoneSpecs)
```

6. Reveal effect:

```tsx
  useEffect(() => {
    if (!modifiedEditor || !diff || !pendingReveal) return
    if (pendingReveal.path !== diff.path) return
    if (pendingReveal.line) modifiedEditor.revealLineInCenter(pendingReveal.line)
    onRevealDone()
  }, [modifiedEditor, diff, pendingReveal])
```

7. Render: drop the toolbar button; keep the path label; render `{portals}` after the host div. Placeholders (loading/binary/tooLarge/none) unchanged. Keep the glyph-margin decorations effect only for drafts if desired - simpler: delete the old decoration + plain-DOM zone effects entirely (replaced by React zones).

8. Update `PrDetail.tsx` to pass the new props:

```tsx
<DiffViewer
  diff={fileDiff}
  loading={diffLoading}
  drafts={drafts}
  threads={threads}
  pendingReveal={usePrInboxStore((s) => s.pendingReveal)}   /* hoist to a variable at component top */
  onRevealDone={() => usePrInboxStore.getState().clearReveal()}
/>
```

- [ ] **Step 5: Zone CSS** (append to `app.css`):

```css
/* --- diff view zones (threads, drafts, composer) --- */
.ix-zone-host { z-index: 10; }
.ix-thread {
  margin: 6px 12px 8px 26px;
  max-width: 640px;
  background: var(--panel);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  font-family: var(--font-ui);
}
.ix-thread__ctx {
  display: block;
  width: 100%;
  padding: 6px 12px;
  border: none;
  border-bottom: 1px solid var(--border);
  border-radius: var(--radius) var(--radius) 0 0;
  background: var(--panel-2);
  color: var(--status-working);
  font-family: var(--font-mono);
  font-size: 10.5px;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ix-thread__ctx:disabled { cursor: default; color: var(--text-faint); }
.ix-thread__head { display: flex; align-items: center; gap: 8px; padding: 7px 12px 0; }
.ix-thread__head .ix-btn { margin-left: auto; height: 24px; font-size: 11.5px; }
.ix-thread__comment { padding: 7px 12px 0; }
.ix-thread__author { font-weight: 600; font-size: 12px; }
.ix-thread__time { margin-left: 7px; font-size: 10.5px; color: var(--text-faint); }
.ix-thread__body { margin: 3px 0 0; font-size: 12.5px; color: var(--text-dim); user-select: text; }
.ix-thread__reply { display: flex; gap: 7px; padding: 9px 12px 10px; }
.ix-thread__reply .ix-input { height: 28px; font-size: 12px; }
.ix-thread__reply .ix-btn { height: 28px; }
.ix-zone-draft {
  margin: 6px 12px 8px 26px;
  max-width: 640px;
  padding: 8px 12px;
  background: var(--panel);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  font-family: var(--font-ui);
}
.ix-composer {
  margin: 6px 12px 8px 26px;
  max-width: 640px;
  padding: 10px 12px;
  background: var(--panel);
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  font-family: var(--font-ui);
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.ix-composer__input {
  background: var(--bg);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text);
  padding: 7px 9px;
  font: inherit;
  font-size: 12.5px;
  resize: vertical;
}
.ix-composer__input:focus { outline: none; border-color: var(--accent); }
.ix-composer__actions { display: flex; justify-content: flex-end; gap: 8px; }
```

- [ ] **Step 6: Verify + stage**

Run: `npm run typecheck` && `npx vitest run src/renderer` -> green.

```bash
git add src/renderer/src/features/prInbox src/renderer/src/shared/ui/app.css
```

---

### Task 9: Overview tab

**Files:**
- Create: `src/renderer/src/features/prInbox/components/OverviewTab.tsx`
- Modify: `src/renderer/src/features/prInbox/components/PrDetail.tsx` (render it)
- Modify: `src/renderer/src/shared/ui/app.css`
- Test: `src/renderer/src/features/prInbox/store.test.ts` (thread filter selector)

**Interfaces:**
- Consumes: `ThreadCard` (context `'overview'`), `CommentComposer`, store `threads`, `threadFilter`, `setThreadFilter`, `revealThread`, `addComment`.
- Produces: `selectFilteredThreads(state): PrThread[]` in the store; `<OverviewTab />`.

- [ ] **Step 1: Failing selector test** (extend `store.test.ts`):

```ts
describe('selectFilteredThreads', () => {
  const seed = () =>
    usePrInboxStore.setState({
      threads: [
        thread(1, { status: 'active' }),
        thread(2, { status: 'fixed' }),
        thread(3, { status: 'active', isSystem: true }),
        thread(4, { status: 'active', comments: [{ authorName: 'Jan Lesak', body: 'm', publishedAt: 0 }] })
      ]
    })

  test('active filter hides resolved and system threads', () => {
    seed()
    usePrInboxStore.setState({ threadFilter: 'active' })
    expect(selectFilteredThreads(usePrInboxStore.getState()).map((t) => t.threadId)).toEqual([1, 4])
  })

  test('all shows everything except system; resolved shows only resolved', () => {
    seed()
    usePrInboxStore.setState({ threadFilter: 'all' })
    expect(selectFilteredThreads(usePrInboxStore.getState()).map((t) => t.threadId)).toEqual([1, 2, 4])
    usePrInboxStore.setState({ threadFilter: 'resolved' })
    expect(selectFilteredThreads(usePrInboxStore.getState()).map((t) => t.threadId)).toEqual([2])
  })
})
```

`mine` filter needs my display name; the app has no local identity in the renderer. Decision: `mine` filters threads where any comment's author equals the selected PR's `myReviewerId`-matched reviewer displayName when available, else falls back to no filtering. Simpler and honest: drop `mine` from V1 - remove it from the type union in Task 5 (`'active' | 'all' | 'resolved'`) and from these tests. Do that (spec's "Mine" becomes out of scope; note it in the commit).

- [ ] **Step 2: Implement selector**

```ts
/** Threads visible under the Overview filter; system threads never show. */
export function selectFilteredThreads(state: PrInboxState): PrThread[] {
  const real = state.threads.filter((t) => !t.isSystem)
  if (state.threadFilter === 'active') return real.filter(isThreadUnresolved)
  if (state.threadFilter === 'resolved') return real.filter((t) => !isThreadUnresolved(t))
  return real
}
```

Run: `npx vitest run src/renderer/src/features/prInbox/store.test.ts` -> PASS.

- [ ] **Step 3: `OverviewTab.tsx`**

```tsx
import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { selectFilteredThreads, usePrInboxStore } from '../store'
import { CommentComposer } from './CommentComposer'
import { ThreadCard } from './ThreadCard'

const FILTERS = ['active', 'all', 'resolved'] as const

/** Every comment thread of the PR on one page, ADO Overview style. */
export function OverviewTab() {
  const threads = usePrInboxStore(useShallow(selectFilteredThreads))
  const filter = usePrInboxStore((s) => s.threadFilter)
  const [composing, setComposing] = useState(false)

  return (
    <div className="ix-overview" data-testid="pr-overview">
      <div className="ix-overview__head">
        <span className="ix-eyebrow">Comments</span>
        <select
          className="ix-input ix-overview__filter"
          value={filter}
          data-testid="pr-thread-filter"
          onChange={(e) => usePrInboxStore.getState().setThreadFilter(e.target.value as typeof filter)}
        >
          {FILTERS.map((f) => (
            <option key={f} value={f}>
              {f === 'active' ? 'Active' : f === 'all' ? 'All' : 'Resolved'}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ix-btn"
          style={{ marginLeft: 'auto' }}
          data-testid="pr-add-comment"
          onClick={() => setComposing(true)}
        >
          + Comment
        </button>
      </div>
      {composing && (
        <CommentComposer
          label="New PR-level comment"
          onSubmit={async (body) => {
            await usePrInboxStore.getState().addComment(null, null, body)
            setComposing(false)
          }}
          onCancel={() => setComposing(false)}
        />
      )}
      {threads.length === 0 ? (
        <div className="ix-empty">
          <span className="ix-eyebrow">No comments</span>
          <div className="ix-empty__title">Nothing here</div>
          <p className="ix-empty__hint">No threads match the current filter.</p>
        </div>
      ) : (
        threads.map((t) => (
          <ThreadCard
            key={t.threadId}
            thread={t}
            context="overview"
            onReply={(body) => usePrInboxStore.getState().replyToThread(t.threadId, body)}
            onSetStatus={(status) => usePrInboxStore.getState().setThreadStatus(t.threadId, status)}
            onOpenFile={(path, line) => usePrInboxStore.getState().revealThread(path, line)}
          />
        ))
      )}
    </div>
  )
}
```

In `PrDetail.tsx`, replace the `<div data-testid="pr-overview" />` placeholder with `<OverviewTab />`.

CSS:

```css
/* --- PR overview tab --- */
.ix-overview { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 16px 18px; }
.ix-overview__head { display: flex; align-items: center; gap: 10px; padding: 4px 0 10px; }
.ix-overview__filter { width: 130px; height: 30px; }
.ix-overview .ix-thread { margin: 0 0 10px; max-width: 760px; }
.ix-overview .ix-composer { margin: 0 0 10px; max-width: 760px; }
```

- [ ] **Step 4: Verify + stage**

Run: `npm run typecheck` && `npx vitest run src/renderer` -> green.

```bash
git add src/renderer/src/features/prInbox src/renderer/src/shared/ui/app.css
```

---

### Task 10: E2E rewrite + dead-code cleanup

**Files:**
- Modify: `e2e/prInbox.spec.ts`, `e2e/prvote.spec.ts`, `e2e/smoke.spec.ts` (selectors)
- Modify: `src/main/prInbox/adoE2eStub.ts` (only if scenarios below need more data)
- Delete: any leftover references to removed components

**Interfaces:**
- Consumes: `data-testid`s introduced above: `pr-board`, `pr-col-action|waiting|approved`, `pr-card`, `pr-badge`, `pr-back`, `pr-tab-files`, `pr-tab-overview`, `tree-dir`, `tree-file`, `pr-thread`, `pr-thread-reply`, `pr-thread-toggle`, `pr-thread-filter`, `pr-composer`, `pr-composer-submit`, `pr-add-comment`, `pr-sync`.

- [ ] **Step 1: Read the existing specs** (`e2e/prInbox.spec.ts`, `e2e/prvote.spec.ts`) to mirror their launch helpers (`INTERSECT_E2E_ADO=radar` env etc.).

- [ ] **Step 2: Rewrite scenarios** (exact assertions; adapt helper names to what the files use):

`e2e/prInbox.spec.ts`:

```ts
test('board shows PRs in action columns after sync', async () => {
  // launch with INTERSECT_E2E_ADO=radar, open the PR Review section, click [data-testid=pr-sync]
  // PR 502 (reviewer, noVote) and PR 501 (author, 1 unresolved thread) -> action column
  // PR 503 (reviewer, approved, first sync) -> approved column? NO: 503's reviewers = only me,
  //   approved -> approved column. Assert:
  await expect(page.getByTestId('pr-col-action').getByTestId('pr-card')).toHaveCount(2)
  await expect(page.getByTestId('pr-col-approved').getByTestId('pr-card')).toHaveCount(1)
  await expect(page.getByTestId('pr-badge')).toHaveText('2')
})

test('opening a card shows the detail with file tree; Esc returns', async () => {
  // click the PR 502 card
  await expect(page.getByTestId('pr-tab-files')).toBeVisible()
  await expect(page.getByTestId('tree-file')).toHaveCount(4)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('pr-board')).toBeVisible()
})

test('collapsing a tree directory hides its files and shows the count', async () => { /* click first tree-dir, assert count chip visible and file count drops */ })

test('overview lists threads, filter hides resolved, resolve moves a thread out of Active', async () => {
  // open PR 501, switch to overview tab
  await expect(page.getByTestId('pr-thread')).toHaveCount(1)  // system thread hidden
  await page.getByTestId('pr-thread-toggle').click()          // Resolve
  await expect(page.getByTestId('pr-thread')).toHaveCount(0)  // active filter
  await page.getByTestId('pr-thread-filter').selectOption('resolved')
  await expect(page.getByTestId('pr-thread')).toHaveCount(1)
})

test('replying appends to the thread', async () => { /* type into pr-thread-reply, click Reply, assert comment count grew */ })

test('PR-level comment publishes from overview', async () => { /* pr-add-comment -> composer -> submit -> new pr-thread appears under All */ })
```

`e2e/prvote.spec.ts`: update navigation (board card -> detail) and keep the existing vote assertions.

`e2e/smoke.spec.ts`: update any selector that referenced the sidebar PR list.

- [ ] **Step 3: Ask the user before running e2e.** Unit tests + typecheck may run freely:

Run: `npm run typecheck && npx vitest run` -> green.
Then ask the user for approval to run `npx playwright test e2e/prInbox.spec.ts e2e/prvote.spec.ts e2e/smoke.spec.ts` and fix failures.

- [ ] **Step 4: Dead-code sweep**

`grep -rn "PrList\|Comment on cursor line\|Existing threads\|ix-pr-thread\b" src e2e` - delete leftovers (old `ThreadRow`, `.ix-pr-thread` CSS block, `ix-pr-group`/`ix-pr-row` CSS if nothing references them).

- [ ] **Step 5: Stage**

```bash
git add e2e src/renderer src/main
```

---

## Verification (whole feature)

1. `npm run typecheck` + `npx vitest run` green.
2. With user approval: full e2e suite green.
3. With user approval: `/verify`-style manual run (launch app with `INTERSECT_E2E_ADO=radar` or against real ADO): board columns render, badge counts, detail tabs, tree collapse, inline thread reply/resolve, composer publish, Overview filter + reveal-in-file, vote buttons, Claude review terminal still works.
