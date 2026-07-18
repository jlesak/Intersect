import type { OtoRun } from '@common/domain'
import type { OtoRunRepo } from '../db/otoRunRepo'
import type { OtoManager, OtoStartRequest } from './otoManager'

export interface OtoE2eStubDeps {
  runs: OtoRunRepo
  onRunChanged: (run: OtoRun) => void
  env: NodeJS.ProcessEnv
}

/**
 * Deterministic 1:1 backend for E2E runs, so the UI's states can be exercised without spawning a
 * real hidden Claude session. It writes through the real repo, so persistence and boot
 * reconciliation run the production path. `INTERSECT_E2E_OTO` picks the outcome: `done` (default)
 * finishes each run with a fake result after a short delay (so the running state is observable),
 * `failed` fails it the same way, and `running` never resolves.
 */
export function createOtoE2eStub(d: OtoE2eStubDeps): OtoManager {
  const mode = d.env.INTERSECT_E2E_OTO ?? 'done'
  const timers = new Set<NodeJS.Timeout>()
  let disposed = false

  const finishLater = (fn: () => OtoRun): void => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (disposed) return
      d.onRunChanged(fn())
    }, 600)
    timers.add(timer)
  }

  return {
    start(req: OtoStartRequest) {
      const run = d.runs.create({
        type: req.type,
        person: req.person,
        vttPath: req.type === 'process' ? (req.vttPath ?? null) : null
      })
      if (mode === 'failed') {
        finishLater(() => d.runs.setFailed(run.id, 'Stubbed workflow failure'))
      } else if (mode !== 'running') {
        finishLater(() =>
          run.type === 'process'
            ? d.runs.setDone(run.id, {
                type: 'process',
                notionUrl: 'https://www.notion.so/stub-1-1-note',
                slackDraftCreated: true,
                slackChannelLink: 'https://stub.slack.com/archives/D000'
              })
            : d.runs.setDone(run.id, {
                type: 'prep',
                resultMarkdown: [
                  '## Previous 1:1',
                  '- Agreed to finish the onboarding by Friday.',
                  '## TODO mentions',
                  `- [open] Ask ${run.person} about the rate limit fix`,
                  '## Slack activity (last 2 weeks)',
                  '- #backend: 4 messages about rate limiting.'
                ].join('\n')
              })
        )
      }
      return run
    },

    dispose() {
      disposed = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    }
  }
}
