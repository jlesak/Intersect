import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { PRESETS, PRESET_META, type Preset } from '@common/domain'
import { IconPlus } from '@renderer/shared/ui/icons'

/**
 * The "+" affordance and its preset popover. Visibility is owned by the caller, because the
 * popover is also opened by a keyboard shortcut with no click to hang it off.
 */
export function PresetPicker({
  open,
  onOpenChange,
  onPick
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (preset: Preset) => void
}) {
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  // Anchor to the "+" button whenever the popover opens, so the keyboard path lands in exactly the
  // same place as a click. Before paint, or the popover would flash at its previous position.
  useLayoutEffect(() => {
    if (!open) return
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setPos({ x: r.left, y: r.bottom + 4 })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return
      onOpenChange(false)
    }
    const onResize = (): void => onOpenChange(false)
    // Escape closes every other transient surface in the app, and the shortcut can open this one
    // with the pointer nowhere near it - so a keyboard way out is the only way out.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onOpenChange(false)
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('resize', onResize)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onOpenChange])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="ix-iconbtn"
        title="New terminal"
        aria-label="New terminal"
        onClick={() => onOpenChange(!open)}
      >
        <IconPlus />
      </button>
      {open &&
        createPortal(
          <div ref={popRef} className="ix-presets" style={{ left: pos.x, top: pos.y }}>
            {PRESETS.map((preset) => {
              const meta = PRESET_META[preset]
              return (
                <button
                  key={preset}
                  type="button"
                  className="ix-preset"
                  onClick={() => {
                    onOpenChange(false)
                    onPick(preset)
                  }}
                >
                  <span className="ix-preset__badge">{meta.badge}</span>
                  <span style={{ flex: 1 }}>
                    <div>{meta.label}</div>
                    <div className="ix-preset__desc">{meta.description}</div>
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
