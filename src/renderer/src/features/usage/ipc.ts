import type { ClaudeUsage, UsageLiveConsent, UsageRefresh } from '@common/domain'
import { ipc } from '@renderer/shared/ipc/client'

// Thin, mockable seam between the usage store and the preload bridge.
export const get = (): Promise<ClaudeUsage | null> => ipc().usage.get()
export const refresh = (): Promise<UsageRefresh> => ipc().usage.refresh()
export const liveConsent = (): Promise<UsageLiveConsent> => ipc().usage.liveConsent()
export const setConsent = (granted: boolean): Promise<UsageRefresh> =>
  ipc().usage.setLiveConsent(granted)
export const onUsageChanged = (cb: (usage: ClaudeUsage | null) => void): (() => void) =>
  ipc().usage.onUsageChanged(cb)
