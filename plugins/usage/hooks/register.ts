import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import { formatUsage } from './format'

type Usage = { context: SessionContextUsage; rateLimits: readonly SessionRateLimit[] }

// The line is for the Claude desktop app alone: a session a terminal draws on keeps its own status line clear
async function draw($: EngineInterface, usage: Usage | undefined) {
  const surfaces = await $.session.surfaces()
  const isDesktopOnly = surfaces.includes('desktop') && !surfaces.includes('terminal')

  if (!isDesktopOnly) {
    $.ui.status(undefined)
  } else if (usage !== undefined) {
    $.ui.status(formatUsage(usage.context, usage.rateLimits, await $.clock.now()))
  }
}

export const register: Register = on => {
  let usage: Usage | undefined

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    usage = await $.session.usage()
    await draw($, usage)
    // the reset countdown moves while nothing is measured
    $.clock.every(60_000, () => void draw($, usage))

    return result
  })

  on('session.measure', async ($, e, next) => {
    usage = e
    await draw($, usage)

    return next(e)
  })

  // the desktop app attaches after the session starts
  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    await draw($, usage)

    return result
  })

  on('session.detach', async ($, e, next) => {
    const result = await next(e)
    await draw($, usage)

    return result
  })
}
