import type { ClaudeUsage, UsageLiveConsent, UsageLiveStatus } from '@common/domain'
import { createStore } from '@renderer/shared/store/createStore'
import * as api from './ipc'

interface UsageState {
  /** The last captured Claude Code rate-limit snapshot, or null before the first one arrives. */
  usage: ClaudeUsage | null
  /** Whether the live query is allowed to read Claude Code's credentials. */
  consent: UsageLiveConsent
  /** How the last live query went, or null while none has been attempted this session. */
  live: UsageLiveStatus | null
  /** True while a live query is in flight, so the refresh button can show it is working. */
  refreshing: boolean
  /** Fetch the current snapshot and the consent answer once, at boot. */
  hydrate(): Promise<void>
  /** Ask Anthropic for the current usage. A no-op the core turns down while consent is missing. */
  refresh(): Promise<void>
  /** Answer the consent question. A yes queries straight away. */
  setConsent(granted: boolean): Promise<void>
  /** Listen for fresh snapshots pushed from main; returns an unsubscribe fn. */
  subscribe(): () => void
}

/**
 * The Claude usage sidebar panel's state: a single snapshot, always visible, with no error UI of
 * its own - a fetch failure or a snapshot that has not arrived yet both read the same way (null),
 * which the panel shows as its quiet "no data yet" hint. A failed refresh keeps the snapshot the
 * panel already had, since a stale reading beats blanking the panel over a transient failure.
 *
 * `consent` is what decides whether the panel asks its question or shows its meters, so it is read
 * at boot alongside the snapshot. `live` is the one piece of failure detail worth surfacing: a user
 * who granted consent and still gets nothing needs to be told, or the refresh button looks broken.
 */
export const useUsageStore = createStore<UsageState>()((set, get) => ({
  usage: null,
  consent: 'unasked',
  live: null,
  refreshing: false,

  async hydrate() {
    try {
      const [usage, consent] = await Promise.all([api.get(), api.liveConsent()])
      set({ usage, consent })
    } catch {
      set({ usage: null })
      return
    }
    // The cached snapshot paints immediately; the live query then corrects it, which matters
    // because the cached one can be days old (it only moves when a Claude session runs in-app).
    // The core turns this down unless consent is granted, so boot reads no credentials on its own.
    await get().refresh()
  },

  async refresh() {
    set({ refreshing: true })
    try {
      const { usage, live } = await api.refresh()
      set({ live })
      // A null snapshot means the query had nothing to offer (no token, endpoint unreachable), so
      // the core is telling us to keep what we have rather than to forget it.
      if (usage) set({ usage })
    } catch {
      // Same treatment: an unreachable core is not a reason to blank the panel.
    } finally {
      set({ refreshing: false })
    }
  },

  async setConsent(granted) {
    // Recorded optimistically so the question closes on the click rather than after the round
    // trip, which on a yes includes the OS credentials prompt the user is about to answer.
    set({ consent: granted ? 'granted' : 'declined', refreshing: granted })
    try {
      const { usage, live } = await api.setConsent(granted)
      set({ live })
      if (usage) set({ usage })
    } catch {
      // The answer stays as clicked; a failed round trip is not a reason to re-ask the question.
    } finally {
      set({ refreshing: false })
    }
  },

  subscribe() {
    return api.onUsageChanged((usage) => set({ usage }))
  }
}))
