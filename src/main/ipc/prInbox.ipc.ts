import type { IpcMain } from 'electron'
import { Channel, type IpcApi } from '@common/ipc'
import type { NewPrComment, PrChangeFile, PrReviewer, PrVote, PullRequest } from '@common/domain'
import type { DraftCommentRepo } from '../db/draftCommentRepo'
import type { PrCacheRepo } from '../db/prCacheRepo'
import type { PrReviewWatermarkRepo } from '../db/prReviewWatermarkRepo'
import type { AdoIdentity } from '../prInbox/adoMapping'
import type { AdoService } from '../prInbox/adoService'
import type { LocalDiffService } from '../prInbox/localDiff'
import type { ReviewManager } from '../prInbox/reviewManager'
import { decorateNewChanges, planWatermarks } from '../prInbox/reviewWatermark'

/** Main implements everything except the renderer-only broadcast subscriptions. */
export type PrInboxHandlers = Omit<
  IpcApi['prInbox'],
  'onReviewData' | 'onReviewExit' | 'onDraftAdded'
>

export interface PrInboxHandlerDeps {
  prCache: PrCacheRepo
  drafts: DraftCommentRepo
  watermarks: PrReviewWatermarkRepo
  ado: AdoService
  /** Local-git diff engine: PR changes and per-file diffs read from the clone, not Azure DevOps. */
  localDiff: LocalDiffService
  /** The clone folders to search for a PR's repo (from the workspaces slice). */
  workspaceFolders: () => string[]
  review: ReviewManager
  /**
   * Run the sync's cache and watermark writes as one transaction, so a crash mid-sync cannot
   * leave a vote recorded without its watermark (which would silently disable new-changes
   * detection for that PR).
   */
  atomically: <T>(fn: () => T) => T
  /**
   * Who I am on the ADO server, used as the vote fallback when the cached PR carries no reviewer
   * entry of mine. Only a UUID identity can address the reviewers endpoint directly, and
   * resolution may throw when the identity is not configured.
   */
  resolveIdentity?: () => Promise<AdoIdentity>
  /** Warn surface for partial sync failures (defaults to console.warn). */
  warn?: (message: string) => void
}

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

/** A compact markdown brief handed to the review session (it has no Azure DevOps access). */
export function buildReviewContext(pr: PullRequest, changes: PrChangeFile[]): string {
  const files = changes.map((c) => `- ${c.changeType}: ${c.path}`).join('\n')
  return [
    `# PR ${pr.prId}: ${pr.title}`,
    '',
    `- Author: ${pr.authorName}`,
    `- Source: ${pr.sourceRefName}`,
    `- Target: ${pr.targetRefName}`,
    '',
    '## Description',
    '',
    pr.title,
    '',
    '## Changed files',
    '',
    files || '(none reported)',
    ''
  ].join('\n')
}

/**
 * Reflect a vote just cast on the PR's reviewers list: update my entry in place, or append a
 * minimal entry when the cached PR listed me nowhere (voting adds you as a reviewer server-side
 * too, so the local cache must agree until the next sync).
 */
export function applyMyVote(reviewers: PrReviewer[], myReviewerId: string, vote: PrVote): PrReviewer[] {
  if (reviewers.some((r) => r.id === myReviewerId)) {
    return reviewers.map((r) => (r.id === myReviewerId ? { ...r, vote } : r))
  }
  return [...reviewers, { id: myReviewerId, displayName: 'You', vote, isRequired: false }]
}

export function createPrInboxHandlers(d: PrInboxHandlerDeps): PrInboxHandlers {
  const warn = d.warn ?? ((m: string) => console.warn(m))

  const prCacheKey = (repositoryId: string, prId: number): string => `${repositoryId}:${prId}`

  // Votes cast since the last completed sync, so a sync whose snapshot was fetched before the
  // vote landed on ADO cannot revert the vote locally.
  const recentVotes = new Map<string, { vote: PrVote; reviewerId: string; at: number }>()

  const mustGetPr = (repositoryId: string, prId: number): PullRequest => {
    const pr = d.prCache.get(repositoryId, prId)
    if (!pr) throw new Error(`Unknown pull request ${prId} in ${repositoryId}. Sync first.`)
    return pr
  }

  /** My configured identity id, or null when it is missing, unresolvable, or not a UUID. */
  const identityUuid = async (): Promise<string | null> => {
    try {
      return (await d.resolveIdentity?.())?.id ?? null
    } catch {
      return null
    }
  }

  /** Every PR list leaving these handlers carries the derived "new changes since my review" flag. */
  const listDecorated = (): PullRequest[] =>
    decorateNewChanges(d.prCache.list(), (repositoryId, prId) => d.watermarks.get(repositoryId, prId))

  return {
    async sync() {
      const fetchStarted = Date.now()
      const { prs, failedRepos } = await d.ado.syncMyPrs()
      // Vote transitions are read against the cache as it was before this sync overwrites it.
      const before = d.prCache.list()
      // A failed repo contributes no rows this round; carry its last-known PRs forward so a
      // transient ADO error neither empties that repo's inbox nor re-baselines its review
      // watermarks (which would silently swallow a "new changes since my review" flag).
      const failed = new Set(failedRepos)
      const carried =
        failed.size > 0 ? [...prs, ...before.filter((pr) => failed.has(pr.repositoryName))] : prs
      // A vote cast while this fetch was in flight is live on ADO but may be missing from the
      // fetched snapshot; re-apply it so the sync cannot revert the vote locally. Votes older
      // than this fetch are already reflected server-side and their overlay entries expire.
      const merged = carried.map((pr) => {
        const entry = recentVotes.get(prCacheKey(pr.repositoryId, pr.prId))
        if (!entry || entry.at < fetchStarted) return pr
        return {
          ...pr,
          myVote: entry.vote,
          myReviewerId: entry.reviewerId,
          reviewers: applyMyVote(pr.reviewers, entry.reviewerId, entry.vote)
        }
      })
      for (const [key, entry] of recentVotes) {
        if (entry.at < fetchStarted) recentVotes.delete(key)
      }
      const plan = planWatermarks(before, merged)
      d.atomically(() => {
        d.prCache.replaceAll(merged)
        for (const w of plan.upserts) d.watermarks.upsert(w.repositoryId, w.prId, w.votedCommitId)
        for (const w of plan.deletes) d.watermarks.delete(w.repositoryId, w.prId)
        d.watermarks.prune(merged)
      })
      if (failedRepos.length) warn(`PR sync skipped repos: ${failedRepos.join(', ')}`)
      return listDecorated()
    },

    async list() {
      return listDecorated()
    },

    async getChanges(repositoryId, prId) {
      const pr = mustGetPr(repositoryId, prId)
      return d.localDiff.getChanges(pr, d.workspaceFolders())
    },

    async getFileDiff(repositoryId, prId, filePath) {
      const pr = mustGetPr(repositoryId, prId)
      return d.localDiff.getFileDiff(pr, filePath, d.workspaceFolders())
    },

    async getThreads(repositoryId, prId) {
      return d.ado.getThreads(repositoryId, prId)
    },

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

    async listDrafts(repositoryId, prId) {
      return d.drafts.listByPr(repositoryId, prId)
    },

    async addManualDraft(input) {
      // Enforce the publishable-side invariant here, not only in the UI (ADO anchors right-side only).
      return d.drafts.create({ ...input, side: 'right' }, 'manual')
    },

    async editDraft(id, body) {
      return d.drafts.setBody(id, body)
    },

    async discardDraft(id) {
      const draft = d.drafts.get(id)
      if (draft && (draft.status === 'published' || draft.status === 'publishing')) {
        throw new Error('Cannot discard a comment that is already published or being published.')
      }
      d.drafts.setStatus(id, 'discarded')
    },

    async publishDraft(id) {
      const draft = d.drafts.get(id)
      if (!draft) throw new Error(`Draft comment not found: ${id}`)
      if (draft.side !== 'right') {
        throw new Error('Only right-side (new file) comments can be published to Azure DevOps.')
      }
      // Reject comments anchored to a file that is not part of the PR (e.g. a hallucinated path).
      const draftPr = mustGetPr(draft.repositoryId, draft.prId)
      const changes = await d.localDiff.getChanges(draftPr, d.workspaceFolders())
      if (!changes.some((c) => c.path === draft.filePath)) {
        throw new Error(`Draft anchors to "${draft.filePath}", which is not changed in this PR.`)
      }
      // Atomic claim so a double-approve cannot post the same comment twice.
      if (!d.drafts.claimForPublish(id)) {
        throw new Error('This draft is already published or is being published.')
      }
      let threadId: number
      try {
        threadId = await d.ado.publishComment({
          repositoryId: draft.repositoryId,
          prId: draft.prId,
          filePath: draft.filePath,
          line: draft.line,
          body: draft.body
        })
      } catch (err) {
        // The comment was NOT posted - release the claim so the user can retry.
        d.drafts.setStatus(id, 'pending')
        throw err
      }
      // The comment IS live on the PR now. Record the thread id; if this bookkeeping write fails we
      // must NOT revert to pending (that would re-post a duplicate on retry) - leave it claimed.
      try {
        return d.drafts.setStatus(id, 'published', threadId)
      } catch (dbErr) {
        console.error(`Published draft ${id} as ADO thread ${threadId} but failed to record it locally`, dbErr)
        throw new Error(
          `Comment posted to the PR (thread ${threadId}) but local state could not be updated. Do not re-publish this draft.`
        )
      }
    },

    async castVote(repositoryId, prId, vote) {
      const pr = mustGetPr(repositoryId, prId)
      // My reviewer entry on the PR addresses the vote; a PR without one (I only author it, or the
      // row predates the column) falls back to my configured identity, which works only as a UUID.
      const reviewerId = pr.myReviewerId ?? (await identityUuid())
      if (!reviewerId) {
        throw new Error(
          'Cannot vote: your reviewer identity on this PR is unknown. Sync the inbox, or set INTERSECT_ADO_IDENTITY to your ADO user GUID.'
        )
      }
      await d.ado.castVote(repositoryId, prId, reviewerId, vote)
      // The vote is live on ADO now; record it locally in one transaction. Moving the watermark to
      // the PR's current source commit means "caught up as of this commit", which keeps the "new
      // changes since my review" radar correct immediately, without waiting for a full sync.
      const reviewers = applyMyVote(pr.reviewers, reviewerId, vote)
      d.atomically(() => {
        d.prCache.updateVote(repositoryId, prId, vote, reviewers, reviewerId)
        d.watermarks.upsert(repositoryId, prId, pr.sourceCommitId)
      })
      recentVotes.set(prCacheKey(repositoryId, prId), { vote, reviewerId, at: Date.now() })
      return decorateNewChanges([mustGetPr(repositoryId, prId)], (r, p) => d.watermarks.get(r, p))[0]
    },

    async startReview(repositoryId, prId) {
      const pr = mustGetPr(repositoryId, prId)
      const changes = await d.localDiff.getChanges(pr, d.workspaceFolders())
      const context = buildReviewContext(pr, changes)
      return d.review.start(pr, context, DEFAULT_COLS, DEFAULT_ROWS)
    },

    async endReview() {
      await d.review.end()
    },

    reviewInput(data) {
      d.review.input(data)
    },

    reviewResize(cols, rows) {
      d.review.resize(cols, rows)
    }
  }
}

export function registerPrInboxHandlers(ipcMain: IpcMain, h: PrInboxHandlers): void {
  ipcMain.handle(Channel.prInboxSync, () => h.sync())
  ipcMain.handle(Channel.prInboxList, () => h.list())
  ipcMain.handle(Channel.prInboxGetChanges, (_e, repositoryId: string, prId: number) =>
    h.getChanges(repositoryId, prId)
  )
  ipcMain.handle(Channel.prInboxGetFileDiff, (_e, repositoryId: string, prId: number, filePath: string) =>
    h.getFileDiff(repositoryId, prId, filePath)
  )
  ipcMain.handle(Channel.prInboxGetThreads, (_e, repositoryId: string, prId: number) =>
    h.getThreads(repositoryId, prId)
  )
  ipcMain.handle(Channel.prInboxAddComment, (_e, input: NewPrComment) => h.addComment(input))
  ipcMain.handle(
    Channel.prInboxReplyToThread,
    (_e, repositoryId: string, prId: number, threadId: number, body: string) =>
      h.replyToThread(repositoryId, prId, threadId, body)
  )
  ipcMain.handle(
    Channel.prInboxSetThreadStatus,
    (_e, repositoryId: string, prId: number, threadId: number, status: 'active' | 'fixed') =>
      h.setThreadStatus(repositoryId, prId, threadId, status)
  )
  ipcMain.handle(Channel.prInboxListDrafts, (_e, repositoryId: string, prId: number) =>
    h.listDrafts(repositoryId, prId)
  )
  ipcMain.handle(Channel.prInboxAddManualDraft, (_e, input: Parameters<PrInboxHandlers['addManualDraft']>[0]) =>
    h.addManualDraft(input)
  )
  ipcMain.handle(Channel.prInboxEditDraft, (_e, id: string, body: string) => h.editDraft(id, body))
  ipcMain.handle(Channel.prInboxDiscardDraft, (_e, id: string) => h.discardDraft(id))
  ipcMain.handle(Channel.prInboxPublishDraft, (_e, id: string) => h.publishDraft(id))
  ipcMain.handle(Channel.prInboxCastVote, (_e, repositoryId: string, prId: number, vote: PrVote) =>
    h.castVote(repositoryId, prId, vote)
  )
  ipcMain.handle(Channel.prInboxStartReview, (_e, repositoryId: string, prId: number) =>
    h.startReview(repositoryId, prId)
  )
  ipcMain.handle(Channel.prInboxEndReview, () => h.endReview())
  ipcMain.on(Channel.prInboxReviewInput, (_e, data: string) => h.reviewInput(data))
  ipcMain.on(Channel.prInboxReviewResize, (_e, cols: number, rows: number) => h.reviewResize(cols, rows))
}
