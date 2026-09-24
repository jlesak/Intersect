import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

/**
 * jsdom runs no layout, so nothing here can measure a rectangle. What it can do is hold the shell
 * to the one structural decision that makes a whole class of overlap impossible, which is worth
 * guarding precisely because the geometry it replaces is invisible to every other test in the run.
 */
// Read off disk with `fs`, because the bytes on disk are the subject here. Vite rewrites
// `new URL('./x', import.meta.url)` into a bundled asset reference, and a `?raw` import would hand
// the file to the CSS pipeline first.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'app.css'), 'utf8')

/** The declarations of one rule, found by its exact selector. */
function ruleBody(selector: string): string {
  const at = css.indexOf(`\n${selector} {`)
  if (at < 0) throw new Error(`no rule for "${selector}"`)
  const open = css.indexOf('{', at)
  const close = css.indexOf('}', open)
  if (close < 0) throw new Error(`unterminated rule for "${selector}"`)
  return css.slice(open + 1, close)
}

/**
 * The safe-mode banner stands for the whole session, which makes its placement a question of
 * correctness. Pinned to a viewport corner it covered the sidebar's footer rail, whose only button
 * is Settings - the section safe mode itself lands the user on - and both being anchored to the
 * same edge meant no window size and no collapsed rail escaped it.
 */
describe('the safe mode banner in the shell layout', () => {
  test('it takes a row in the grid', () => {
    const banner = ruleBody('.ix-safemode')
    expect(banner).not.toMatch(/position:\s*(fixed|absolute|sticky)/)
    expect(banner).toMatch(/grid-column:\s*1 \/ -1/)
    expect(banner).toMatch(/grid-row:\s*2/)
  })

  test('the shell grid keeps that row for it', () => {
    expect(ruleBody('.ix-app')).toMatch(/grid-template-rows:\s*1fr auto/)
  })
})

/**
 * The sidebar's middle slot must never be squeezed small enough to push its own footer out of its
 * box, because the panels below it paint later and then cover the footer's button - which stops
 * receiving clicks while still looking perfectly normal. The two declarations that prevent that
 * are easy to remove while tidying, and nothing else in the run would notice until a short-window
 * spec failed somewhere unrelated, so they are pinned here.
 */
describe('the sidebar middle slot', () => {
  const body = ruleBody('.ix-sidebar__body')

  test('it keeps a floor under itself', () => {
    // `min-height: 0` is the exact declaration that caused the overlap; min-content is the fix.
    expect(body).toMatch(/min-height:\s*min-content/)
    expect(body).not.toMatch(/min-height:\s*0/)
  })

  test('it clips, so nothing inside it can paint over a sibling panel', () => {
    expect(body).toMatch(/overflow:\s*hidden/)
  })

  test('the sidebar scrolls rather than covering a control it cannot fit', () => {
    expect(ruleBody('.ix-sidebar')).toMatch(/overflow-y:\s*auto/)
  })
})

/**
 * The sidebar's panels can now be dragged to a height. A panel given one must scroll inside it
 * rather than grow, for the same reason the middle slot above must keep its floor: a panel that
 * overflows its own box paints over the controls above it, which then look normal and take no
 * clicks. The dragged height comes from an inline style, so `overflow-y` here is the only thing
 * standing between a user's drag and that trap.
 */
describe('the resizable sidebar panels', () => {
  test('the section rail scrolls inside whatever height it is given', () => {
    const rail = ruleBody('.ix-rail')
    expect(rail).toMatch(/overflow-y:\s*auto/)
    expect(rail).toMatch(/flex:\s*none/)
  })

  test('the usage slot scrolls inside whatever height it is given', () => {
    const usage = ruleBody('.ix-sidebar__usage')
    expect(usage).toMatch(/overflow-y:\s*auto/)
    expect(usage).toMatch(/flex:\s*none/)
  })

  test('the middle slot holds the two horizontal dividers apart', () => {
    // With nothing between them the dividers land on the same pixel and the lower one takes every
    // press, so dragging the section rail silently resized the usage panel instead.
    const slot = ruleBody('.ix-sidebar__slot')
    expect(slot).toMatch(/flex:\s*1/)
    expect(slot).toMatch(/min-height:\s*min-content/)
    expect(slot).not.toMatch(/min-height:\s*0/)
  })

  test('the width divider tracks the sidebar column rather than a fixed offset', () => {
    // The grid column is the single source of the sidebar's width; a hard-coded left would drift
    // away from the edge it is supposed to sit on the moment the width changes.
    expect(ruleBody('.ix-resizer--vertical')).toMatch(/left:\s*calc\(var\(--sidebar-w\)/)
    expect(ruleBody('.ix-app')).toMatch(/position:\s*relative/)
  })
})

describe('the resizable PR file list', () => {
  test('its column follows the dragged width instead of a fixed 240px', () => {
    const detail = ruleBody('.ix-pr-detail')
    expect(detail).toMatch(/grid-template-columns:\s*var\(--pr-files-col\)/)
    expect(detail).not.toMatch(/240px 1fr/)
  })

  test('the column is clamped in CSS too, so a later window or sidebar change cannot swallow the diff', () => {
    expect(ruleBody('.ix-pr-detail')).toMatch(
      /--pr-files-col:\s*clamp\(160px, var\(--pr-files-w, 240px\), calc\(100% - 360px\)\)/
    )
  })

  test('the divider sits on the file list edge, inside the detail pane', () => {
    // The base vertical divider is placed at the sidebar's width, against the nearest positioned
    // ancestor. Without both of these the grip would float at the sidebar's offset in the pane.
    expect(ruleBody('.ix-pr-detail')).toMatch(/position:\s*relative/)
    expect(ruleBody('.ix-pr-detail > .ix-resizer--vertical')).toMatch(
      /left:\s*calc\(var\(--pr-files-col\) - 3px\)/
    )
  })
})

describe('the file name above a diff', () => {
  test('it reads like the file tree beside it, not like a structural eyebrow', () => {
    const path = ruleBody('.ix-pr-diff__path')
    expect(path).not.toMatch(/text-transform/)
    expect(path).not.toMatch(/letter-spacing/)
    expect(path).toMatch(/font-family:\s*var\(--font-mono\)/)
    expect(path).toMatch(/font-size:\s*11\.5px/)
    expect(path).toMatch(/color:\s*var\(--text\)/)
  })

  test('a long path is cut with an ellipsis rather than pushing the hint away', () => {
    const path = ruleBody('.ix-pr-diff__path')
    expect(path).toMatch(/min-width:\s*0/)
    expect(path).toMatch(/text-overflow:\s*ellipsis/)
    // The ellipsis only draws where the overflow is clipped.
    expect(path).toMatch(/overflow:\s*hidden/)
    expect(path).toMatch(/white-space:\s*nowrap/)
  })
})

describe('the diff frame', () => {
  test('the diff and its placeholder draw no border of their own', () => {
    for (const selector of ['.ix-pr-diff', '.ix-pr-diff__placeholder']) {
      expect(ruleBody(selector)).not.toMatch(/border(-radius)?:/)
    }
  })

  test('the toolbar keeps the one line that divides it from the diff', () => {
    expect(ruleBody('.ix-pr-diff__toolbar')).toMatch(/border-bottom:/)
  })

  test('the diff still clips, because Monaco paints to its box', () => {
    expect(ruleBody('.ix-pr-diff')).toMatch(/overflow:\s*hidden/)
  })
})

describe('the draft comment editor', () => {
  test('it grows with its text instead of offering a handle to drag', () => {
    const edit = ruleBody('.ix-pr-draft__edit')
    expect(edit).toMatch(/field-sizing:\s*content/)
    expect(edit).toMatch(/resize:\s*none/)
  })

  test('it keeps a floor, and overrides the fixed height every .ix-input has', () => {
    const edit = ruleBody('.ix-pr-draft__edit')
    expect(edit).toMatch(/min-height:\s*60px/)
    expect(edit).toMatch(/height:\s*auto/)
  })
})
