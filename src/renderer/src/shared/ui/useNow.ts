import { useEffect, useState } from 'react'

/**
 * The current epoch ms, re-rendering the caller every `intervalMs`. Pass null to stop ticking -
 * a view with nothing live on screen should not be re-rendering on a timer.
 *
 * Anything shown as an age, an elapsed span or today's date needs this: read once at render, such
 * a value is correct at mount and quietly wrong from then on, and a day key derived from a frozen
 * clock keeps attributing work to yesterday after midnight.
 */
export function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (intervalMs === null) return
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])

  return now
}
