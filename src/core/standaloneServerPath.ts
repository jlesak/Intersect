import { join, sep } from 'node:path'

/**
 * The on-disk path of a bundle that something outside Electron has to read.
 *
 * The standalone MCP servers are launched by Claude as `node <path>`, and plain Node knows nothing
 * about `app.asar`: the archive is a single file to it, so every path inside one is unreadable and
 * the server dies before it can speak a word of the protocol. electron-builder copies the entries
 * named in `asarUnpack` to a sibling `app.asar.unpacked` tree, and this maps a packaged path onto
 * that copy.
 *
 * Anchored on the separators so only a real path segment matches: a directory that merely begins
 * with `app.asar` - `app.asarted`, or a user's own folder of that name - is left alone.
 *
 * In development `__dirname` contains no `app.asar` segment and the path is returned unchanged,
 * which is why the same call is correct in both.
 */
export function standaloneServerPath(mainDir: string, filename: string): string {
  return join(mainDir, filename).replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
}
