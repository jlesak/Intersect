import type { Command } from '@renderer/shared/registries/commandRegistry'

/** One block of the palette list: an optional heading and the commands filed under it. */
export interface PaletteSection {
  heading: string | null
  commands: Command[]
}

/** The heading ungrouped commands are collected under, always last. */
const UNGROUPED = 'Other'

/** The heading the recently-used commands lead with, always first. */
const RECENT = 'Recent'

/**
 * How the palette lays its results out.
 *
 * While the user is typing, rank is the only thing that matters and the list stays flat: group
 * boundaries would push a better match below a worse one. At rest there is no ranking to respect,
 * so the commands are filed under their groups, which turns an undifferentiated wall into
 * something scannable.
 *
 * Groups are ordered alphabetically rather than by registration. Registration order is an
 * implementation detail nobody using the app can see or predict, and it shifts whenever a slice
 * is rewired; the alphabet at least tells the user where to look.
 *
 * At rest the recently-used commands lead, because what someone did yesterday is the best
 * available guess at what they want now. They are lifted out of their groups rather than
 * repeated: the same command twice in one short list costs more in confusion than it saves in
 * consistency. `recentIds` naming a command that is no longer listed is ignored, so a renamed or
 * retired command leaves no gap behind.
 */
export function paletteSections(
  results: Command[],
  query: string,
  recentIds: readonly string[] = []
): PaletteSection[] {
  if (query.trim() !== '') return results.length === 0 ? [] : [{ heading: null, commands: results }]

  const byId = new Map(results.map((command) => [command.id, command]))
  const recent = recentIds
    .map((id) => byId.get(id))
    .filter((command): command is Command => command !== undefined)
  const recentIdSet = new Set(recent.map((command) => command.id))

  const byHeading = new Map<string, Command[]>()
  for (const command of results) {
    if (recentIdSet.has(command.id)) continue
    const heading = command.group ?? UNGROUPED
    const bucket = byHeading.get(heading)
    if (bucket) bucket.push(command)
    else byHeading.set(heading, [command])
  }

  const ungrouped = byHeading.get(UNGROUPED)
  byHeading.delete(UNGROUPED)
  const sections = [...byHeading]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([heading, commands]) => ({ heading, commands }))
  if (ungrouped) sections.push({ heading: UNGROUPED, commands: ungrouped })
  if (recent.length > 0) sections.unshift({ heading: RECENT, commands: recent })
  return sections
}
