import type { TodoTask } from '@common/domain'

/**
 * The TODO-list lines a Prepare-for-1:1 run splices into its prompt: every task whose text
 * mentions the person's full name or its first token (so "Ask Marek about the review" matches
 * the person "Marek K."), matched case-insensitively. Each line carries an open/done marker so
 * the briefing can tell outstanding items from finished ones. Pure and main-side only - the
 * hidden session never touches the TODO store itself.
 */
export function matchTodoMentions(person: string, open: TodoTask[], done: TodoTask[]): string[] {
  const full = person.trim().toLowerCase()
  if (!full) return []
  const firstToken = full.split(/\s+/)[0]
  // A one-character token (e.g. the "K." initial reduced to "k") would match almost everything.
  const needles = [full, ...(firstToken.length >= 2 && firstToken !== full ? [firstToken] : [])]

  const mentions = (tasks: TodoTask[], marker: string): string[] =>
    tasks
      .filter((t) => {
        const text = t.text.toLowerCase()
        return needles.some((needle) => text.includes(needle))
      })
      .map((t) => `- [${marker}] ${t.text}`)

  return [...mentions(open, 'open'), ...mentions(done, 'done')]
}
