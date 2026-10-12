import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit, Timer } from 'claude-code'

import { formatUsage, untilCountdownMoves } from './format'
import { adoptLimits, isCovered, limitsKey, mergeLimits, parseShared, resetsKey, shareable } from './limits'

// What one session knows and draws, kept in one place for the hooks and the countdown alike
type Session = {
  // this session's key in the store
  id: string
  context?: SessionContextUsage
  // the windows as this session last read them, and every reading the other sessions under this configuration
  // directory last shared
  own: SessionRateLimit[]
  shared: SessionRateLimit[]
  // the reading this session's key holds (limitsKey), undefined when unknown; its writes, one after another; and the
  // read of the store under way, so two never overlap
  sharedKey?: string
  writing: Promise<void>
  reading?: Promise<void>
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
// what an earlier build of this mod kept all the sessions' readings under
const LEGACY = 'rateLimits'
// another session's key that adds nothing is removed only once unwritten this long, so a reading its owner writes
// while it is being weighed is not lost with it
const STALE_MS = 10 * 60_000

const ownKey = (session: Session) => SHARED + session.id

// Writes or removes this session's key, after its earlier writes, so the store ends on the last; the time is read as
// the write's turn comes
function write($: EngineInterface, session: Session, limits: readonly SessionRateLimit[] | undefined) {
  session.sharedKey = limitsKey(limits ?? [])
  session.writing = session.writing.then(() => persist($, session, limits))
  return session.writing
}

async function persist($: EngineInterface, session: Session, limits: readonly SessionRateLimit[] | undefined) {
  try {
    if (limits === undefined) {
      await $.store.delete(ownKey(session))
    } else {
      await $.store.set(ownKey(session), { at: await $.clock.now().catch(() => Date.now()), limits })
    }
  } catch (error) {
    session.sharedKey = undefined
    $.ui.log(`usage: sharing the limits failed: ${String(error)}`, { to: 'debug' })
  }
}

// Writes this session's own reading under its key when it changed
function share($: EngineInterface, session: Session) {
  const limits = shareable(session.own)
  return limitsKey(limits) === session.sharedKey ? session.writing : write($, session, limits.length === 0 ? undefined : limits)
}

// Every entry the sessions shared; none when the store cannot be read
async function readEntries($: EngineInterface) {
  try {
    const keys = await $.store.keys()
    if (keys.includes(LEGACY)) {
      await $.store.delete(LEGACY).catch(() => undefined)
    }
    // a key that cannot be read is passed over, neither drawn nor removed
    const entries = await Promise.all(
      keys
        .filter(key => key.startsWith(SHARED))
        .map(key => $.store.get(key).then(value => parseShared(key, value), () => undefined)),
    )
    return entries.filter(entry => entry !== undefined)
  } catch (error) {
    $.ui.log(`usage: reading the shared limits failed: ${String(error)}`, { to: 'debug' })
    return undefined
  }
}

// Reads what the other sessions shared, and keeps the store lean: this session takes its own key out while another
// covers it and puts it back once none does; another session's key that adds nothing goes once it is stale, as a
// closed session's. One read at a time, each after the session's own writes, so it weighs the key as it stands
function readShared($: EngineInterface, session: Session, now: number) {
  session.reading ??= syncShared($, session, now).finally(() => {
    session.reading = undefined
  })
  return session.reading
}

async function syncShared($: EngineInterface, session: Session, now: number) {
  await session.writing
  const entries = await readEntries($)
  if (entries === undefined) {
    return
  }
  const others = entries.filter(entry => entry.key !== ownKey(session))
  const stale = others.filter(entry => now - entry.at >= STALE_MS && isCovered(entry.key, entry.limits, entries, now))
  await Promise.all(stale.map(entry => $.store.delete(entry.key).catch(() => undefined)))
  session.shared = others.filter(entry => !stale.includes(entry)).flatMap(entry => entry.limits)

  const limits = shareable(session.own)
  const held = entries.find(entry => entry.key === ownKey(session))
  if (isCovered(ownKey(session), limits, entries, now)) {
    if (held !== undefined) {
      await write($, session, undefined)
    }
    session.sharedKey = limitsKey(limits)
  } else if (held === undefined || limitsKey(held.limits) !== limitsKey(limits)) {
    await write($, session, limits)
  }
}

// Reads where the session is drawn, picks up what the other sessions shared when the line is shown, and draws it
async function redraw($: EngineInterface, session: Session) {
  const surfaces = await $.session.surfaces()
  session.isShown = surfaces.includes('desktop') && !surfaces.includes('terminal')
  if (session.isShown) {
    const now = await $.clock.now().catch(() => undefined)
    if (now !== undefined) {
      await readShared($, session, now)
    }
    await draw($, session, now)
    return
  }
  await draw($, session)
}

// The line changes on its own while nothing is measured, as the reset countdown turns over, a window resets and
// another session shares a newer reading: one timer redraws it then and waits for the next change, armed only while
// the line is shown
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
    const resets = resetsKey(limits)
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
      await readShared($, session, now)
    }
    await draw($, session, now)
  }
  await armCountdown($, session, now)
}

export const register: Register = on => {
  // a fresh key holds nothing yet
  const session: Session = {
    id: crypto.randomUUID(),
    own: [],
    shared: [],
    sharedKey: '',
    isShown: false,
    writing: Promise.resolve(),
  }

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

  // an ending session takes its key out of the store when another covers it, after its last write; one holding the
  // newest reading of a window stays for the others, until a newer one covers it. After a /clear the process goes on,
  // and shares again with its next new reading
  on('session.end', async ($, e, next) => {
    const result = await next(e)
    await session.writing
    const entries = await readEntries($)
    const now = await $.clock.now().catch(() => undefined)
    if (entries !== undefined && now !== undefined && isCovered(ownKey(session), shareable(session.own), entries, now)) {
      await write($, session, undefined)
    }

    return result
  })
}
