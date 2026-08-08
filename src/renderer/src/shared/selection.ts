/**
 * What one chip filter has been narrowed to. `null` means everything, which is what an untouched
 * control means - and what keeps a control the user has not used from hiding anything, including
 * values that only appear in later data.
 */
export type Selection = readonly string[] | null

/** One choice offered by a chip filter: the value it narrows by, and how it reads to the user. */
export interface FilterOption {
  value: string
  label: string
}

/**
 * Whether an item carrying `values` survives the selection. An item with none of the chosen values
 * is out, and so is an item carrying no values at all: narrowing to an epic is a statement about
 * which epic, and an issue under no epic is not under that one.
 */
export function matchesSelection(selection: Selection, values: readonly string[]): boolean {
  if (selection === null) return true
  return values.some((value) => selection.includes(value))
}

/**
 * The selection after the user toggles one value, given every value currently on offer. A
 * selection that has grown back to cover everything collapses to "all", so a control cycled back
 * to where it started behaves exactly like one never touched.
 */
export function toggleSelection(
  selection: Selection,
  value: string,
  all: readonly string[]
): string[] | null {
  const current = selection ?? all
  const next = current.includes(value)
    ? current.filter((v) => v !== value)
    : [...current, value]
  return next.length === all.length ? null : next
}
