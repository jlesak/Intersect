import type { ConfigEdit } from '@common/domain'

/**
 * A rejected edit: the proposed change could not be applied because the current file (or the
 * edit's own payload) is not shaped the way a safe structured edit requires. Carried as a typed
 * error so the writer can fold it into a preview's validation errors or a save rejection without
 * guessing at message strings.
 */
export class ConfigEditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigEditError'
  }
}

/** A parsed settings document: a map of unknown-typed top-level keys. */
type Doc = Record<string, unknown>

/**
 * Parse the current file text into a top-level object, tolerating an empty file as `{}`. Anything
 * that is not a JSON object (an array, a scalar, `null`, or malformed text) is rejected: a
 * structured edit must never silently discard a file it cannot round-trip.
 */
export function parseTopLevelObject(content: string): Doc {
  if (content.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (err) {
    throw new ConfigEditError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigEditError('Top-level value must be a JSON object')
  }
  return parsed as Doc
}

/** Serialize a document the way Claude Code writes settings: 2-space indent, trailing newline. */
function serialize(doc: Doc): string {
  return JSON.stringify(doc, null, 2) + '\n'
}

/** Read one key as a plain object, or an empty object when it is absent / not an object. */
function objectAt(doc: Doc, key: string): Record<string, unknown> {
  const v = doc[key]
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? { ...(v as Record<string, unknown>) }
    : {}
}

/** Set `key` when the slice is non-empty, otherwise delete it, on a spread copy of `doc`. */
function withSlice(doc: Doc, key: string, slice: Record<string, unknown> | unknown[]): Doc {
  const next: Doc = { ...doc }
  const empty = Array.isArray(slice) ? slice.length === 0 : Object.keys(slice).length === 0
  if (empty) delete next[key]
  else next[key] = slice
  return next
}

/** The lifecycle-slice keys the Advanced editor must never touch (they have dedicated editors). */
const RESERVED_ADVANCED_KEYS = new Set(['permissions', 'hooks', 'mcpServers'])

/**
 * Apply one structured edit to the current file text and return the proposed file text. The whole
 * document is spread-copied and only the one addressed slice is changed, so unknown top-level
 * keys, sibling lists, other events' hooks, and other MCP servers are preserved verbatim. A slice
 * that becomes empty is deleted rather than left as an empty container. The `raw` variant bypasses
 * all of this and returns the user's text unchanged (the writer still validates it downstream).
 */
export function applyEdit(current: string, edit: ConfigEdit): string {
  if (edit.kind === 'raw') return edit.content

  const doc = parseTopLevelObject(current)

  switch (edit.kind) {
    case 'permission':
      return serialize(applyPermission(doc, edit))
    case 'hook':
      return serialize(applyHook(doc, edit))
    case 'mcp':
      return serialize(applyMcp(doc, edit))
    case 'advanced':
      return serialize(applyAdvanced(doc, edit))
  }
}

function applyPermission(
  doc: Doc,
  edit: Extract<ConfigEdit, { kind: 'permission' }>
): Doc {
  if (edit.rule.trim() === '') throw new ConfigEditError('A permission rule cannot be empty')
  const permissions = objectAt(doc, 'permissions')
  const list = (Array.isArray(permissions[edit.list]) ? [...(permissions[edit.list] as unknown[])] : [])
    .filter((r): r is string => typeof r === 'string')

  if (edit.op === 'add') {
    if (!list.includes(edit.rule)) list.push(edit.rule)
  } else {
    const idx = list.indexOf(edit.rule)
    if (idx !== -1) list.splice(idx, 1)
  }

  const nextPermissions: Record<string, unknown> = { ...permissions }
  if (list.length === 0) delete nextPermissions[edit.list]
  else nextPermissions[edit.list] = list
  return withSlice(doc, 'permissions', nextPermissions)
}

/** A hooks group: an optional matcher plus the inner hook commands it fires. */
interface HookGroup {
  matcher?: string
  hooks: { type: string; command: string; [k: string]: unknown }[]
  [k: string]: unknown
}

/** Whether a group's matcher equals the edit's matcher (both normalized: null/'' are the same). */
function matcherEquals(group: unknown, matcher: string | null): boolean {
  const gm = (group as { matcher?: unknown })?.matcher
  const groupMatcher = typeof gm === 'string' && gm !== '' ? gm : null
  const wanted = matcher !== null && matcher !== '' ? matcher : null
  return groupMatcher === wanted
}

function applyHook(doc: Doc, edit: Extract<ConfigEdit, { kind: 'hook' }>): Doc {
  if (edit.event.trim() === '') throw new ConfigEditError('A hook event cannot be empty')
  if (edit.op === 'add' && edit.command.trim() === '')
    throw new ConfigEditError('A hook command cannot be empty')

  const hooks = objectAt(doc, 'hooks')
  const groups = (Array.isArray(hooks[edit.event]) ? [...(hooks[edit.event] as unknown[])] : []).map(
    (g) => ({ ...(g as object) }) as HookGroup
  )
  const normalizedMatcher = edit.matcher !== null && edit.matcher !== '' ? edit.matcher : null

  if (edit.op === 'add') {
    const target = groups.find((g) => matcherEquals(g, normalizedMatcher))
    const inner = { type: edit.hookType || 'command', command: edit.command }
    if (target) {
      const existing = Array.isArray(target.hooks) ? [...target.hooks] : []
      const dup = existing.some(
        (h) => h?.type === inner.type && h?.command === inner.command
      )
      if (!dup) existing.push(inner)
      target.hooks = existing
    } else {
      const group: HookGroup = { hooks: [inner] }
      if (normalizedMatcher !== null) group.matcher = normalizedMatcher
      groups.push(group)
    }
  } else {
    for (const group of groups) {
      if (!matcherEquals(group, normalizedMatcher)) continue
      if (!Array.isArray(group.hooks)) continue
      group.hooks = group.hooks.filter(
        (h) => !(h?.type === (edit.hookType || 'command') && h?.command === edit.command)
      )
    }
  }

  // Drop groups left with no inner hooks (only relevant after a remove or an already-empty group).
  const prunedGroups = groups.filter((g) => Array.isArray(g.hooks) && g.hooks.length > 0)
  const nextHooks: Record<string, unknown> = { ...hooks }
  if (prunedGroups.length === 0) delete nextHooks[edit.event]
  else nextHooks[edit.event] = prunedGroups
  return withSlice(doc, 'hooks', nextHooks)
}

function applyMcp(doc: Doc, edit: Extract<ConfigEdit, { kind: 'mcp' }>): Doc {
  if (edit.name.trim() === '') throw new ConfigEditError('An MCP server name cannot be empty')
  const servers = objectAt(doc, 'mcpServers')

  if (edit.op === 'set') {
    let parsed: unknown
    try {
      parsed = JSON.parse(edit.server)
    } catch (err) {
      throw new ConfigEditError(
        `Invalid server JSON: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new ConfigEditError('An MCP server definition must be a JSON object')
    servers[edit.name] = parsed
  } else {
    delete servers[edit.name]
  }

  return withSlice(doc, 'mcpServers', servers)
}

function applyAdvanced(doc: Doc, edit: Extract<ConfigEdit, { kind: 'advanced' }>): Doc {
  if (edit.key.trim() === '') throw new ConfigEditError('A setting key cannot be empty')
  if (RESERVED_ADVANCED_KEYS.has(edit.key))
    throw new ConfigEditError(
      `'${edit.key}' has its own editor and cannot be changed as an advanced key`
    )

  const next: Doc = { ...doc }
  if (edit.op === 'remove') {
    delete next[edit.key]
    return next
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(edit.value)
  } catch (err) {
    throw new ConfigEditError(
      `Invalid value JSON: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  next[edit.key] = parsed
  return next
}
