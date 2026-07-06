import { useEffect, useRef } from 'react'
import type { Preset } from '@common/domain'
import { attachSession, detachSession, ensureSession } from '../terminalController'

/**
 * Hosts one live terminal in a pane. The xterm instance is owned by the controller (kept alive
 * across mounts), so this component just ensures the session exists and attaches/detaches the
 * persisted DOM node - React never remounts the terminal itself.
 */
export function TerminalPane({
  sessionId,
  preset,
  cwd,
  resumeSessionId
}: {
  sessionId: string
  preset: Preset
  cwd: string
  resumeSessionId?: string | null
}) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    ensureSession(sessionId, preset, cwd, resumeSessionId)
    attachSession(sessionId, host)
    return () => detachSession(sessionId)
  }, [sessionId, preset, cwd, resumeSessionId])

  return <div className="ix-pane__host" ref={hostRef} />
}
