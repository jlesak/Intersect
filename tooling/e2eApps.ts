/**
 * Ownership of the Electron apps an E2E run launches.
 *
 * A spec that closes its own app only ever does so on the path where every assertion held. The
 * moment one fails, the app it was driving is abandoned and stays alive for the rest of the run,
 * and because the suite is serial with a single worker every later launch then competes with it for
 * the machine. That is what turns one genuine failure into a file of unrelated timeouts, and it is
 * why the reported failures after a late one are mostly not the real one.
 *
 * So the harness registers every app it launches here and drains the register after each test,
 * whatever the test's outcome. The drain never throws: it runs after a verdict has already been
 * reached, and a teardown that failed would replace that verdict with a complaint about cleanup.
 *
 * Kept free of Playwright so it can be unit tested under Vitest, the same reason the freshness
 * guard is. `ElectronApplication` satisfies `CloseableApp` structurally, so nothing is lost.
 */

/**
 * The part of a launched app's operating-system process the drain reads.
 *
 * Both termination fields are here because they are mutually exclusive: a process that exited
 * normally reports a code and no signal, and one that was killed reports a signal and no code -
 * forever. Reading only the code would make the drain blind to the very departures it causes.
 */
export interface AppProcess {
  exitCode: number | null
  signalCode: string | null
  kill(signal: 'SIGKILL'): void
  once(event: 'exit', listener: () => void): unknown
}

/** A launched app the drain can take away. */
export interface CloseableApp {
  close(): Promise<void>
  process(): AppProcess
}

/**
 * A launched app together with the process it runs in.
 *
 * The two are held separately because an app that has been closed will no longer say which process
 * it was - asking it throws - while the process object goes on reporting how it ended for as long
 * as anything holds it. Launch is therefore the only moment the pair can be taken, and taking it
 * there is what leaves the drain able to see whether a spec that closed its own app really did get
 * the process to go away.
 */
export interface LaunchedApp {
  app: CloseableApp
  proc: AppProcess
}

/** How long each stage of a close may take before the drain stops being polite. */
export interface CloseBudget {
  /** How long a graceful close may run before the process is killed instead. */
  closeMs?: number
  /** How long the process may take to actually go away, at each stage. */
  exitMs?: number
}

/**
 * A graceful close takes a second or two in this suite, so ten is a wide margin rather than a
 * deadline anything healthy approaches, and five is generous for a process that has already been
 * told to die. Both are bounded because teardown gets a fresh timeout slot of its own: an unbounded
 * wait here would not be caught by the test's budget, it would simply hang the run - the failure
 * this module exists to remove.
 */
const DEFAULT_BUDGET: Required<CloseBudget> = { closeMs: 10_000, exitMs: 5_000 }

/** Whether the process is gone, by either of the two ways a process can go. */
export function hasExited(proc: Pick<AppProcess, 'exitCode' | 'signalCode'>): boolean {
  return proc.exitCode !== null || proc.signalCode !== null
}

const registered: LaunchedApp[] = []

/** Hand an app to the drain. Called for every app the harness launches. */
export function registerApp(app: CloseableApp): void {
  registered.push({ app, proc: app.process() })
}

/**
 * Close every registered app and forget them all.
 *
 * The register is emptied before anything is closed, so a drain that is somehow interrupted cannot
 * leave entries behind for the next test to close a second time.
 */
export async function closeRegisteredApps(budget: CloseBudget = {}): Promise<void> {
  await closeApps(registered.splice(0, registered.length), budget)
}

/**
 * Close the given apps, one after another, and return only once each one's process is gone.
 *
 * Waiting for the process rather than for the close call is what makes the drain safe to run just
 * before the profile directories are removed: a close can resolve while the process it spoke for is
 * still running, and still holding the directory about to be deleted.
 */
export async function closeApps(apps: LaunchedApp[], budget: CloseBudget = {}): Promise<void> {
  const { closeMs, exitMs } = { ...DEFAULT_BUDGET, ...budget }
  for (const launched of apps) await closeOne(launched, closeMs, exitMs)
}

async function closeOne(
  { app, proc }: LaunchedApp,
  closeMs: number,
  exitMs: number
): Promise<void> {
  // Most often the spec that ran this app closed it itself, and there is nothing left to take away.
  if (hasExited(proc)) return

  // A close that throws is not a reason to stop: the app may have crashed, or been closed already,
  // in which case the connection is gone but the process need not be, and the kill below is exactly
  // what is wanted.
  await settledWithin(app.close(), closeMs).catch(() => undefined)
  if (await exitedWithin(proc, exitMs)) return

  try {
    proc.kill('SIGKILL')
  } catch {
    // Nothing further to try; a process that cannot be signalled is reported by the next launch.
  }
  await exitedWithin(proc, exitMs)
}

/** The given work, or a rejection once the budget is spent. */
function settledWithin(work: Promise<void>, budgetMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`close did not return within ${budgetMs}ms`)), budgetMs)
  })
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer))
}

/** Whether the process was gone within the budget. */
function exitedWithin(proc: AppProcess, budgetMs: number): Promise<boolean> {
  if (hasExited(proc)) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), budgetMs)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}
