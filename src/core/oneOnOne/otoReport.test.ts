import { describe, expect, test } from 'vitest'
import { parseOtoReport } from './otoReport'

describe('parseOtoReport', () => {
  test('parses a successful process report', () => {
    const payload = parseOtoReport(
      JSON.stringify({
        sessionId: 's1',
        tool: 'report_process_result',
        ok: true,
        notionUrl: 'https://www.notion.so/page',
        slackDraftCreated: true,
        slackChannelLink: 'https://greencode.slack.com/archives/D1'
      })
    )
    expect(payload).toEqual({
      tool: 'report_process_result',
      sessionId: 's1',
      ok: true,
      notionUrl: 'https://www.notion.so/page',
      slackDraftCreated: true,
      slackChannelLink: 'https://greencode.slack.com/archives/D1',
      error: ''
    })
  })

  test('parses a successful prep report', () => {
    const payload = parseOtoReport(
      JSON.stringify({
        sessionId: 's2',
        tool: 'report_prep_result',
        ok: true,
        markdown: '## Previous 1:1\n- agreed to finish onboarding'
      })
    )
    expect(payload).toEqual({
      tool: 'report_prep_result',
      sessionId: 's2',
      ok: true,
      markdown: '## Previous 1:1\n- agreed to finish onboarding',
      error: ''
    })
  })

  test('parses a failure with the error field, falling back to message', () => {
    const withError = parseOtoReport(
      JSON.stringify({ sessionId: 's', tool: 'report_prep_result', ok: false, error: 'Notion down' })
    )
    expect(withError.ok).toBe(false)
    expect(withError.error).toBe('Notion down')

    const withMessage = parseOtoReport(
      JSON.stringify({ sessionId: 's', tool: 'report_process_result', ok: false, message: 'no vtt' })
    )
    expect(withMessage.error).toBe('no vtt')
  })

  test('coerces missing and wrongly-typed fields instead of crashing', () => {
    const payload = parseOtoReport(
      JSON.stringify({
        sessionId: 42,
        tool: 'report_process_result',
        ok: 'yes',
        notionUrl: 7,
        slackDraftCreated: 'true',
        slackChannelLink: null
      })
    )
    expect(payload).toEqual({
      tool: 'report_process_result',
      sessionId: '42',
      ok: false,
      notionUrl: '7',
      slackDraftCreated: false,
      slackChannelLink: '',
      error: ''
    })
  })

  test('prep markdown coerces to a string when absent', () => {
    const payload = parseOtoReport(JSON.stringify({ sessionId: 's', tool: 'report_prep_result', ok: true }))
    expect(payload.ok).toBe(true)
    if (payload.tool === 'report_prep_result') expect(payload.markdown).toBe('')
  })

  test('throws on malformed JSON and on an unknown tool', () => {
    expect(() => parseOtoReport('not json')).toThrow()
    expect(() => parseOtoReport(JSON.stringify({ sessionId: 's', tool: 'evil_tool', ok: true }))).toThrow(
      /Unknown 1:1 report tool/
    )
    expect(() => parseOtoReport(JSON.stringify({ sessionId: 's', ok: true }))).toThrow(
      /Unknown 1:1 report tool/
    )
  })
})
