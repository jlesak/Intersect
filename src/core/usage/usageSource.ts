import type { ClaudeUsage } from '@common/domain'

export interface UsageSourceDeps {
  /** The statusline snapshot file: what app-launched Claude sessions captured. */
  file: {
    get(): ClaudeUsage | null
    onChange(cb: (usage: ClaudeUsage | null) => void): () => void
  }
  /** The live query against Anthropic, resolving null when it is unavailable. */
  fetchLive(): Promise<ClaudeUsage | null>
}

export interface UsageSource {
  /** The freshest snapshot either source has produced, or null if neither has produced one. */
  get(): ClaudeUsage | null
  /** Query the live API, then return the freshest snapshot known afterwards. */
  refresh(): Promise<ClaudeUsage | null>
  /** Fired whenever the freshest snapshot changes. Returns an unsubscribe fn. */
  onChange(cb: (usage: ClaudeUsage | null) => void): () => void
}

/**
 * Arbitrates between the app's two sources of Claude usage, which can each be stale in their own
 * way: the statusline snapshot file only moves when a Claude session runs inside this app, and the
 * live API only answers while Claude Code holds a valid token. Whichever produced the newer
 * `capturedAt` wins, so a refresh cannot be undone by a stale file push arriving afterwards, and a
 * genuinely fresh statusline capture is not held back by an older live reading.
 *
 * Keeping this in the core means the renderer never has to reason about which source it is looking
 * at: it gets one snapshot, and one refresh that either improves on it or leaves it alone.
 */
export function createUsageSource(deps: UsageSourceDeps): UsageSource {
  const listeners = new Set<(usage: ClaudeUsage | null) => void>()
  let current: ClaudeUsage | null = deps.file.get()

  /** Adopts `candidate` when it is strictly newer than what we hold, notifying on adoption. */
  function adopt(candidate: ClaudeUsage | null): void {
    if (!candidate) return
    if (current && candidate.capturedAt <= current.capturedAt) return
    current = candidate
    for (const cb of listeners) cb(current)
  }

  deps.file.onChange((usage) => adopt(usage))

  return {
    // Re-reading the file here keeps the on-demand read the file service already does: a watch
    // event the OS never delivered still gets noticed, it just cannot beat a newer live reading.
    get() {
      adopt(deps.file.get())
      return current
    },

    async refresh() {
      adopt(await deps.fetchLive())
      return current
    },

    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}
