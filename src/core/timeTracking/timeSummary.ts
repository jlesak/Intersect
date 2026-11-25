import { basename } from 'node:path'
import type { SessionTranscript } from '@common/domain'
import { stripServiceNoise } from '../sessions/sessionParse'
import { trackingDayKey } from './dayActivity'

export interface TimeSummaryResult { summary: string; isWork: boolean }
export interface SummaryDay {
  title: string
  cwd: string
  gitBranch: string | null
  day: string
  lastTimestamp: number
}

const MAX_INPUT = 12_000
const SECRET = /-----BEGIN[\s\S]*?(?:-----END[^\n]*|$)|\b(?:sk-|ghp_|xox[A-Za-z0-9_-]+)[A-Za-z0-9_-]*|\bAKIA[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\b[0-9a-fA-F]{32,}\b|\b[A-Za-z0-9+/]{40,}={0,2}\b/g
const URL = /[A-Za-z][A-Za-z0-9+.-]*:\/\/|www\./i
const ABSOLUTE_PATH = /(?:^|[^\p{L}\p{N}])\/[^\s/]+/u
const RELATIVE_FILE_PATH = /(?:^|[^\p{L}\p{N}])(?:\.\.?\/)?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,10}\b/u
const RELATIVE_DIRECTORY_PATH = /(?:^|[^\p{L}\p{N}])(?:\.\.?\/[\w.-]+|(?:[\w.-]+\/){2,}[\w.-]+)/u

function unsafeOutput(summary: string): boolean {
  return URL.test(summary) || ABSOLUTE_PATH.test(summary) ||
    RELATIVE_FILE_PATH.test(summary) || RELATIVE_DIRECTORY_PATH.test(summary) ||
    /[<>]/.test(summary)
}

/** Match the secret families from #175 in both input and output, before input truncation. */
export function redactSecrets(value: string): string {
  return value.replace(SECRET, '[redacted]')
}

function cleanText(value: string): string {
  return stripServiceNoise(value)
    // Pasted prose is user content; remove its wrapper, not its contents.
    .replace(/<\/?pasted_content(?:\s[^>]*)?>/g, '')
    .replace(/<([A-Za-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

/** Build day-only model input. Tool summaries and the complete cwd never enter it. */
export function buildSummaryInput(row: SummaryDay, transcript: SessionTranscript, zone: string): string {
  const dayKey = trackingDayKey(zone)
  const entries = transcript.entries.filter(entry => entry.timestamp > 0 &&
    entry.timestamp <= row.lastTimestamp && dayKey(entry.timestamp) === row.day)
  const lines = [
    `Den: ${row.day}`,
    `Název session: ${cleanText(row.title)}`,
    `Složka: ${cleanText(basename(row.cwd))}`,
    `Větev: ${cleanText(row.gitBranch ?? '')}`
  ]
  for (const entry of entries) {
    const source = entry.role === 'assistant' ? entry.text.split(/\r?\n/, 1)[0] : entry.text
    const text = cleanText(source)
    if (text) lines.push(`${entry.role === 'user' ? 'Uživatel' : 'Asistent'}: ${text}`)
  }
  // Redact before cutting: a secret crossing the 12k boundary must not leak its prefix.
  return redactSecrets(lines.join('\n')).slice(0, MAX_INPUT)
}

/** The CLI's JSON envelope contains the model's JSON as a string, not as its top-level object. */
export function parseSummaryEnvelope(raw: string): TimeSummaryResult {
  let envelope: unknown
  try { envelope = JSON.parse(raw) } catch { throw new Error('invalid-envelope') }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('invalid-envelope')
  }
  const outer = envelope as Record<string, unknown>
  if (outer.type !== 'result' || outer.subtype !== 'success' || outer.is_error !== false ||
    typeof outer.result !== 'string') throw new Error('unsuccessful-envelope')
  let value: unknown
  try { value = JSON.parse(outer.result) } catch { throw new Error('invalid-result-json') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-result')
  const result = value as Record<string, unknown>
  if (Object.keys(result).sort().join(',') !== 'isWork,summary' ||
    typeof result.summary !== 'string' || typeof result.isWork !== 'boolean') {
    throw new Error('invalid-result-shape')
  }
  const summary = result.summary.trim()
  if (summary.length < 3 || summary.length > 140 || !/\p{L}/u.test(summary) ||
    /[\r\n]/.test(result.summary) || /[.!?]\s+(?=\p{L})/u.test(summary) ||
    unsafeOutput(summary) ||
    redactSecrets(summary) !== summary) throw new Error('unsafe-summary')
  return { summary, isWork: result.isWork }
}
