import { useEffect, useRef } from 'react'
import type { Preset } from '@common/domain'
import { useInterruptedStore } from '../interruptedStore'
import { attachSession, detachSession, ensureSession, respawnInterrupted } from '../terminalController'

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
  const interrupted = useInterruptedStore((s) => s.interrupted[sessionId] === true)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    // Session creation resolves an attach round-trip first; only mount the DOM node once the
    // xterm exists, and skip it entirely if this pane unmounted in the meantime.
    let unmounted = false
    void ensureSession(sessionId, preset, cwd, resumeSessionId).then(() => {
      if (!unmounted) attachSession(sessionId, host)
    })
    return () => {
      unmounted = true
      detachSession(sessionId)
    }
  }, [sessionId, preset, cwd, resumeSessionId])

  return (
    <>
      <div className="ix-pane__host" ref={hostRef} />
      {interrupted && (
        <div className="ix-pane__interrupted">
          <span className="ix-faint">Session interrupted - the process did not survive</span>
          <button
            type="button"
            className="ix-btn ix-btn--ghost"
            onClick={() => void respawnInterrupted(sessionId, preset, cwd, resumeSessionId)}
          >
            {preset === 'claude'
              ? resumeSessionId
                ? 'Resume Claude session'
                : 'Start a new Claude session'
              : 'Restart shell'}
          </button>
        </div>
      )}
    </>
  )
}
