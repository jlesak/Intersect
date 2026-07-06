import type { IpcMain } from 'electron'
import { Channel, type IpcApi } from '@common/ipc'
import type { PrChangeFile, PullRequest } from '@common/domain'
import type { DraftCommentRepo } from '../db/draftCommentRepo'
import type { PrCacheRepo } from '../db/prCacheRepo'
import type { AdoService } from '../prInbox/adoService'
import type { ReviewManager } from '../prInbox/reviewManager'

/** Main implements everything except the renderer-only broadcast subscriptions. */
export type PrInboxHandlers = Omit<
  IpcApi['prInbox'],
  'onReviewData' | 'onReviewExit' | 'onDraftAdded'
>

export interface PrInboxHandlerDeps {
  prCache: PrCacheRepo
  drafts: DraftCommentRepo
  ado: AdoService
  review: ReviewManager
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

export function createPrInboxHandlers(d: PrInboxHandlerDeps): PrInboxHandlers {
  const warn = d.warn ?? ((m: string) => console.warn(m))

  const mustGetPr = (repositoryId: string, prId: number): PullRequest => {
    const pr = d.prCache.get(repositoryId, prId)
    if (!pr) throw new Error(`Unknown pull request ${prId} in ${repositoryId}. Sync first.`)
    return pr
  }

  return {
    async sync() {
      const { prs, failedRepos } = await d.ado.syncMyPrs()
      d.prCache.replaceAll(prs)
      if (failedRepos.length) warn(`PR sync skipped repos: ${failedRepos.join(', ')}`)
      return d.prCache.list()
    },

    async list() {
      return d.prCache.list()
    },

    async getChanges(repositoryId, prId) {
      return d.ado.getChanges(repositoryId, prId)
    },

    async getFileDiff(repositoryId, prId, filePath) {
      const pr = mustGetPr(repositoryId, prId)
      const changes = await d.ado.getChanges(repositoryId, prId)
      const change = changes.find((c) => c.path === filePath)
      return d.ado.getFileDiff({
        repositoryId,
        filePath,
        originalPath: change?.originalPath ?? null,
        sourceCommit: pr.sourceCommitId,
        targetCommit: pr.targetCommitId,
        changeType: change?.changeType ?? 'edit'
      })
    },

    async getThreads(repositoryId, prId) {
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
      const changes = await d.ado.getChanges(draft.repositoryId, draft.prId)
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

    async startReview(repositoryId, prId) {
      const pr = mustGetPr(repositoryId, prId)
      const changes = await d.ado.getChanges(repositoryId, prId)
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
  ipcMain.handle(Channel.prInboxListDrafts, (_e, repositoryId: string, prId: number) =>
    h.listDrafts(repositoryId, prId)
  )
  ipcMain.handle(Channel.prInboxAddManualDraft, (_e, input: Parameters<PrInboxHandlers['addManualDraft']>[0]) =>
    h.addManualDraft(input)
  )
  ipcMain.handle(Channel.prInboxEditDraft, (_e, id: string, body: string) => h.editDraft(id, body))
  ipcMain.handle(Channel.prInboxDiscardDraft, (_e, id: string) => h.discardDraft(id))
  ipcMain.handle(Channel.prInboxPublishDraft, (_e, id: string) => h.publishDraft(id))
  ipcMain.handle(Channel.prInboxStartReview, (_e, repositoryId: string, prId: number) =>
    h.startReview(repositoryId, prId)
  )
  ipcMain.handle(Channel.prInboxEndReview, () => h.endReview())
  ipcMain.on(Channel.prInboxReviewInput, (_e, data: string) => h.reviewInput(data))
  ipcMain.on(Channel.prInboxReviewResize, (_e, cols: number, rows: number) => h.reviewResize(cols, rows))
}
