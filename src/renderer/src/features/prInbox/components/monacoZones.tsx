import * as monaco from 'monaco-editor'
import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface ZoneSpec {
  key: string
  afterLine: number
  node: ReactNode
}

interface MountedZone {
  key: string
  zoneId: string
  /** Portal target inside the zone's DOM node; its measured height drives the zone height. */
  inner: HTMLDivElement
  /** Monaco re-reads this object on layoutZone, so mutating heightInPx resizes the zone. */
  zone: monaco.editor.IViewZone
}

/**
 * Mount React content as Monaco view zones under diff lines. Each zone's height follows its
 * rendered content via a ResizeObserver, so threads and composers can grow freely.
 */
export function useMonacoZones(
  editor: monaco.editor.ICodeEditor | null,
  specs: ZoneSpec[]
): ReactNode {
  const [mounted, setMounted] = useState<MountedZone[]>([])
  // Zones are recreated when the set of anchors changes, not on every content re-render.
  const anchors = specs.map((s) => `${s.key}@${s.afterLine}`).join('|')

  useEffect(() => {
    if (!editor) {
      setMounted([])
      return
    }
    const zones: MountedZone[] = []
    editor.changeViewZones((accessor) => {
      for (const spec of specs) {
        const host = document.createElement('div')
        host.className = 'ix-zone-host'
        const inner = document.createElement('div')
        host.appendChild(inner)
        const zone: monaco.editor.IViewZone = {
          afterLineNumber: spec.afterLine,
          heightInPx: 60,
          domNode: host
        }
        const zoneId = accessor.addZone(zone)
        zones.push({ key: spec.key, zoneId, inner, zone })
      }
    })
    const observers = zones.map((z) => {
      const observer = new ResizeObserver(() => {
        const height = Math.ceil(z.inner.getBoundingClientRect().height)
        if (height > 0 && z.zone.heightInPx !== height + 6) {
          z.zone.heightInPx = height + 6
          editor.changeViewZones((a) => a.layoutZone(z.zoneId))
        }
      })
      observer.observe(z.inner)
      return observer
    })
    setMounted(zones)
    return () => {
      for (const o of observers) o.disconnect()
      editor.changeViewZones((accessor) => {
        for (const z of zones) accessor.removeZone(z.zoneId)
      })
      setMounted([])
    }
    // `anchors` captures the zone structure; depending on `specs` itself would tear zones down
    // on every content re-render.
  }, [editor, anchors])

  return (
    <>
      {mounted.map((z) => {
        const spec = specs.find((s) => s.key === z.key)
        return spec ? createPortal(spec.node, z.inner, z.key) : null
      })}
    </>
  )
}
