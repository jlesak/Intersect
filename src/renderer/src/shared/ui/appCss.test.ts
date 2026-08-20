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
