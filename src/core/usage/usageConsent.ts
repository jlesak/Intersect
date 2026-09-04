import { USAGE_LIVE_CONSENTS, type UsageLiveConsent } from '@common/domain'
import type { AppStateRepo } from '../db/appStateRepo'

/** app_state key under which the live-usage consent answer is persisted. */
export const USAGE_LIVE_CONSENT_KEY = 'usage_live_consent'

export interface UsageConsentStore {
  get(): UsageLiveConsent
  set(consent: UsageLiveConsent): void
}

/**
 * Reads a persisted consent answer, treating anything unrecognized as `unasked`.
 *
 * Defaulting to `unasked` rather than `declined` is deliberate: a value this app cannot interpret
 * (an older build's spelling, a hand-edited row) means the answer is unknown, and the honest
 * response to an unknown answer is to ask again. Defaulting to `granted` is never an option -
 * nothing may read the user's credentials on the strength of a corrupted row.
 */
export function parseConsent(raw: string | null): UsageLiveConsent {
  return USAGE_LIVE_CONSENTS.includes(raw as UsageLiveConsent) ? (raw as UsageLiveConsent) : 'unasked'
}

/** The consent answer, persisted in app_state so it survives a restart and is asked once. */
export function createUsageConsentStore(
  appState: Pick<AppStateRepo, 'get' | 'set'>
): UsageConsentStore {
  return {
    get: () => parseConsent(appState.get(USAGE_LIVE_CONSENT_KEY)),
    set: (consent) => appState.set(USAGE_LIVE_CONSENT_KEY, consent)
  }
}
