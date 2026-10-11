import type { EngineInterface, Register, SessionUsage, Timer } from 'claude-code'

import { formatUsage } from './format'

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

export const register: Register = on => {
  let usage: Usage | undefined
  let isShown = false
  let countdown: Timer | undefined

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // the reset countdown moves while nothing is measured; one timer, however often a session starts
    countdown?.cancel()
    countdown = $.clock.every(60_000, () => {
      if (isShown) {
        void draw($, usage, isShown)
      }
    })
    usage = await $.session.usage().catch(() => usage)
    isShown = await redraw($, () => usage)

    return result
  })

  on('session.measure', async ($, e, next) => {
    usage = e
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
