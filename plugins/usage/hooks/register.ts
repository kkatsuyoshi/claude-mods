import type { EngineInterface, Register, SessionRateLimit, SessionUsage, Timer } from 'claude-code'

import { formatUsage, untilCountdownMoves } from './format'
import { mergeLimits, parseLimits } from './limits'

type Usage = Pick<SessionUsage, 'context' | 'rateLimits'>

// Only the draw started last may write the line: one started earlier and still awaiting the clock holds older figures
let latestDraw = 0

// The line is for the Claude desktop app alone: a session a terminal draws on keeps its status line clear.
// Drawn as at `now`, or as the clock reads when not given
async function draw($: EngineInterface, usage: Usage | undefined, isShown: boolean, now?: number) {
  const ticket = ++latestDraw
  try {
    const text =
      isShown && usage !== undefined ? formatUsage(usage.context, usage.rateLimits, now ?? (await $.clock.now())) : undefined
    if (ticket === latestDraw) {
      $.ui.status(text)
    }
  } catch (error) {
    $.ui.log(`usage: drawing the line failed: ${String(error)}`, { to: 'debug' })
  }
}

// Reads where the session is drawn, draws the newest figures for it, and answers whether the line is shown
async function redraw($: EngineInterface, current: () => Usage | undefined) {
  const surfaces = await $.session.surfaces()
  const isShown = surfaces.includes('desktop') && !surfaces.includes('terminal')
  await draw($, current(), isShown)

  return isShown
}

// The limits are shared with the other sessions on this machine through the store, so each draws the newest reading
// of each window, whichever session read it
const SHARED = 'rateLimits'

// The windows as the sessions on this machine last read them; none when the store cannot be read
async function readShared($: EngineInterface) {
  return parseLimits(await $.store.get(SHARED).catch(() => undefined))
}

// Adds this session's reading to the shared one, and answers the newest reading of each window
async function share($: EngineInterface, own: readonly SessionRateLimit[]) {
  const stored = await readShared($)
  const merged = mergeLimits(stored, own)
  if (JSON.stringify(merged) !== JSON.stringify(stored)) {
    await $.store
      .set(SHARED, merged)
      .catch(error => $.ui.log(`usage: sharing the limits failed: ${String(error)}`, { to: 'debug' }))
  }

  return merged
}

// The line changes on its own while nothing is measured, as the reset countdown turns over, a window resets and
// another session shares a newer reading: one timer redraws it then and waits for the next change, armed only while
// the line is shown
type Countdown = {
  timer?: Timer
  resets?: string
  usage: () => Usage | undefined
  isShown: () => boolean
  adopt: (shared: readonly SessionRateLimit[]) => void
}

const resetsOf = (usage: Usage | undefined) =>
  (usage?.rateLimits ?? []).map(limit => `${limit.kind}@${limit.resetsAt ?? ''}`).join(' ')

function stopCountdown(countdown: Countdown) {
  countdown.timer?.cancel()
  countdown.timer = undefined
  countdown.resets = undefined
}

// Arms the timer for the next change as from `now` (or the clock's reading), or keeps the one armed for the same
// resets; stops it while the line is hidden. A failure costs the countdown alone, never the line or the hook that asked
async function armCountdown($: EngineInterface, countdown: Countdown, now?: number) {
  if (!countdown.isShown()) {
    stopCountdown(countdown)
    return
  }
  const resets = resetsOf(countdown.usage())
  if (countdown.timer !== undefined && countdown.resets === resets) {
    return
  }
  try {
    // a clock that fails to answer still keeps the countdown going, a minute at a time
    const at = now ?? (await $.clock.now().catch(() => undefined))
    const delay = at === undefined ? 60_000 : untilCountdownMoves(countdown.usage()?.rateLimits ?? [], at)
    countdown.timer?.cancel()
    countdown.resets = resets
    countdown.timer = $.clock.after(delay, () => {
      countdown.timer = undefined
      void tickCountdown($, countdown)
    })
  } catch (error) {
    stopCountdown(countdown)
    $.ui.log(`usage: the reset countdown stopped: ${String(error)}`, { to: 'debug' })
  }
}

// One turn of the countdown: a single reading of the clock both draws the line and times the next turn, so the two
// never disagree about which minute it is; a timer that fires a moment early draws that moment and turns again on time
async function tickCountdown($: EngineInterface, countdown: Countdown) {
  countdown.adopt(await readShared($))
  const now = await $.clock.now().catch(() => undefined)
  if (countdown.isShown()) {
    await draw($, countdown.usage(), true, now)
  }
  await armCountdown($, countdown, now)
}

export const register: Register = on => {
  let usage: Usage | undefined
  let isShown = false
  // the newest reading of each window, this session's or another's
  let limits: SessionRateLimit[] = []
  const shown = (): Usage | undefined => usage && { context: usage.context, rateLimits: limits }
  const countdown: Countdown = {
    usage: shown,
    isShown: () => isShown,
    adopt: shared => {
      limits = mergeLimits(limits, shared)
    },
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    usage = await $.session.usage().catch(() => usage)
    limits = await share($, usage?.rateLimits ?? [])
    isShown = await redraw($, shown)
    await armCountdown($, countdown)

    return result
  })

  on('session.measure', async ($, e, next) => {
    usage = e
    limits = mergeLimits(limits, e.rateLimits)
    await draw($, shown(), isShown)
    // shared with the other sessions, and re-armed only when a reset moved, neither in the way of the line or the rest
    // of the chain
    void share($, e.rateLimits).then(merged => {
      limits = mergeLimits(limits, merged)
    })
    void armCountdown($, countdown)

    return next(e)
  })

  // the desktop app attaches after the session starts, and its leaving clears the line
  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    isShown = await redraw($, shown)
    await armCountdown($, countdown)

    return result
  })

  on('session.detach', async ($, e, next) => {
    const result = await next(e)
    isShown = await redraw($, shown)
    await armCountdown($, countdown)

    return result
  })
}
