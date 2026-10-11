import type { EngineInterface, Register, SessionUsage, Timer } from 'claude-code'

import { formatUsage, untilCountdownMoves } from './format'

type Usage = Pick<SessionUsage, 'context' | 'rateLimits'>

// Only the draw started last may write the line: one started earlier and still awaiting the clock holds older figures
let latestDraw = 0

// The line is for the Claude desktop app alone: a session a terminal draws on keeps its status line clear
async function draw($: EngineInterface, usage: Usage | undefined, isShown: boolean) {
  const ticket = ++latestDraw
  try {
    const text = isShown && usage !== undefined ? formatUsage(usage.context, usage.rateLimits, await $.clock.now()) : undefined
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

// Arms the timer for the next change, or keeps the one armed for the same resets; stops it while the line is hidden.
// A failure costs the countdown alone, never the line or the hook that asked
async function armCountdown($: EngineInterface, countdown: Countdown) {
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
    const delay = await $.clock.now().then(
      now => untilCountdownMoves(countdown.usage()?.rateLimits ?? [], now),
      () => 60_000,
    )
    countdown.timer?.cancel()
    countdown.resets = resets
    countdown.timer = $.clock.after(delay, () => {
      countdown.timer = undefined
      if (countdown.isShown()) {
        void draw($, countdown.usage(), true)
      }
      void armCountdown($, countdown)
    })
  } catch (error) {
    stopCountdown(countdown)
    $.ui.log(`usage: the reset countdown stopped: ${String(error)}`, { to: 'debug' })
  }
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
