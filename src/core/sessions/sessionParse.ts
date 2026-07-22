import { basename } from 'node:path'
import type { SessionSummary, SessionTranscript, TranscriptEntry } from '@common/domain'
import { IDLE_CAP_MS } from '../agentRuntime/activeMinutes'

/**
 * The subset of a `.jsonl` line this parser reads. The Claude Code transcript format is
 * undocumented and may drift, so every field is optional and access is defensive: a missing or
 * mistyped field falls back rather than throwing.
 */
interface RawLine {
  type?: unknown
  aiTitle?: unknown
  cwd?: unknown
  gitBranch?: unknown
  isMeta?: unknown
  timestamp?: unknown
  message?: { content?: unknown }
}

/** One `tool_use` part of an assistant message. */
interface ToolUsePart {
  type?: unknown
  name?: unknown
  input?: unknown
}

/** Keep single-line tool summaries short so they read as one glanceable row. */
const MAX_TOOL_SUMMARY = 80

/**
 * Remove the slash-command wrapper blocks Claude Code injects for the first user turn
 * (`<command-name>`, `<command-message>`, `<command-args>`) and trim. Used both for the title
 * fallback and for the searchable prompt text, so a `/clear` or `/model` invocation never masks
 * the real prompt.
 */
export function stripCommandWrappers(text: string): string {
  return text
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .trim()
}

/**
 * Normalize a message `content` field to plain text. Claude Code stores user content as either a
 * bare string or an array of parts; assistant content is always an array. Only `text` parts
 * contribute; tool calls and tool results are dropped. Returns '' for anything unexpected.
 */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const texts: string[] = []
  for (const part of content) {
    if (
      part &&
      typeof part === 'object' &&
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string'
    ) {
      texts.push((part as { text: string }).text)
    }
  }
  return texts.join('\n')
}

/** Read a string field off an unknown input object, or undefined if absent/mistyped. */
function inputString(input: unknown, key: string): string | undefined {
  if (input && typeof input === 'object' && key in input) {
    const value = (input as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** Trim a value to a single short line for a tool summary. */
function shorten(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > MAX_TOOL_SUMMARY ? `${oneLine.slice(0, MAX_TOOL_SUMMARY - 1)}…` : oneLine
}

/**
 * Produce a compact one-line summary of a tool call for the transcript (e.g. `Read src/foo.ts`,
 * `Bash: npm test`, `Grep "lock owner"`). Unknown tools, or calls whose expected argument is
 * missing, degrade to just the tool name.
 */
export function toolSummary(name: string, input: unknown): string {
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': {
      const path = inputString(input, 'file_path') ?? inputString(input, 'notebook_path')
      return path ? `${name} ${path}` : name
    }
    case 'Bash': {
      const command = inputString(input, 'command')
      return command ? `Bash: ${shorten(command)}` : name
    }
    case 'Grep': {
      const pattern = inputString(input, 'pattern')
      return pattern ? `Grep "${shorten(pattern)}"` : name
    }
    case 'Glob': {
      const pattern = inputString(input, 'pattern')
      return pattern ? `Glob ${shorten(pattern)}` : name
    }
    default:
      return name
  }
}

/** Parse each line as JSON, silently skipping any line that is not valid JSON. */
function parseLines(lines: string[]): RawLine[] {
  const records: RawLine[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object') records.push(parsed as RawLine)
    } catch {
      // A corrupt or partial line is expected here and must never abort the parse.
    }
  }
  return records
}

/** A string field value, only when it is a non-empty string. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Milliseconds since epoch from an ISO timestamp, or 0 when absent/unparseable. */
function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') return 0
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? 0 : ms
}

/** Sum of consecutive-timestamp gaps, each capped at IDLE_CAP_MS - the session's active time. */
function activeSpanMs(timestamps: number[]): number {
  const sorted = [...timestamps].sort((a, b) => a - b)
  let total = 0
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1]
    if (gap <= 0) continue
    total += Math.min(gap, IDLE_CAP_MS)
  }
  return total
}

const isUser = (r: RawLine): boolean => r.type === 'user'
const isAssistant = (r: RawLine): boolean => r.type === 'assistant'
const isNonMetaUser = (r: RawLine): boolean => isUser(r) && r.isMeta !== true

/**
 * Fold the lines of one `.jsonl` file into a lightweight index record. Defensive throughout: a
 * broken line is skipped and every missing field has a fallback, so this never throws. See the
 * field docs on {@link SessionSummary} for the meaning of each value.
 */
export function parseSummary(filePath: string, lines: string[]): SessionSummary {
  const id = basename(filePath, '.jsonl')
  const records = parseLines(lines)

  let cwd = ''
  let gitBranch: string | null = null
  let aiTitle = ''
  let firstTimestamp = 0
  let lastTimestamp = 0
  let hasTimestamp = false
  let messageCount = 0
  const userPrompts: string[] = []
  const timestamps: number[] = []

  for (const record of records) {
    if (!cwd) {
      const c = nonEmpty(record.cwd)
      if (c) cwd = c
    }
    if (gitBranch === null) {
      const b = nonEmpty(record.gitBranch)
      if (b) gitBranch = b
    }
    if (!aiTitle && record.type === 'ai-title') {
      const t = nonEmpty(record.aiTitle)
      if (t) aiTitle = t
    }

    if (isUser(record) || isAssistant(record)) {
      const ts = parseTimestamp(record.timestamp)
      if (ts > 0) {
        timestamps.push(ts)
        if (!hasTimestamp) {
          firstTimestamp = ts
          lastTimestamp = ts
          hasTimestamp = true
        } else {
          if (ts < firstTimestamp) firstTimestamp = ts
          if (ts > lastTimestamp) lastTimestamp = ts
        }
      }
    }

    if (isNonMetaUser(record)) {
      messageCount += 1
      const prompt = stripCommandWrappers(extractText(record.message?.content))
      if (prompt) userPrompts.push(prompt)
    } else if (isAssistant(record)) {
      messageCount += 1
    }
  }

  const folderName = cwd ? basename(cwd) : ''
  const title = aiTitle || userPrompts[0] || folderName || id

  return {
    id,
    filePath,
    cwd,
    folderName,
    title,
    gitBranch,
    firstTimestamp,
    lastTimestamp,
    durationMs: Math.max(0, lastTimestamp - firstTimestamp),
    activeDurationMs: activeSpanMs(timestamps),
    messageCount,
    userPrompts
  }
}

/** Collect one-line summaries for every `tool_use` part of an assistant message. */
function extractTools(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const tools: string[] = []
  for (const part of content as ToolUsePart[]) {
    if (part && typeof part === 'object' && part.type === 'tool_use' && typeof part.name === 'string') {
      tools.push(toolSummary(part.name, part.input))
    }
  }
  return tools
}

/**
 * Build the renderable transcript for one session: one entry per non-meta user message and per
 * assistant message, in file order. User command wrappers are stripped so slash-command turns read
 * cleanly; assistant `tool_use` parts become one-line `tools` summaries. Never throws on bad lines.
 */
export function parseTranscript(
  id: string,
  title: string,
  cwd: string,
  lines: string[]
): SessionTranscript {
  const entries: TranscriptEntry[] = []
  for (const record of parseLines(lines)) {
    if (isNonMetaUser(record)) {
      entries.push({
        role: 'user',
        text: stripCommandWrappers(extractText(record.message?.content)),
        timestamp: parseTimestamp(record.timestamp),
        tools: []
      })
    } else if (isAssistant(record)) {
      const content = record.message?.content
      entries.push({
        role: 'assistant',
        text: extractText(content),
        timestamp: parseTimestamp(record.timestamp),
        tools: extractTools(content)
      })
    }
  }
  return { id, title, cwd, entries }
}
