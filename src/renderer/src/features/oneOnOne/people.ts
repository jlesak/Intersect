import type { OtoRun } from '@common/domain'

/** A typed name with its incidental spacing taken out, for showing back to the user. */
const tidy = (name: string): string => name.trim().replace(/\s+/g, ' ')

/**
 * The identity a typed name stands for: case folded, inner whitespace collapsed, trailing
 * punctuation dropped. "Marek", "marek" and "Marek." are one person. "Marek" and "marek k" stay
 * two, because telling them apart from two genuinely different Mareks needs a similarity rule
 * that will eventually be wrong about somebody.
 *
 * This is a grouping key computed in the renderer. Nothing rewrites the name a run was actually
 * started with; the history records what happened.
 */
export function personKey(name: string): string {
  return tidy(name)
    .toLowerCase()
    .replace(/[.,;:!?]+$/, '')
    .trim()
}

/**
 * Everyone the run history knows, most recently used first, one entry per identity, spelled the
 * way the newest run spelled it. This is what the person field offers, so a name already used
 * gets picked rather than typed again slightly differently.
 */
export function peopleFromRuns(runs: OtoRun[]): string[] {
  const seen = new Set<string>()
  const people: string[] = []
  for (const run of newestFirst(runs)) {
    const key = personKey(run.person)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    people.push(tidy(run.person))
  }
  return people
}

/** One person's runs, newest first, under the name their newest run used. */
export interface PersonRuns {
  key: string
  person: string
  runs: OtoRun[]
}

/**
 * The run history gathered per person, the people ordered by whoever was run most recently and
 * each person's runs newest first. A flat history buries the last conversation with one person
 * under everyone else's.
 */
export function groupRunsByPerson(runs: OtoRun[]): PersonRuns[] {
  const groups = new Map<string, PersonRuns>()
  for (const run of newestFirst(runs)) {
    const key = personKey(run.person)
    const group = groups.get(key)
    // Insertion order is newest-run-first, and so is the order the groups come out in.
    if (group) group.runs.push(run)
    else groups.set(key, { key, person: tidy(run.person), runs: [run] })
  }
  return [...groups.values()]
}

/**
 * The runs by recency. Main already answers newest first, and a run pushed in while the window is
 * open goes to the front, so this is a guard rather than a correction.
 */
function newestFirst(runs: OtoRun[]): OtoRun[] {
  return [...runs].sort((a, b) => b.createdAt - a.createdAt)
}
