/** Only an actual Teams meeting link from the structured onlineMeeting field may leave the app. */
export function validJoinUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password ||
      url.hostname !== 'teams.microsoft.com' || url.port !== '' ||
      !/^\/(?:l\/meetup-join|meet)\//.test(url.pathname)) return null
    return url.href
  } catch {
    return null
  }
}
