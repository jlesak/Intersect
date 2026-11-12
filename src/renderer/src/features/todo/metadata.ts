/**
 * The one rule for a draft that holds TODO project or tag ids. Until the project and tag lists have
 * loaded successfully nothing is known to be deleted, so every id stays. Once they have loaded, an
 * id missing from them is deleted and leaves the draft.
 */
export function isLive(id: string, known: readonly { id: string }[], ready: boolean): boolean {
  return !ready || known.some((entry) => entry.id === id)
}

/** The ids a draft may still submit; see {@link isLive}. */
export function liveIds(ids: string[], known: readonly { id: string }[], ready: boolean): string[] {
  return ready ? ids.filter((id) => isLive(id, known, ready)) : ids
}
