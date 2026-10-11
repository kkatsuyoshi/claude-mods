import type { SessionRateLimit } from 'claude-code'

// Two readings of one window, from this session and others: the same window when their resets fall within a minute of
// each other, and then the one that has used more is the later; else the window that resets later is the newer one
const newer = (a: SessionRateLimit, b: SessionRateLimit) => {
  const gap = Date.parse(a.resetsAt ?? '') - Date.parse(b.resetsAt ?? '')
  if (Number.isNaN(gap) || Math.abs(gap) < 60_000) {
    return a.percentUsed >= b.percentUsed ? a : b
  }

  return gap > 0 ? a : b
}

// The newest reading of each window across the lists
export const mergeLimits = (...lists: (readonly SessionRateLimit[])[]) => {
  const byKind = new Map<string, SessionRateLimit>()
  for (const limit of lists.flat()) {
    const held = byKind.get(limit.kind)
    byKind.set(limit.kind, held === undefined ? limit : newer(held, limit))
  }

  return [...byKind.values()]
}

const isLimit = (value: unknown): value is SessionRateLimit => {
  const limit = value as Partial<Record<keyof SessionRateLimit, unknown>> | null
  return (
    typeof limit === 'object' &&
    limit !== null &&
    typeof limit.kind === 'string' &&
    typeof limit.percentUsed === 'number' &&
    (limit.resetsAt === undefined || typeof limit.resetsAt === 'string')
  )
}

// The windows another session stored, keeping only entries in the shape this mod writes
export const parseLimits = (value: unknown): SessionRateLimit[] => (Array.isArray(value) ? value.filter(isLimit) : [])
