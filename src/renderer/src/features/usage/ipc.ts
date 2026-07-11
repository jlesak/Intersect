import type { ClaudeUsage } from '@common/domain'
import { ipc } from '@renderer/shared/ipc/client'

// Thin, mockable seam between the usage store and the preload bridge.
export const get = (): Promise<ClaudeUsage | null> => ipc().usage.get()
export const onUsageChanged = (cb: (usage: ClaudeUsage | null) => void): (() => void) =>
  ipc().usage.onUsageChanged(cb)
