import type { ClaudeUsage, UsageLiveConsent, UsageRefresh } from '@common/domain'
import type { UsageConsentStore } from './usageConsent'

export interface UsageSourceDeps {
  /** The statusline snapshot file: what app-launched Claude sessions captured. */
  file: {
    get(): ClaudeUsage | null
    onChange(cb: (usage: ClaudeUsage | null) => void): () => void
  }
  /** The live query against Anthropic, resolving null when it is unavailable. */
  fetchLive(): Promise<ClaudeUsage | null>
  /** The user's answer on whether the live query may read Claude Code's credentials. */
  consent: UsageConsentStore
}

export interface UsageSource {
  /** The freshest snapshot either source has produced, or null if neither has produced one. */
  get(): ClaudeUsage | null
  /** Query the live API if consent allows, then report the freshest snapshot and how it went. */
  refresh(): Promise<UsageRefresh>
  /** The user's current answer on the live query. */
  consent(): UsageLiveConsent
  /** Record the user's answer, querying straight away when it is yes. */
  setConsent(granted: boolean): Promise<UsageRefresh>
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
 * It also owns the gate on the live source. Reading Claude Code's credentials is not something to
 * do on the app's own initiative, so until the user has said yes the live query is never attempted
 * and `fetchLive` is never called - which is the difference between the OS raising a credentials
 * dialog the user was warned about and one that appears out of nowhere at boot.
 *
 * Keeping all of this in the core means the renderer never has to reason about which source it is
 * looking at: it gets one snapshot, one answer on whether live is allowed, and one refresh that
 * either improves on the snapshot or leaves it alone.
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

  // Re-reading the file here keeps the on-demand read the file service already does: a watch
  // event the OS never delivered still gets noticed, it just cannot beat a newer live reading.
  function read(): ClaudeUsage | null {
    adopt(deps.file.get())
    return current
  }

  async function refresh(): Promise<UsageRefresh> {
    if (deps.consent.get() !== 'granted') return { usage: read(), live: 'not-allowed' }
    read()
    const live = await deps.fetchLive()
    adopt(live)
    return { usage: current, live: live ? 'ok' : 'unavailable' }
  }

  deps.file.onChange((usage) => adopt(usage))

  return {
    get: read,
    refresh,
    consent: () => deps.consent.get(),

    // Querying immediately on a yes means the user sees the panel fill in as the answer to the
    // question they just answered, rather than having to find the refresh button afterwards.
    async setConsent(granted) {
      deps.consent.set(granted ? 'granted' : 'declined')
      return granted ? refresh() : { usage: read(), live: 'not-allowed' }
    },

    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}
