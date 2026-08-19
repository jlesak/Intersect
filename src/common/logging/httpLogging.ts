import type { Logger } from './logger'
import { redactUrl } from './record'

/**
 * Wrap a `fetch` so every outbound call is recorded with its method, redacted URL, status and
 * duration. Applied where `fetch` is injected, so no call site changes and nothing can bypass it.
 *
 * The response is returned untouched: the body is never read here, which would consume the stream
 * the caller is about to use.
 */
export function withHttpLogging(fetchFn: typeof fetch, logger: Logger): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const rawUrl = input instanceof Request ? input.url : String(input)
    const url = redactUrl(rawUrl)
    const startedAt = Date.now()
    try {
      const response = await fetchFn(input, init)
      const data = { method, url, status: response.status, durationMs: Date.now() - startedAt }
      // The threshold is the status rather than `response.ok`: a caller that asked for
      // `redirect: 'manual'` reads a 3xx as an answer it handles - an expired SSO session being
      // sent to the identity provider - and recording that as an error fills the band a reader
      // filters on to find real failures.
      if (response.status >= 400) logger.error('http request', { data })
      else logger.debug('http request', { data })
      return response
    } catch (err) {
      logger.error('http request failed', {
        data: { method, url, durationMs: Date.now() - startedAt },
        err
      })
      throw err
    }
  }
}
