import type { PrThread, PullRequest } from './domain'
import { isThreadUnresolved } from './prBoard'

/**
 * Which review threads of my own pull request Claude is asked to fix: real (not system) threads
 * anchored to a file line, on either side of the diff, still open (Active or Pending, the same rule
 * as the inbox's open count), with at least one comment from someone other than me. A pull request
 * I only review has nothing to fix, so it answers empty.
 *
 * Shared by the renderer, which counts the result on the button, and the core, which writes the
 * same threads into Claude's first message, so the number on the button is the number Claude gets.
 */
export function selectFixThreads(
  pr: Pick<PullRequest, 'role' | 'authorId' | 'authorName'>,
  threads: PrThread[]
): PrThread[] {
  if (pr.role !== 'author') return []
  return threads.filter(
    (t) =>
      !t.isSystem &&
      t.filePath !== null &&
      (t.line !== null || (t.removedLine ?? null) !== null) &&
      isThreadUnresolved(t) &&
      t.comments.some((c) => !isMyComment(pr, c))
  )
}

const fold = (value: string): string => value.trim().toLowerCase()

/**
 * Whether I wrote the comment. I am the pull request's author here, so the author's identity is
 * mine. The identity id decides whenever both sides carry one, because display names are neither
 * unique nor stable; otherwise the display name is compared, trimmed and case-folded.
 */
function isMyComment(
  pr: Pick<PullRequest, 'authorId' | 'authorName'>,
  comment: PrThread['comments'][number]
): boolean {
  if (comment.authorId && pr.authorId) return fold(comment.authorId) === fold(pr.authorId)
  return fold(comment.authorName) === fold(pr.authorName)
}
