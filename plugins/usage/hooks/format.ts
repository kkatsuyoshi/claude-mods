import type { SessionContextUsage, SessionRateLimit } from 'claude-code'

// `4:25`, `0:47`: hours and minutes left until `resetsAt`, rounded down to the minute as Claude Desktop shows them;
// none once it has passed
const timeLeft = (resetsAt: string | undefined, now: number) => {
  const left = Date.parse(resetsAt ?? '') - now
  const minutes = Math.floor(left / 60_000)

  return left > 0 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}` : undefined
}

// A window whose reset has passed has started over, so its last reading no longer holds
const used = (limit: SessionRateLimit | undefined, now: number) =>
  limit === undefined ? undefined : Date.parse(limit.resetsAt ?? '') <= now ? 0 : limit.percentUsed

// Rounded down, so a window shows 100 only once it is used up
const percent = (label: string, value: number | undefined) =>
  value === undefined ? undefined : `${label}${Math.floor(value)}`

// `c16 s57/4:25 w6`: context, current session (five_hour) with the time until it resets, week (seven_day);
// a figure not yet reported is left out
export const formatUsage = (context: SessionContextUsage, rateLimits: readonly SessionRateLimit[], now: number) => {
  const limit = (kind: string) => rateLimits.find(each => each.kind === kind)
  const session = limit('five_hour')
  const reset = session && timeLeft(session.resetsAt, now)
  const line = [
    percent('c', context.percent),
    session && percent('s', used(session, now)) + (reset === undefined ? '' : `/${reset}`),
    percent('w', used(limit('seven_day'), now)),
  ]
    .filter(figure => figure !== undefined)
    .join(' ')

  return line === '' ? undefined : line
}
