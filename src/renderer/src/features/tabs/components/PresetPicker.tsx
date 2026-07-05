import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { PRESETS, PRESET_META, type Preset } from '@common/domain'
import { IconPlus } from '@renderer/shared/ui/icons'

/** The "+" affordance: opens a small popover to pick which terminal preset to open. */
export function PresetPicker({ onPick }: { onPick: (preset: Preset) => void }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return
      setOpen(false)
    }
    const onResize = (): void => setOpen(false)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="jv-iconbtn"
        title="New terminal"
        aria-label="New terminal"
        onClick={() => {
          const r = btnRef.current?.getBoundingClientRect()
          if (r) setPos({ x: r.left, y: r.bottom + 4 })
          setOpen((v) => !v)
        }}
      >
        <IconPlus />
      </button>
      {open &&
        createPortal(
          <div ref={popRef} className="jv-presets" style={{ left: pos.x, top: pos.y }}>
            {PRESETS.map((preset) => {
              const meta = PRESET_META[preset]
              return (
                <button
                  key={preset}
                  type="button"
                  className="jv-preset"
                  onClick={() => {
                    setOpen(false)
                    onPick(preset)
                  }}
                >
                  <span className="jv-preset__badge">{meta.badge}</span>
                  <span style={{ flex: 1 }}>
                    <div>{meta.label}</div>
                    <div className="jv-preset__desc">{meta.description}</div>
                  </span>
                </button>
              )
            })}
          </div>,
          document.body
        )}
    </>
  )
}
