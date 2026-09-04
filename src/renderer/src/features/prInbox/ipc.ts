import type {
  DraftComment,
  FileDiff,
  NewPrComment,
  PrChangeFile,
  PrThread,
  PrVote,
  PullRequest,
  ReviewSession,
  UnfinishedDraftReview
} from '@common/domain'
import type { ReviewDataEvent, ReviewExitEvent } from '@common/ipc'
import { ipc } from '@renderer/shared/ipc/client'

// Thin, mockable seam between the PR-inbox store and the preload bridge.
export const sync = (): Promise<PullRequest[]> => ipc().prInbox.sync()
export const list = (): Promise<PullRequest[]> => ipc().prInbox.list()
export const getSyncedAt = (): Promise<number | null> => ipc().prInbox.getSyncedAt()
export const getChanges = (repositoryId: string, prId: number): Promise<PrChangeFile[]> =>
  ipc().prInbox.getChanges(repositoryId, prId)
export const getFileDiff = (repositoryId: string, prId: number, filePath: string): Promise<FileDiff> =>
  ipc().prInbox.getFileDiff(repositoryId, prId, filePath)
export const getThreads = (repositoryId: string, prId: number): Promise<PrThread[]> =>
  ipc().prInbox.getThreads(repositoryId, prId)
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
export const listDrafts = (repositoryId: string, prId: number): Promise<DraftComment[]> =>
  ipc().prInbox.listDrafts(repositoryId, prId)
export const listUnfinishedDraftReviews = (): Promise<UnfinishedDraftReview[]> =>
  ipc().prInbox.listUnfinishedDraftReviews()
export const editDraft = (id: string, body: string): Promise<DraftComment> =>
  ipc().prInbox.editDraft(id, body)
export const discardDraft = (id: string): Promise<void> => ipc().prInbox.discardDraft(id)
export const publishDraft = (id: string): Promise<DraftComment> => ipc().prInbox.publishDraft(id)
export const castVote = (repositoryId: string, prId: number, vote: PrVote): Promise<PullRequest> =>
  ipc().prInbox.castVote(repositoryId, prId, vote)
export const startReview = (repositoryId: string, prId: number): Promise<ReviewSession> =>
  ipc().prInbox.startReview(repositoryId, prId)
export const listActiveReviews = (): Promise<ReviewSession[]> =>
  ipc().prInbox.listActiveReviews()
export const endReview = (sessionId: string): Promise<void> => ipc().prInbox.endReview(sessionId)
export const reviewInput = (sessionId: string, data: string): void =>
  ipc().prInbox.reviewInput(sessionId, data)
export const reviewResize = (sessionId: string, cols: number, rows: number): void =>
  ipc().prInbox.reviewResize(sessionId, cols, rows)
export const onReviewData = (cb: (msg: ReviewDataEvent) => void): (() => void) =>
  ipc().prInbox.onReviewData(cb)
export const onReviewExit = (cb: (msg: ReviewExitEvent) => void): (() => void) =>
  ipc().prInbox.onReviewExit(cb)
export const onDraftAdded = (cb: (draft: DraftComment) => void): (() => void) =>
  ipc().prInbox.onDraftAdded(cb)
export const openExternal = (url: string): Promise<void> => ipc().system.openExternal(url)
