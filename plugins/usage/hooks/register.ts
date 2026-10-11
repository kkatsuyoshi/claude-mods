import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit, Timer } from 'claude-code'

import { formatUsage, untilCountdownMoves } from './format'
import { adoptLimits, hasPassed, limitsKey, mergeLimits, parseLimits, shareable } from './limits'

// What one session knows and draws, kept in one place for the hooks and the countdown alike
type Session = {
  // this session's key in the store
  id: string
  context?: SessionContextUsage
  // the windows as this session last read them, and as the sessions on this machine last shared them
  own: SessionRateLimit[]
  shared: SessionRateLimit[]
  // what this session last wrote to the store
  sharedKey?: string
  isShown: boolean
  // the countdown's timer, and the resets it was armed for
  timer?: Timer
  resets?: string
}

// The limits drawn as at `now`: this session's own readings, and the newer ones of its account shared by others
const limitsAt = (session: Session, now: number) =>
  mergeLimits(session.own, adoptLimits(session.own, session.shared, now))

// Only the draw started last may write the line: one started earlier and still awaiting the clock holds older figures
let latestDraw = 0

// The line is for the Claude desktop app alone: a session a terminal draws on keeps its status line clear.
// Drawn as at `now`, or as the clock reads when not given
async function draw($: EngineInterface, session: Session, now?: number) {
  const ticket = ++latestDraw
  try {
    let text: string | undefined
    if (session.isShown && session.context !== undefined) {
      const at = now ?? (await $.clock.now())
      text = formatUsage(session.context, limitsAt(session, at), at)
    }
    if (ticket === latestDraw) {
      $.ui.status(text)
    }
  } catch (error) {
    $.ui.log(`usage: drawing the line failed: ${String(error)}`, { to: 'debug' })
  }
}

// The limits are shared with the other sessions under this configuration directory through the store, each session
// under a key of its own, so none ever writes over another's reading
const SHARED = 'rateLimits:'

// The windows as the sessions last shared them, the newest of each; a session's key whose windows have all reset is
// removed. None when the store cannot be read
async function readShared($: EngineInterface, now: number) {
  try {
    const keys = (await $.store.keys()).filter(key => key.startsWith(SHARED))
    const lists = await Promise.all(
      keys.map(async key => {
        const limits = parseLimits(await $.store.get(key))
        if (hasPassed(limits, now)) {
          await $.store.delete(key)
          return []
        }
        return limits
      }),
    )
    return mergeLimits(...lists)
  } catch (error) {
    $.ui.log(`usage: reading the shared limits failed: ${String(error)}`, { to: 'debug' })
    return []
  }
}

// Writes this session's own reading under its key, only when it changed
async function share($: EngineInterface, session: Session) {
  const limits = shareable(session.own)
  const key = limitsKey(limits)
  if (key === session.sharedKey) {
    return
  }
  session.sharedKey = key
  try {
    await (limits.length === 0 ? $.store.delete(SHARED + session.id) : $.store.set(SHARED + session.id, limits))
  } catch (error) {
    session.sharedKey = undefined
    $.ui.log(`usage: sharing the limits failed: ${String(error)}`, { to: 'debug' })
  }
}

// Reads where the session is drawn, picks up what the other sessions shared when the line is shown, and draws it
async function redraw($: EngineInterface, session: Session) {
  const surfaces = await $.session.surfaces()
  session.isShown = surfaces.includes('desktop') && !surfaces.includes('terminal')
  if (session.isShown) {
    const now = await $.clock.now().catch(() => undefined)
    if (now !== undefined) {
      session.shared = await readShared($, now)
    }
    await draw($, session, now)
    return
  }
  await draw($, session)
}

// The line changes on its own while nothing is measured, as the reset countdown turns over, a window resets and
// another session shares a newer reading: one timer redraws it then and waits for the next change, armed only while
// the line is shown
const resetsOf = (limits: readonly SessionRateLimit[]) =>
  limits.map(limit => `${limit.kind}@${limit.resetsAt ?? ''}`).join(' ')

function stopCountdown(session: Session) {
  session.timer?.cancel()
  session.timer = undefined
  session.resets = undefined
}

// Arms the timer for the next change as from `now` (or the clock's reading), or keeps the one armed for the same
// resets; stops it while the line is hidden. A failure costs the countdown alone, never the line or the hook that asked
async function armCountdown($: EngineInterface, session: Session, now?: number) {
  if (!session.isShown) {
    stopCountdown(session)
    return
  }
  try {
    // a clock that fails to answer still keeps the countdown going, a minute at a time
    const at = now ?? (await $.clock.now().catch(() => undefined))
    const limits = at === undefined ? session.own : limitsAt(session, at)
    const resets = resetsOf(limits)
    if (session.timer !== undefined && session.resets === resets) {
      return
    }
    const delay = at === undefined ? 60_000 : untilCountdownMoves(limits, at)
    session.timer?.cancel()
    session.resets = resets
    session.timer = $.clock.after(delay, () => {
      session.timer = undefined
      void tickCountdown($, session)
    })
  } catch (error) {
    stopCountdown(session)
    $.ui.log(`usage: the reset countdown stopped: ${String(error)}`, { to: 'debug' })
  }
}

// One turn of the countdown: a single reading of the clock both draws the line and times the next turn, so the two
// never disagree about which minute it is; a timer that fires a moment early draws that moment and turns again on time
async function tickCountdown($: EngineInterface, session: Session) {
  const now = await $.clock.now().catch(() => undefined)
  if (session.isShown) {
    if (now !== undefined) {
      session.shared = await readShared($, now)
    }
    await draw($, session, now)
  }
  await armCountdown($, session, now)
}

export const register: Register = on => {
  const session: Session = { id: crypto.randomUUID(), own: [], shared: [], isShown: false }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const usage = await $.session.usage().catch(() => undefined)
    if (usage !== undefined) {
      session.context = usage.context
      session.own = usage.rateLimits
    }
    await share($, session)
    await redraw($, session)
    await armCountdown($, session)

    return result
  })

  on('session.measure', async ($, e, next) => {
    session.context = e.context
    session.own = e.rateLimits
    await draw($, session)
    // shared with the other sessions, and re-armed only when a reset moved, neither in the way of the line or the rest
    // of the chain
    void share($, session)
    void armCountdown($, session)

    return next(e)
  })

  // the desktop app attaches after the session starts, and its leaving clears the line
  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    await redraw($, session)
    await armCountdown($, session)

    return result
  })

  on('session.detach', async ($, e, next) => {
    const result = await next(e)
    await redraw($, session)
    await armCountdown($, session)

    return result
  })
}
