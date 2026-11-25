import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync,
  writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const MARKER = '# Installed by Intersect Time CLI\n'
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/** Called only by the explicit Settings action. The home argument makes temp-home tests safe. */
export function installTimeCliShim(home: string, execPath: string, cliPath: string,
  userDataDir: string): string {
  const local = join(home, '.local')
  const bin = join(local, 'bin')
  for (const dir of [local, bin]) {
    if (existsSync(dir)) {
      if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) {
        throw new Error('CLI install directory is unsafe')
      }
    } else mkdirSync(dir, { mode: 0o700 })
  }
  const target = join(bin, 'intersect-time')
  const existing = lstatSync(target, { throwIfNoEntry: false })
  if (existing && (!existing.isFile() || existing.isSymbolicLink() ||
    !readFileSync(target, 'utf8').startsWith(`#!/bin/sh\n${MARKER}`))) {
    throw new Error('An unrelated intersect-time file already exists')
  }
  const content = `#!/bin/sh\n${MARKER}exec /usr/bin/env ELECTRON_RUN_AS_NODE=1 ` +
    `INTERSECT_TIME_DATA_DIR=${quote(userDataDir)} ${quote(execPath)} ${quote(cliPath)} "$@"\n`
  const temporary = join(bin, `.intersect-time-${randomBytes(6).toString('hex')}`)
  writeFileSync(temporary, content, { mode: 0o700, flag: 'wx' })
  try {
    renameSync(temporary, target)
    chmodSync(target, 0o700)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
  return target
}
