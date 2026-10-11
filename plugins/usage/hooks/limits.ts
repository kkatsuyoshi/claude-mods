import type { SessionRateLimit } from 'claude-code'

const resetOf = (limit: SessionRateLimit) => Date.parse(limit.resetsAt ?? '')

// Two readings of one window: the same window when their resets fall within a minute of each other
const isSameWindow = (a: SessionRateLimit, b: SessionRateLimit) => Math.abs(resetOf(a) - resetOf(b)) < 60_000

// Two readings of one kind, `b` the later to arrive: within the same window the one that has used more, else the
// window that resets later; one without a reset tells no window, so the later to arrive stands
const newer = (a: SessionRateLimit, b: SessionRateLimit) => {
  if (Number.isNaN(resetOf(a)) || Number.isNaN(resetOf(b))) {
    return b
  }
  if (isSameWindow(a, b)) {
    return a.percentUsed > b.percentUsed ? a : b
  }

  return resetOf(a) > resetOf(b) ? a : b
}

// The newest reading of each kind across the lists, a later list's reading standing over an earlier one's it cannot
// tell apart
export const mergeLimits = (...lists: (readonly SessionRateLimit[])[]) => {
  const byKind = new Map<string, SessionRateLimit>()
  for (const limit of lists.flat()) {
    const held = byKind.get(limit.kind)
    byKind.set(limit.kind, held === undefined ? limit : newer(held, limit))
  }

  return [...byKind.values()]
}

// The readings other sessions shared that belong to this session's account: the store is shared by every session
// under the configuration directory, whatever account each is on, so a shared reading counts only for a window this
// session has read itself, once that window has passed for the window after it. A session with no reading of a kind,
// as off a subscription, draws none shared
export const adoptLimits = (own: readonly SessionRateLimit[], shared: readonly SessionRateLimit[], now: number) =>
  shared.filter(limit => {
    const mine = own.find(each => each.kind === limit.kind)
    return (
      mine !== undefined &&
      !Number.isNaN(resetOf(mine)) &&
      (isSameWindow(mine, limit) || (resetOf(mine) <= now && resetOf(limit) > resetOf(mine)))
    )
  })

// The keys the sessions shared under that no longer add anything, to be removed: each of a key's readings has either
// reset by `now`, or is held as far by another key's reading of the same window (on a tie, the key that sorts first
// stands). A reading is weighed only against its own window, so another account's key never covers one of this one's
export const coveredKeys = (shared: readonly (readonly [string, readonly SessionRateLimit[]])[], now: number) => {
  const isCovered = (key: string, limit: SessionRateLimit) =>
    resetOf(limit) <= now ||
    shared.some(
      ([other, limits]) =>
        other !== key &&
        limits.some(
          each =>
            each.kind === limit.kind &&
            isSameWindow(each, limit) &&
            (each.percentUsed > limit.percentUsed || (each.percentUsed === limit.percentUsed && other < key)),
        ),
    )

  return shared.filter(([key, limits]) => limits.every(limit => isCovered(key, limit))).map(([key]) => key)
}

// The readings worth sharing: one without a reset tells no window, so another session cannot place it
export const shareable = (limits: readonly SessionRateLimit[]) => limits.filter(limit => !Number.isNaN(resetOf(limit)))

// The same readings spelled the same, whatever order they come in
export const limitsKey = (limits: readonly SessionRateLimit[]) =>
  limits
    .map(limit => `${limit.kind}@${limit.resetsAt ?? ''}:${limit.percentUsed}`)
    .sort()
    .join(' ')

const isLimit = (value: unknown): value is SessionRateLimit => {
  const limit = value as Partial<Record<keyof SessionRateLimit, unknown>> | null
  return (
    typeof limit === 'object' &&
    limit !== null &&
    typeof limit.kind === 'string' &&
    typeof limit.percentUsed === 'number' &&
    typeof limit.resetsAt === 'string'
  )
}

// The windows another session stored, keeping only entries in the shape this mod writes
export const parseLimits = (value: unknown): SessionRateLimit[] => (Array.isArray(value) ? value.filter(isLimit) : [])
