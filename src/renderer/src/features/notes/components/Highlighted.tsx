import type { ReactNode } from 'react'
import { matchRanges } from '@common/noteSearch'

/** An entry body with the words the search matched marked. */
export function Highlighted({ text, terms }: { text: string; terms: readonly string[] }) {
  const ranges = matchRanges(text, terms)
  if (ranges.length === 0) return <>{text}</>
  const parts: ReactNode[] = []
  let at = 0
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start))
    parts.push(
      <mark key={start} className="ix-notes__hit">
        {text.slice(start, end)}
      </mark>
    )
    at = end
  }
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}
