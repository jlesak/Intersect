import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import type { AgentRuntimeDay, TimeEntry } from '@common/domain'
import { DayColumn } from './DayColumn'

// Vitest transforms TSX without the renderer's Vite React plugin, so provide the classic runtime.
vi.stubGlobal('React', React)

function entry(over: Partial<TimeEntry> = {}): TimeEntry {
  return {
    id: 'e1',
    source: 'auto',
    day: '2026-07-06',
    description: 'Session e1',
    issueKey: null,
    durationMs: 60 * 60_000,
    ...over
  }
}

function render(over: {
  entries?: TimeEntry[]
  runtime?: AgentRuntimeDay
}): HTMLDivElement {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(
    React.createElement(DayColumn, {
      day: '2026-07-06',
      name: 'Monday',
      isToday: false,
      entries: over.entries ?? [],
      runtime: over.runtime
    })
  )
  return host
}

describe('DayColumn agent-runtime supporting figure', () => {
  test('renders the runtime figure distinctly from worklog EntryCards', () => {
    const host = render({
      entries: [entry()],
      runtime: { localDate: '2026-07-06', minutes: 94, agents: 2, hasLowConfidence: false }
    })

    const runtime = host.querySelector('.ix-tt__day-runtime')
    expect(runtime).not.toBeNull()
    expect(runtime?.textContent).toContain('2 agents · 1h 34m runtime')

    // It is context, not a worklog: it carries the hint class and is NOT inside an EntryCard.
    expect(runtime?.classList.contains('ix-ctx__hint')).toBe(true)
    expect(runtime?.closest('.ix-tt-card')).toBeNull()

    // The worklog card is a separate element with no runtime marker on it.
    const card = host.querySelector('.ix-tt-card')
    expect(card).not.toBeNull()
    expect(card?.querySelector('.ix-tt__day-runtime')).toBeNull()
  })

  test('marks a low-confidence (JSONL-derived) figure as approximate', () => {
    const host = render({
      runtime: { localDate: '2026-07-06', minutes: 8, agents: 1, hasLowConfidence: true }
    })
    const runtime = host.querySelector('.ix-tt__day-runtime')
    expect(runtime?.textContent).toContain('1 agent · 8m runtime')
    expect(host.querySelector('.ix-tt__day-runtime-approx')).not.toBeNull()
  })

  test('shows no runtime line when there is no evidence for the day', () => {
    const host = render({ entries: [entry()] })
    expect(host.querySelector('.ix-tt__day-runtime')).toBeNull()
  })
})
