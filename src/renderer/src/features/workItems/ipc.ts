import type {
  NewWorkItemRef,
  WorkItemCandidateGroup,
  WorkItemRef,
  WorkItemRefEvent
} from '@common/domain'
import { ipc } from '@renderer/shared/ipc/client'

// Thin, mockable seam between the work-items store and the preload bridge.
export const listForWorkspace = (workspaceId: string): Promise<WorkItemRef[]> =>
  ipc().workItems.listForWorkspace(workspaceId)
export const setPrimary = (tabId: string, ref: NewWorkItemRef): Promise<WorkItemRef> =>
  ipc().workItems.setPrimary(tabId, ref)
export const clearPrimary = (tabId: string): Promise<void> =>
  ipc().workItems.clearPrimary(tabId)
export const history = (tabId: string): Promise<WorkItemRefEvent[]> =>
  ipc().workItems.history(tabId)
export const searchCandidates = (
  query: string,
  workspaceId: string | null
): Promise<WorkItemCandidateGroup[]> => ipc().workItems.searchCandidates(query, workspaceId)
