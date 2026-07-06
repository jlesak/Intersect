import type { ReactNode } from 'react'
import type { Layout } from '@common/domain'
import { LAYOUTS } from '@common/domain'
import {
  IconLayoutColumns,
  IconLayoutGrid,
  IconLayoutRows,
  IconLayoutSingle
} from '@renderer/shared/ui/icons'

const ICONS: Record<Layout, ReactNode> = {
  single: <IconLayoutSingle />,
  columns: <IconLayoutColumns />,
  rows: <IconLayoutRows />,
  grid: <IconLayoutGrid />
}

const LABELS: Record<Layout, string> = {
  single: 'Single pane',
  columns: 'Two columns',
  rows: 'Two rows',
  grid: '2×2 grid'
}

/** Segmented control to choose the workspace's split layout. */
export function LayoutPicker({
  layout,
  onChange
}: {
  layout: Layout
  onChange: (layout: Layout) => void
}) {
  return (
    <div className="ix-layouts" role="group" aria-label="Split layout">
      {LAYOUTS.map((l) => (
        <button
          key={l}
          type="button"
          className={`ix-layout${l === layout ? ' ix-layout--active' : ''}`}
          title={LABELS[l]}
          aria-label={LABELS[l]}
          aria-pressed={l === layout}
          onClick={() => onChange(l)}
        >
          {ICONS[l]}
        </button>
      ))}
    </div>
  )
}
