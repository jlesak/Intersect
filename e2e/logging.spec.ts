import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { addWorkspace, expect, launch, tempDir, test, userDataDir } from './harness'

/**
 * The log pipeline end to end, in the real sandboxed runtime.
 *
 * Unit tests cover each producer against a fake sink, so what is left to establish is the part no
 * unit test can reach: that main, the core and the renderer all resolve the same file on disk, that
 * the renderer's records survive the hop through preload and IPC into main, and that what lands is
 * one valid JSON object per line rather than interleaved fragments from three writers.
 */

interface Record {
  ts: string
  level: string
  proc: string
  scope: string
  msg: string
  data?: { channel?: string }
}

/** Every record in the profile's log directory, parsed line by line. */
function readLog(profileDir: string): Record[] {
  const dir = join(profileDir, 'logs')
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) =>
      readFileSync(join(dir, name), 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record)
    )
}

/** The RPC channel of every record that names one. */
function loggedChannels(profileDir: string): string[] {
  return readLog(profileDir)
    .map((record) => record.data?.channel)
    .filter((channel): channel is string => typeof channel === 'string')
}

test('every process writes structured records to one log file', async () => {
  const profileDir = userDataDir()
  const { app, win } = await launch(profileDir, { openOther: true })

  // Drive one real cross-process round trip so the core and the RPC seam have something to record.
  await win.locator('.ix-rail__btn', { hasText: 'TODO' }).click()
  await win.waitForSelector('.ix-todo')

  // The renderer's records travel over IPC, so give main a moment to append them.
  await expect
    .poll(() => readLog(profileDir).map((r) => r.proc), { timeout: 10_000 })
    .toContain('renderer')

  const records = readLog(profileDir)

  // All three producers reached the same file.
  expect(new Set(records.map((r) => r.proc))).toEqual(new Set(['main', 'core', 'renderer']))

  // Every line is a complete, well-formed record - which is what makes the file machine-readable.
  for (const record of records) {
    expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(['error', 'warn', 'info', 'debug']).toContain(record.level)
    expect(typeof record.msg).toBe('string')
  }

  // The RPC seam recorded the traffic the click generated.
  expect(records.some((r) => r.scope === 'rpc')).toBe(true)

  // Nothing failed during a clean boot and one navigation.
  expect(records.filter((r) => r.level === 'error')).toEqual([])

  await app.close()
})

test('the terminal fast path is never logged', async () => {
  const profileDir = userDataDir()
  const { app, win } = await launch(profileDir, { openOther: true })
  await addWorkspace(win, app, tempDir('logging-ws-'))

  await win.locator('.ix-iconbtn[title="New terminal"]').click()
  await win.locator('.ix-preset', { hasText: 'Shell' }).click()
  const term = win.locator('.xterm')
  await term.waitFor()
  await term.click()

  // Keystrokes are what produce terminal:input, and the shell echoing them back is what produces
  // terminal:data. Nothing is submitted: the echo alone puts both channels on the wire, and a
  // command that actually ran would make the test depend on the developer's shell.
  await win.keyboard.type('intersect-log-probe')
  await expect(term).toContainText('intersect-log-probe')

  const channels = loggedChannels(profileDir)

  // A positive control, so this test can never quietly pass by driving no terminal at all. The
  // spawn that opened this pane is request/response, so it belongs in the file, and its presence
  // is what makes the two absences below evidence rather than an empty run.
  expect(channels).toContain('terminal:spawn')

  // terminal:input and terminal:data would flood the file and throttle the terminal itself. Both
  // stay out because the transport logs a notification and a push only when one fails, so the
  // guard this pins down is against a future change that starts recording them on success too.
  expect(channels).not.toContain('terminal:input')
  expect(channels).not.toContain('terminal:data')

  await app.close()
})
