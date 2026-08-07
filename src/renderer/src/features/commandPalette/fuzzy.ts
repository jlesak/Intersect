import { fuzzyFilter } from '@renderer/shared/fuzzy'
import type { Command } from '@renderer/shared/registries/commandRegistry'

/** What a command is searchable by, most authoritative first: its title, then its own vocabulary. */
function searchableText(command: Command): string[] {
  return [command.title, ...(command.keywords ?? [])]
}

/**
 * Filters and ranks commands against a search query. An empty or whitespace-only query returns
 * every command unchanged, in the order given. Otherwise a command survives when the query is a
 * subsequence of its title or of one of its keywords, sorted best match first; a title hit beats
 * an equally good keyword hit.
 */
export function filterCommands(query: string, commands: Command[]): Command[] {
  return fuzzyFilter(query, commands, searchableText)
}
