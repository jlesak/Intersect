import { useEffect, useRef, useState } from 'react'
import type { Preset, SuspendStatus } from '@common/domain'
import { parseSessionId } from '@common/ipc'
import { useSettingsStore } from '@renderer/features/settings'
import { useTabsStore } from '@renderer/features/tabs'
import { useWorkspacesStore } from '@renderer/features/workspaces'
import { ipc } from '@renderer/shared/ipc/client'
import { useInterruptedStore } from '../interruptedStore'
import { attachSession, detachSession, ensureSession, respawnInterrupted } from '../terminalController'

/**
 * Hosts one live terminal in a pane. The xterm instance is owned by the controller (kept alive
 * across mounts), so this component just ensures the session exists and attaches/detaches the
 * persisted DOM node - React never remounts the terminal itself.
 *
 * On top of that it owns the suspend/resume recovery surface for a claude tab that a confirmed quit
 * left marked. A `suspended` tab either respawns automatically (the setting is on) or waits behind a
 * manual Resume button; either way the respawn is an explicitly new process - never a claim that the
 * old terminal buffer or a dev-server survived. A `resume-failed` tab never auto-spawns and offers
 * only recoverable actions, so a bad transcript or cwd can never produce a boot/respawn loop.
 */
export function TerminalPane({
  sessionId,
  preset,
  cwd,
  resumeSessionId,
  sessionStatus
}: {
  sessionId: string
  preset: Preset
  cwd: string
  resumeSessionId?: string | null
  sessionStatus?: SuspendStatus | null
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const interrupted = useInterruptedStore((s) => s.interrupted[sessionId] === true)
  const autoResume = useSettingsStore((s) => s.autoResume)
  const tabId = parseSessionId(sessionId)?.tabId ?? sessionId

  // Manual recovery flips these local intents; they only ever move a pane toward spawning, never
  // back, so the state machine cannot loop. `startFresh` drops the resume id (a brand-new session).
  const [manualResume, setManualResume] = useState(false)
  const [startFresh, setStartFresh] = useState(false)
  // A transient "restored after quit" note, shown once the resumed process comes up.
  const [restored, setRestored] = useState(false)

  // A local recovery intent overrides the persisted status so the pane can drive its own spawn
  // even before the parent re-hydrates the tab (which independently clears the status in the store).
  const failed = sessionStatus === 'resume-failed' && !startFresh
  const awaitingManual = sessionStatus === 'suspended' && !autoResume && !manualResume
  // Spawn when this is not a blocked recovery state: an ordinary tab, an auto-resume, or a pane the
  // user explicitly resumed / restarted fresh.
  const shouldSpawn = !failed && !awaitingManual
  const effectiveResumeId = startFresh ? null : resumeSessionId
  // Whether the spawn about to run is resuming a session the quit suspended (so we clear the marker).
  const resumingSuspended = sessionStatus === 'suspended'

  useEffect(() => {
    const host = hostRef.current
    if (!host || !shouldSpawn) return
    // Session creation resolves an attach round-trip first; only mount the DOM node once the
    // xterm exists, and skip it entirely if this pane unmounted in the meantime.
    let unmounted = false
    void ensureSession(sessionId, preset, cwd, effectiveResumeId).then(() => {
      if (unmounted) return
      attachSession(sessionId, host)
      // A suspended session that just respawned is a NEW process: clear the durable marker, sync
      // the local tab, and surface the "restored" note so it never masquerades as the old one.
      if (resumingSuspended) {
        void ipc().sessions.clearSuspended(tabId).catch(() => {})
        useTabsStore.getState().markResumed(tabId)
        setRestored(true)
      }
    })
    return () => {
      unmounted = true
      detachSession(sessionId)
    }
    // Keyed only on the inputs that must re-drive a spawn; resumingSuspended/tabId derive from
    // these same inputs, so they never need to independently re-trigger the effect.
  }, [sessionId, preset, cwd, effectiveResumeId, shouldSpawn])

  // Auto-dismiss the restored note; it is informational, not an action.
  useEffect(() => {
    if (!restored) return
    const timer = setTimeout(() => setRestored(false), 8000)
    return () => clearTimeout(timer)
  }, [restored])

  const chooseFolder = async (): Promise<void> => {
    const path = await useWorkspacesStore.getState().pickFolder()
    if (!path) return
    await useWorkspacesStore.getState().create(path)
    await useTabsStore.getState().removeTab(tabId)
  }

  return (
    <>
      <div className="ix-pane__host" ref={hostRef} />
      {restored && shouldSpawn && !interrupted && (
        <div className="ix-pane__restored">
          <span className="ix-faint">Obnoveno po ukončení - toto je nový terminál</span>
        </div>
      )}
      {failed && (
        <div className="ix-pane__interrupted">
          <span className="ix-faint">Session se nepodařilo obnovit - vyber, jak pokračovat</span>
          <div className="ix-row" style={{ gap: 6 }}>
            <button
              type="button"
              className="ix-btn ix-btn--ghost"
              onClick={() => {
                void ipc().sessions.clearSuspended(tabId).catch(() => {})
                useTabsStore.getState().markResumed(tabId)
                setStartFresh(true)
              }}
            >
              Spustit novou session
            </button>
            <button type="button" className="ix-btn ix-btn--ghost" onClick={() => void chooseFolder()}>
              Vybrat složku
            </button>
            <button
              type="button"
              className="ix-btn ix-btn--ghost"
              onClick={() => void useTabsStore.getState().removeTab(tabId)}
            >
              Archivovat
            </button>
          </div>
        </div>
      )}
      {awaitingManual && (
        <div className="ix-pane__interrupted">
          <span className="ix-faint">Session byla pozastavena při ukončení</span>
          <button
            type="button"
            className="ix-btn ix-btn--ghost"
            onClick={() => setManualResume(true)}
          >
            {resumeSessionId ? 'Obnovit Claude session' : 'Spustit novou session'}
          </button>
        </div>
      )}
      {interrupted && (
        <div className="ix-pane__interrupted">
          <span className="ix-faint">Session interrupted - the process did not survive</span>
          <button
            type="button"
            className="ix-btn ix-btn--ghost"
            onClick={() => void respawnInterrupted(sessionId, preset, cwd, effectiveResumeId)}
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
