import type { CommentSide, DraftSnippet, FileDiff } from '@common/domain'

/**
 * Lines of context kept on either side of the anchored line. Three is enough to show the statement
 * a finding is about together with what encloses it, and short enough that a summary of a dozen
 * comments still reads as a list rather than as a second copy of the diff.
 */
export const SNIPPET_CONTEXT_LINES = 3

/**
 * Split file text into its lines. A file's trailing newline terminates the last line rather than
 * starting an empty one, so it must not add a line the anchors could be measured against.
 */
function fileLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * The code one draft comment is about: the anchored line plus {@link SNIPPET_CONTEXT_LINES} of
 * context, read from the side of the diff the draft names.
 *
 * Null whenever the anchor cannot be honoured - a binary or oversized file whose content was never
 * read, a side the change emptied, or a line the file does not reach. Clamping to the last line
 * instead would put unrelated code under the comment and present it as the code being discussed,
 * which is worse than admitting the snippet is unavailable.
 */
export function cutSnippet(diff: FileDiff, side: CommentSide, line: number): DraftSnippet | null {
  if (diff.binary || diff.tooLarge) return null
  const lines = fileLines(side === 'left' ? diff.original : diff.modified)
  if (line < 1 || line > lines.length) return null
  const startLine = Math.max(1, line - SNIPPET_CONTEXT_LINES)
  const endLine = Math.min(lines.length, line + SNIPPET_CONTEXT_LINES)
  return {
    startLine,
    anchorLine: line,
    lines: lines.slice(startLine - 1, endLine),
    side
  }
}
