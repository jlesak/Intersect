import { resolve } from 'node:path'
import { checkBundleFreshness, resolveGuardAction } from './e2eFreshness'

/**
 * Refuse an E2E run whose built app no longer matches the working tree.
 *
 * Hung on Playwright's global setup rather than on the `e2e` script so that every entry point is
 * covered, including a bare `npx playwright test` while iterating on one spec - the command that
 * quietly reported green against an old build twice in one week. The build is deliberately not run
 * from here: the fast inner loop is the whole reason the bare command gets reached for, and a hook
 * that silently rebuilt would simply move the surprise somewhere else.
 */
export default function guardAgainstAStaleBuild(): void {
  const repoRoot = resolve(__dirname, '..')
  const action = resolveGuardAction(checkBundleFreshness(repoRoot), process.env.E2E_ALLOW_STALE)
  if (action.kind === 'warn') console.warn(action.message)
  if (action.kind === 'fail') throw new Error(action.message)
}
