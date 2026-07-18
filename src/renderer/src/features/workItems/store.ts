import { create } from 'zustand'
import type { NewWorkItemRef, WorkItemRef } from '@common/domain'
import { reportError } from '@renderer/shared/ui/toast'
import * as api from './ipc'

/**
 * A card-launch request recorded by this slice and executed by the app-layer wiring: open a
 * Claude session carrying the given primary work item. `folderPath` is the repository folder
 * that should host the session (the item's project binding); null means the currently selected
 * workspace.
 */
export interface WorkItemLaunch {
  ref: NewWorkItemRef
  folderPath: string | null
}

interface WorkItemsState {
  /** The workspace whose refs are hydrated; follows the tabs slice's workspace. */
  workspaceId: string | null
  /** The hydrated workspace's primary refs by tab id (a tab without one has no entry). */
  byTabId: Record<string, WorkItemRef>
  /**
   * A card launch the user requested, handed to the app layer which owns the cross-slice
   * workspace/tab coordination. This slice only records the intent; it never imports the
   * workspaces/tabs stores itself.
   */
  pendingLaunch: WorkItemLaunch | null
  /** The tab whose picker dialog is open, or null when no picker is shown. */
  pickerTabId: string | null
  hydrate(workspaceId: string): Promise<void>
  clear(): void
  /** Assign or replace the tab's primary ref; the store mirrors main's answer (no optimism). */
  assign(tabId: string, ref: NewWorkItemRef): Promise<void>
  clearPrimary(tabId: string): Promise<void>
  requestLaunch(launch: WorkItemLaunch): void
  clearLaunch(): void
  openPicker(tabId: string): void
  closePicker(): void
}

const index = (refs: WorkItemRef[]): Record<string, WorkItemRef> => {
  const byTabId: Record<string, WorkItemRef> = {}
  for (const ref of refs) byTabId[ref.tabId] = ref
  return byTabId
}

export const useWorkItemsStore = create<WorkItemsState>()((set, get) => ({
  workspaceId: null,
  byTabId: {},
  pendingLaunch: null,
  pickerTabId: null,

  async hydrate(workspaceId) {
    set({ workspaceId, byTabId: {} })
    try {
      const refs = await api.listForWorkspace(workspaceId)
      // A slower answer for a workspace the user already left must not clobber the current one.
      if (get().workspaceId !== workspaceId) return
      set({ byTabId: index(refs) })
    } catch {
      // A failed hydrate degrades to chips missing until the next workspace switch.
    }
  },

  clear() {
    set({ workspaceId: null, byTabId: {} })
  },

  async assign(tabId, ref) {
    try {
      const stored = await api.setPrimary(tabId, ref)
      set((s) => ({ byTabId: { ...s.byTabId, [tabId]: stored } }))
    } catch (e) {
      reportError('Could not set the work item', e)
    }
  },

  async clearPrimary(tabId) {
    try {
      await api.clearPrimary(tabId)
      set((s) => {
        const byTabId = { ...s.byTabId }
        delete byTabId[tabId]
        return { byTabId }
      })
    } catch (e) {
      reportError('Could not clear the work item', e)
    }
  },

  requestLaunch(launch) {
    set({ pendingLaunch: launch })
  },

  clearLaunch() {
    set({ pendingLaunch: null })
  },

  openPicker(tabId) {
    set({ pickerTabId: tabId })
  },

  closePicker() {
    set({ pickerTabId: null })
  }
}))
