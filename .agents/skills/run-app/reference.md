# Scripted drive: a starting point

Save as `e2e/diag.spec.ts`, replace the body with the flow you are checking, and run
`npm run e2e -- e2e/diag.spec.ts`. `e2e/review-pane-shot.spec.ts` is a committed example of the
same screenshot pattern, and the other specs in `e2e/` show how each view is reached.

```ts
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, launch, openRailSection, test, userDataDir } from './harness'

const OUT = join(tmpdir(), 'intersect-uat')

test('uat: <the behavior being checked>', async () => {
  mkdirSync(OUT, { recursive: true })
  const { app, win, errors } = await launch(userDataDir())
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 820))

  await openRailSection(win, 'Settings', '.ix-settings')
  await win.screenshot({ path: join(OUT, '01-settings.png') })

  expect(errors).toEqual([])
})
```

The rail labels, in order, are exported as `RAIL_LABELS` from `e2e/harness.ts`. The spec runs on
the canned backends, so pull requests, work items and 1:1 data come from
`src/core/*/*E2eStub.ts`; read the stub to know what the app will show.
