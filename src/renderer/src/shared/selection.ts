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
 * The stand-in for "carries nothing here", offered as a choice of its own wherever some items lack
 * the field entirely. Without it, unticking one epic would also hide every issue under no epic -
 * often the largest group on a board - with nothing on screen saying so or bringing them back.
 *
 * Deliberately built on a NUL, which no epic key, component or repository name can contain.
 */
export const NO_VALUE = '\u0000none'

/** How it reads in the chip list. */
export const NO_VALUE_LABEL = '(none)'

/**
 * An item's values in one chip dimension, standing in {@link NO_VALUE} when it has none, so that
 * "has no epic" is something the user can tick and untick like any other choice.
 */
export function dimensionValues(values: readonly string[]): readonly string[] {
  return values.length === 0 ? [NO_VALUE] : values
}

/**
 * The choices for one dimension: the values themselves, plus the "(none)" stand-in when some items
 * carry no value at all. A dimension no item carries offers nothing, so no dead control is drawn -
 * and a dimension every item carries has no "(none)" to offer.
 */
export function withNoneOption(options: FilterOption[], someLackValue: boolean): FilterOption[] {
  if (options.length === 0 || !someLackValue) return options
  return [...options, { value: NO_VALUE, label: NO_VALUE_LABEL }]
}

/**
 * The selection as it still applies to the values currently on offer.
 *
 * A dimension with nothing to choose between constrains nothing, because the control that set the
 * choice is not drawn at all and there would be no way to take it back. Values that merely
 * vanished from a still-populated dimension are dropped, so a chip's count can never claim more
 * than its ticked boxes.
 *
 * This masks the selection as it is read; it never rewrites it. The user's choice is remembered,
 * so a dimension that empties and later fills again comes back narrowed exactly as they left it,
 * with the chip back on screen saying so.
 *
 * An explicitly emptied selection is left empty. That is the user ticking None, with the control
 * still in front of them, and it is theirs to undo.
 */
export function reconcileSelection(selection: Selection, all: readonly string[]): Selection {
  if (selection === null || all.length === 0) return null
  return selection.filter((value) => all.includes(value))
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
