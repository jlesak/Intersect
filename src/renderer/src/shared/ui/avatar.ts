/** Avatar initials from a display name: first letter of the first two words ("Jan Lesak" -> "JL"). */
export function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '?'
  )
}

/**
 * The avatar palette. Muted enough that a column of avatars stays background to the titles beside
 * them, and far enough apart in hue that two people in one list are told apart at a glance. None of
 * these is the accent colour: an avatar must never read as the interactive part of a row.
 */
const AVATAR_COLORS = [
  '#3f87c5',
  '#3f9e6e',
  '#c05e5e',
  '#9a6fc2',
  '#b98a4a',
  '#4f8f96',
  '#a2708f',
  '#6b83c0'
]

/**
 * One person's avatar colour, derived from their name so it is the same everywhere and across
 * restarts. Azure DevOps hands out no colours and no images this app can use, and a colour that
 * shifted between two views of the same person would be worse than no colour at all.
 */
export function avatarColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}
