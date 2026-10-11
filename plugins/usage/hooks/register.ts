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

// The reset countdown moves while nothing is measured: it redraws as each minute of it turns over, then waits for the
// next; one timer, however often a session starts or a measurement moves the reset
type Countdown = { timer?: Timer; usage: () => Usage | undefined; isShown: () => boolean }

async function scheduleCountdown($: EngineInterface, countdown: Countdown) {
  // a clock that fails to answer still keeps the countdown going, a minute at a time
  const delay = await $.clock.now().then(
    now => untilCountdownMoves(countdown.usage()?.rateLimits ?? [], now),
    () => 60_000,
  )
  countdown.timer?.cancel()
  countdown.timer = $.clock.after(delay, () => {
    if (countdown.isShown()) {
      void draw($, countdown.usage(), true)
    }
    void scheduleCountdown($, countdown)
  })
}

export const register: Register = on => {
  let usage: Usage | undefined
  let isShown = false
  const countdown: Countdown = { usage: () => usage, isShown: () => isShown }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    usage = await $.session.usage().catch(() => usage)
    await scheduleCountdown($, countdown)
    isShown = await redraw($, () => usage)

    return result
  })

  on('session.measure', async ($, e, next) => {
    usage = e
    await scheduleCountdown($, countdown)
    await draw($, usage, isShown)

    return next(e)
  })

  // the desktop app attaches after the session starts, and its leaving clears the line
  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    isShown = await redraw($, () => usage)

    return result
  })

  on('session.detach', async ($, e, next) => {
    const result = await next(e)
    isShown = await redraw($, () => usage)

    return result
  })
}
