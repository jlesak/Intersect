import { isAbsolute, relative, sep } from 'node:path'
import type { TimeTrackingSettings } from '@common/domain'
import { canonicalizePath } from '../projects/paths'

export function validateTimeTrackingSettings(value: unknown): TimeTrackingSettings {
  if (!value || typeof value !== 'object' || !('excludedPathPrefixes' in value) ||
    !Array.isArray(value.excludedPathPrefixes)) throw new Error('Path prefixes must be a list')
  const prefixes: string[] = []
  for (const raw of value.excludedPathPrefixes) {
    if (typeof raw !== 'string' || /[\x00-\x1f\x7f]/.test(raw)) throw new Error('Invalid path prefix')
    const prefix = raw.trim()
    if (!prefix) continue
    if (!isAbsolute(prefix)) throw new Error('Path prefixes must be absolute paths')
    if (!prefixes.includes(prefix)) prefixes.push(prefix)
  }
  return { excludedPathPrefixes: prefixes }
}

export function insideAppData(cwd: string, userDataDir: string): boolean {
  if (!cwd || !isAbsolute(cwd)) return false
  const path = relative(canonicalizePath(userDataDir), canonicalizePath(cwd))
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}
