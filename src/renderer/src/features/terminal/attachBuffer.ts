/** One PTY chunk buffered while an attach round-trip was in flight. */
export interface BufferedChunk {
  data: string
  seq?: number
}

/**
 * The chunks a freshly attached terminal still has to render, in arrival order: everything
 * the attach snapshot already contains (seq <= lastSeq) is dropped so nothing renders twice,
 * everything newer is kept so nothing is lost. A chunk without a seq cannot be proven
 * duplicated, so it is kept - losing output is worse than a rare double render.
 */
export function drainAfterSeq(buffered: BufferedChunk[], lastSeq: number): string[] {
  return buffered
    .filter((chunk) => chunk.seq === undefined || chunk.seq > lastSeq)
    .map((chunk) => chunk.data)
}
