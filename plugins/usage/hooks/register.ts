import type { EngineInterface, Register, SessionUsage, Timer } from 'claude-code'

import { formatUsage, untilCountdownMoves } from './format'

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

// The line changes on its own while nothing is measured, as the reset countdown turns over and a window resets: one
// timer redraws it then and waits for the next change, armed only while the line is shown
type Countdown = { timer?: Timer; resets?: string; usage: () => Usage | undefined; isShown: () => boolean }

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
  const now = await $.clock.now().catch(() => undefined)
  if (countdown.isShown()) {
    await draw($, countdown.usage(), true, now)
  }
  await armCountdown($, countdown, now)
}

export const register: Register = on => {
  let usage: Usage | undefined
  let isShown = false
  const countdown: Countdown = { usage: () => usage, isShown: () => isShown }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    usage = await $.session.usage().catch(() => usage)
    isShown = await redraw($, () => usage)
    await armCountdown($, countdown)

    return result
  })

  on('session.measure', async ($, e, next) => {
    usage = e
    await draw($, usage, isShown)
    // re-armed only when a reset moved, and not in the way of the line or the rest of the chain
    void armCountdown($, countdown)

    return next(e)
  })

  // the desktop app attaches after the session starts, and its leaving clears the line
  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    isShown = await redraw($, () => usage)
    await armCountdown($, countdown)

    return result
  })

  on('session.detach', async ($, e, next) => {
    const result = await next(e)
    isShown = await redraw($, () => usage)
    await armCountdown($, countdown)

    return result
  })
}
