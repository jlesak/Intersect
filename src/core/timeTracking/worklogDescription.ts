import type { SessionSummary } from '@common/domain'
import { stripCommandWrappers } from '../sessions/sessionParse'

/** A worklog card's description never runs longer than one glanceable line. */
const MAX_DESCRIPTION = 140

/**
 * A single first sentence capped at 140 chars is all this ever yields, so no more than a small
 * prefix of the raw text can matter. Bounding it up front keeps the repeated regex passes below
 * from going quadratic on an unbounded pasted prompt (hundreds of KB), which runs synchronously
 * in the main process during a week read.
 */
const MAX_RAW = 2000

/** Match a full ANSI CSI escape sequence: ESC, `[`, parameter, intermediate and final bytes. */
const ANSI_CSI = /\[[0-9;?]*[ -/]*[@-~]/g

/** A paired XML block including its content, non-greedy so nested pairs peel one layer per pass. */
const PAIRED_XML = /<([A-Za-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g

/** An orphaned closing tag left behind once its opening partner was peeled away. */
const ORPHAN_CLOSE = /<\/[A-Za-z][\w-]*\s*>/g

/** A self-closing tag - unambiguously markup, unlike a bare `<` or a generic type in prose. */
const SELF_CLOSING = /<[A-Za-z][\w-]*(?:\s[^>]*)?\/>/g

/**
 * The first hyphenated tag - complete or unterminated. Every service block Claude Code injects is
 * hyphenated (task-notification, system-reminder, command-name, ...), so anchoring truncation on a
 * hyphen leaves ordinary prose (`a<b`, `Map<string, number>`, `<T>`) untouched.
 */
const UNCLOSED_TAG = /<[A-Za-z]\w*(?:-[\w-]+)+/

/** True when the text carries at least one letter - the bar for "something human remains". */
const HAS_LETTER = /\p{L}/u

/**
 * Reduce a raw Claude session string to a short, human-readable worklog description, or null when
 * nothing human is left. The raw text can carry ANSI colour codes, slash-command wrappers, and the
 * service XML blocks Claude Code injects (task notifications, system reminders); none of that is a
 * worklog and all of it is stripped before what remains is trimmed to a single first sentence.
 */
export function sanitizeWorklogDescription(raw: string): string | null {
  let text = raw.slice(0, MAX_RAW).replace(ANSI_CSI, '').replace(//g, '')
  text = stripCommandWrappers(text)

  // Peel paired blocks repeatedly so a nested structure collapses from the inside out: each pass
  // vanishes the innermost pairs, then any closing tag whose opener already went, then self-closing
  // tags. Repeat until nothing more is removed.
  let previous: string
  do {
    previous = text
    text = text
      .replace(PAIRED_XML, ' ')
      .replace(ORPHAN_CLOSE, ' ')
      .replace(SELF_CLOSING, ' ')
  } while (text !== previous)

  // Any tag left over is unclosed markup; the human text, if any, sits before it.
  const tagStart = text.search(UNCLOSED_TAG)
  if (tagStart !== -1) text = text.slice(0, tagStart)

  text = text.replace(/\s+/g, ' ').trim()

  const sentence = /^(.*?[.?!])\s/.exec(text)
  let result = sentence ? sentence[1] : text
  if (result.length > MAX_DESCRIPTION) {
    result = `${result.slice(0, MAX_DESCRIPTION - 1)}…`
  }

  return HAS_LETTER.test(result) ? result : null
}

/**
 * The auto-derived worklog description for a session: the first of the session title then each user
 * prompt (in order) that survives sanitizing, falling back to the folder name and finally the id
 * so a card always has a label even when every candidate was pure machine markup.
 */
export function autoDescription(
  session: Pick<SessionSummary, 'title' | 'userPrompts' | 'folderName' | 'id'>
): string {
  for (const candidate of [session.title, ...session.userPrompts]) {
    const clean = sanitizeWorklogDescription(candidate)
    if (clean !== null) return clean
  }
  return session.folderName || session.id
}
