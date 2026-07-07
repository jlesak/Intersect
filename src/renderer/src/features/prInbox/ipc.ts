import type {
  DraftComment,
  FileDiff,
  NewManualDraft,
  PrChangeFile,
  PrThread,
  PrVote,
  PullRequest,
  ReviewSession
} from '@common/domain'
import { ipc } from '@renderer/shared/ipc/client'

// Thin, mockable seam between the PR-inbox store and the preload bridge.
export const sync = (): Promise<PullRequest[]> => ipc().prInbox.sync()
export const list = (): Promise<PullRequest[]> => ipc().prInbox.list()
export const getChanges = (repositoryId: string, prId: number): Promise<PrChangeFile[]> =>
  ipc().prInbox.getChanges(repositoryId, prId)
export const getFileDiff = (repositoryId: string, prId: number, filePath: string): Promise<FileDiff> =>
  ipc().prInbox.getFileDiff(repositoryId, prId, filePath)
export const getThreads = (repositoryId: string, prId: number): Promise<PrThread[]> =>
  ipc().prInbox.getThreads(repositoryId, prId)
export const listDrafts = (repositoryId: string, prId: number): Promise<DraftComment[]> =>
  ipc().prInbox.listDrafts(repositoryId, prId)
export const addManualDraft = (input: NewManualDraft): Promise<DraftComment> =>
  ipc().prInbox.addManualDraft(input)
export const editDraft = (id: string, body: string): Promise<DraftComment> =>
  ipc().prInbox.editDraft(id, body)
export const discardDraft = (id: string): Promise<void> => ipc().prInbox.discardDraft(id)
export const publishDraft = (id: string): Promise<DraftComment> => ipc().prInbox.publishDraft(id)
export const castVote = (repositoryId: string, prId: number, vote: PrVote): Promise<PullRequest> =>
  ipc().prInbox.castVote(repositoryId, prId, vote)
export const startReview = (repositoryId: string, prId: number): Promise<ReviewSession> =>
  ipc().prInbox.startReview(repositoryId, prId)
export const endReview = (): Promise<void> => ipc().prInbox.endReview()
export const reviewInput = (data: string): void => ipc().prInbox.reviewInput(data)
export const reviewResize = (cols: number, rows: number): void =>
  ipc().prInbox.reviewResize(cols, rows)
export const onReviewData = (cb: (data: string) => void): (() => void) =>
  ipc().prInbox.onReviewData(cb)
export const onReviewExit = (cb: (exitCode: number) => void): (() => void) =>
  ipc().prInbox.onReviewExit(cb)
export const onDraftAdded = (cb: (draft: DraftComment) => void): (() => void) =>
  ipc().prInbox.onDraftAdded(cb)
