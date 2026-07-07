/** The two report tools the 1:1 MCP server forwards, one per workflow type. */
export const OTO_PROCESS_TOOL = 'report_process_result'
export const OTO_PREP_TOOL = 'report_prep_result'

/**
 * One report message forwarded over the Unix socket for a 1:1 run. The result fields are
 * meaningful only when `ok` is true; `error` only when it is false.
 */
export type OtoReportPayload =
  | {
      tool: typeof OTO_PROCESS_TOOL
      sessionId: string
      ok: boolean
      notionUrl: string
      slackDraftCreated: boolean
      slackChannelLink: string
      error: string
    }
  | {
      tool: typeof OTO_PREP_TOOL
      sessionId: string
      ok: boolean
      markdown: string
      error: string
    }

/**
 * Parse one newline-delimited JSON report line into a fully-typed payload; throws on malformed
 * JSON or an unknown tool. Field types are coerced so a confused session can degrade the data
 * but never crash main or smuggle unexpected shapes past this boundary.
 */
export function parseOtoReport(raw: string): OtoReportPayload {
  const obj = JSON.parse(raw) as Record<string, unknown>
  const sessionId = String(obj.sessionId ?? '')
  const ok = obj.ok === true
  // A model reporting a failure may put the detail in either field; keep whichever is present.
  const error = String(obj.error ?? obj.message ?? '')

  if (obj.tool === OTO_PROCESS_TOOL) {
    return {
      tool: OTO_PROCESS_TOOL,
      sessionId,
      ok,
      notionUrl: String(obj.notionUrl ?? ''),
      slackDraftCreated: obj.slackDraftCreated === true,
      slackChannelLink: String(obj.slackChannelLink ?? ''),
      error
    }
  }
  if (obj.tool === OTO_PREP_TOOL) {
    return {
      tool: OTO_PREP_TOOL,
      sessionId,
      ok,
      markdown: String(obj.markdown ?? ''),
      error
    }
  }
  throw new Error(`Unknown 1:1 report tool: ${String(obj.tool)}`)
}
