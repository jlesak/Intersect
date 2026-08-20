import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Guards the renderer's static import graph against heavyweight modules creeping back into light
 * entry points.
 *
 * The concrete case is Monaco. `monaco-editor` is the single biggest thing the renderer can load,
 * and it does not survive jsdom, so a static edge to it from the PR inbox barrel spreads two ways
 * at once: every consumer that only wants a PR selector carries the editor in its bundle chunk, and
 * every test that mounts such a consumer has to stub the editor it never asked for. Reading the
 * graph off the sources answers that directly, where a stub in a test file only hides it.
 *
 * The walk follows what a bundler follows: import and re-export statements, resolved through the
 * same aliases the build and Vitest use. Type-only imports are erased before any bundle is emitted,
 * and a dynamic `import()` becomes its own chunk, so neither counts as weight on the importer.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

/** Path aliases, mirroring vitest.config.ts and the build. */
const ALIASES: Array<[string, string]> = [
  ['@renderer/', 'src/renderer/src/'],
  ['@common/', 'src/common/']
]

/** Extensions the walk parses. Anything else (CSS, assets) is a leaf. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']

/** Extensions tried, in order, when a specifier names a file or a directory without one. */
const RESOLUTION_SUFFIXES = ['', ...SOURCE_EXTENSIONS, ...SOURCE_EXTENSIONS.map((e) => `/index${e}`)]

/**
 * Whether a specifier names the Monaco editor itself.
 *
 * Vite emits a `?worker` import as its own bundle with its own entry, so those specifiers name the
 * language workers rather than weight carried by the importing chunk.
 */
function isMonaco(specifier: string): boolean {
  const names = specifier === 'monaco-editor' || specifier.startsWith('monaco-editor/')
  return names && !specifier.endsWith('?worker')
}

/**
 * The specifiers a bundler would follow out of one file: static imports and re-exports, with
 * type-only forms dropped. Only top-level statements are read, which is what leaves `import()`
 * out - it is an expression, and the chunk it names is fetched on demand rather than loaded with
 * its importer.
 */
function staticSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    false,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const specifiers: string[] = []
  for (const statement of source.statements) {
    const typeOnly = ts.isImportDeclaration(statement)
      ? statement.importClause?.isTypeOnly === true
      : ts.isExportDeclaration(statement)
        ? statement.isTypeOnly
        : false
    const moduleSpecifier =
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        ? statement.moduleSpecifier
        : undefined
    if (typeOnly || moduleSpecifier === undefined) continue
    if (ts.isStringLiteral(moduleSpecifier)) specifiers.push(moduleSpecifier.text)
  }
  return specifiers
}

/** The file a specifier names, or null when it names a package or something not parseable. */
function resolveSpecifier(specifier: string, importer: string): string | null {
  const bare = specifier.split('?')[0]
  let base: string | null = null
  if (bare.startsWith('.')) base = resolve(dirname(importer), bare)
  for (const [prefix, directory] of ALIASES) {
    if (bare.startsWith(prefix)) base = resolve(REPO_ROOT, directory, bare.slice(prefix.length))
  }
  if (base === null) return null
  for (const suffix of RESOLUTION_SUFFIXES) {
    const candidate = `${base}${suffix}`
    if (!existsSync(candidate) || !statSync(candidate).isFile()) continue
    return SOURCE_EXTENSIONS.includes(extname(candidate)) ? candidate : null
  }
  return null
}

/**
 * The shortest chain of static imports from `entry` to a specifier the predicate accepts, as
 * repository-relative paths ending in the specifier itself. Null when no such chain exists.
 */
function findStaticPath(entry: string, matches: (specifier: string) => boolean): string[] | null {
  const start = resolve(REPO_ROOT, entry)
  const cameFrom = new Map<string, string | null>([[start, null]])
  const queue = [start]
  const chainTo = (file: string, tail: string): string[] => {
    const chain = [tail]
    for (let at: string | null = file; at !== null; at = cameFrom.get(at) ?? null) {
      chain.unshift(relative(REPO_ROOT, at))
    }
    return chain
  }
  while (queue.length > 0) {
    const file = queue.shift() as string
    for (const specifier of staticSpecifiers(file)) {
      if (matches(specifier)) return chainTo(file, specifier)
      const next = resolveSpecifier(specifier, file)
      if (next === null || cameFrom.has(next)) continue
      cameFrom.set(next, file)
      queue.push(next)
    }
  }
  return null
}

describe('renderer import graph', () => {
  it('reads the graph well enough to see a real edge to Monaco', () => {
    // A control on the walk itself. Every other case here passes when nothing is found, which a
    // broken resolver would also produce, so one case has to fail that way instead.
    expect(
      findStaticPath('src/renderer/src/features/prInbox/components/DiffViewer.tsx', isMonaco)
    ).toEqual(['src/renderer/src/features/prInbox/components/DiffViewer.tsx', 'monaco-editor'])
  })

  it('resolves specifiers across hops, aliases and barrels', () => {
    // The control above matches on the entry file's own first import, so it returns before a
    // specifier is ever resolved and it survives a resolver that always answers null. This one
    // needs several hops to succeed: a bare alias, a directory-to-index barrel, and relative
    // files. A resolver that stops working fails here loudly instead of reporting an empty graph.
    const isXterm = (specifier: string): boolean => specifier === '@xterm/xterm'
    expect(findStaticPath('src/renderer/src/main.tsx', isXterm)).toEqual([
      'src/renderer/src/main.tsx',
      'src/renderer/src/app/registerFeatures.ts',
      'src/renderer/src/features/terminal/index.ts',
      'src/renderer/src/features/terminal/terminalController.ts',
      '@xterm/xterm'
    ])
  })

  it('keeps Monaco out of the PR inbox barrel', () => {
    // Consumers across the app import this barrel for the store and its selectors. Reaching the
    // editor from here puts it in their chunks and in their tests.
    expect(findStaticPath('src/renderer/src/features/prInbox/index.ts', isMonaco)).toBeNull()
  })

  it('keeps Monaco out of the renderer entry', () => {
    // Feature registration runs before the first render, so anything it imports lands in the entry
    // chunk. The editor belongs in the chunk of whoever opens a diff.
    expect(findStaticPath('src/renderer/src/main.tsx', isMonaco)).toBeNull()
  })
})
