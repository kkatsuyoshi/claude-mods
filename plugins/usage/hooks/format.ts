import type { SessionContextUsage, SessionRateLimit } from 'claude-code'

// `4:25`, `0:47`: hours and minutes left until `resetsAt`, rounded up to the minute; none once it has passed
const timeLeft = (resetsAt: string | undefined, now: number) => {
  const minutes = Math.ceil((Date.parse(resetsAt ?? '') - now) / 60_000)

  return minutes > 0 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}` : undefined
}

const percent = (label: string, value: number | undefined) =>
  value === undefined ? undefined : `${label}${Math.round(value)}`

// `c16 s57/4:25 w6`: context, current session (five_hour) with the time until it resets, week (seven_day);
// a figure not yet reported is left out
export const formatUsage = (context: SessionContextUsage, rateLimits: readonly SessionRateLimit[], now: number) => {
  const limit = (kind: string) => rateLimits.find(each => each.kind === kind)
  const session = limit('five_hour')
  const reset = session && timeLeft(session.resetsAt, now)
  const line = [
    percent('c', context.percent),
    session && percent('s', session.percentUsed) + (reset === undefined ? '' : `/${reset}`),
    percent('w', limit('seven_day')?.percentUsed),
  ]
    .filter(figure => figure !== undefined)
    .join(' ')

  return line === '' ? undefined : line
}
