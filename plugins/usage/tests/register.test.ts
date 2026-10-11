import { expect, mock, test } from 'claude-code/testing'
import type { MockClock, On, RenderSurface, SessionRateLimit, SessionUsage } from 'claude-code'

const NOW = Date.parse('2026-10-11T10:00:00Z')
const CONTEXT = { window: 200000, tokens: 54000, percent: 27 }
const LIMITS: SessionRateLimit[] = [
  { kind: 'five_hour', percentUsed: 12.4, resetsAt: '2026-10-11T12:13:00Z' },
  { kind: 'seven_day', percentUsed: 34, resetsAt: '2026-10-15T00:00:00Z' },
]

// The engine beneath the mod: where the session is drawn (changeable mid-test), what it measured, the lines pinned
const engine = (on: On, clock: MockClock | undefined, start: Pick<SessionUsage, 'context' | 'rateLimits'> = { context: CONTEXT, rateLimits: LIMITS }) => {
  const session = { surfaces: ['desktop'] as readonly RenderSurface[], surfacesLateMs: 0, lines: [] as (string | undefined)[] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.attach', ($, e) => ({ clientId: e.clientId }))
  on('session.detach', ($, e) => ({ clientId: e.clientId }))
  on('session.usage', () => ({ value: { startedAt: 0, ...start } }))
  on('session.surfaces', async () => {
    const surfaces = session.surfaces
    if (session.surfacesLateMs > 0) {
      await clock?.sleep(session.surfacesLateMs)
    }
    return { value: surfaces }
  })
  on('ui.status', ($, e) => {
    session.lines.push(e.text)
    return { value: undefined }
  })

  return session
}

// A clock standing still at NOW that counts the countdown's timers and never fires them, or refuses them all
const stillClock = (on: On, refuse = false) => {
  const timers = { armed: 0, waits: [] as number[] }
  on('clock.now', () => ({ value: NOW }))
  on('clock.after', ($, e) => {
    if (refuse) {
      throw new Error('refused')
    }
    timers.armed++
    timers.waits.push(e.ms)
    return new Promise<never>(() => {})
  })

  return timers
}

// A clock that creeps on a millisecond with every reading, as a real one moves between two reads, and fires each
// timer when the test says, as early as the test says
const creepingClock = (on: On, start: number) => {
  let now = start
  const timers: { due: number; fire: () => void }[] = []
  on('clock.now', () => ({ value: now++ }))
  on('clock.after', ($, e) => new Promise<{ value: undefined }>(resolve => {
    timers.push({ due: now + e.ms, fire: () => resolve({ value: undefined }) })
  }))

  return {
    // fires the timer armed last, `early` ms before it is due, and lets what it starts run
    fire: async (early = 0) => {
      await settle()
      const timer = timers.pop()!
      now = timer.due - early
      timer.fire()
      await settle()
    },
  }
}

// Lets what the hooks started without awaiting run to its end
const settle = async () => {
  for (let turn = 0; turn < 50; turn++) {
    await Promise.resolve()
  }
}

// The store the sessions under one configuration directory share, holding what another session wrote under its key,
// and what this one writes under its own
const sharedStore = (on: On, other?: SessionRateLimit[]) => {
  const store = { values: new Map<string, unknown>(), writes: 0 }
  if (other !== undefined) {
    store.values.set('rateLimits:other', other)
  }
  on('store.keys', () => ({ value: [...store.values.keys()] }))
  on('store.get', ($, e) => ({ value: store.values.get(e.key) }))
  on('store.set', ($, e) => {
    store.values.set(e.key, e.value)
    store.writes++
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.values.delete(e.key)
    return { value: undefined }
  })

  return {
    ...store,
    // what this session wrote under its own key
    own: () => [...store.values].find(([key]) => key.startsWith('rateLimits:') && key !== 'rateLimits:other')?.[1],
    get writes() {
      return store.writes
    },
  }
}

const fiveHour = (percentUsed: number, resetsAt = '2026-10-11T12:13:00Z'): SessionRateLimit => ({ kind: 'five_hour', percentUsed, resetsAt })
const sevenDay = (percentUsed: number, resetsAt = '2026-10-15T00:00:00Z'): SessionRateLimit => ({ kind: 'seven_day', percentUsed, resetsAt })

test('draws the newest reading another session shared', async ($, on) => {
  mock.clock(on, { now: NOW })
  sharedStore(on, [fiveHour(50), sevenDay(40)])
  const session = engine(on, undefined)

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })

  expect(session.lines).toEqual(['c27 s50/2:13 w40'])
})

test('keeps its own reading over an older one shared, and shares it', async ($, on) => {
  mock.clock(on, { now: NOW })
  const store = sharedStore(on, [fiveHour(80, '2026-10-11T07:13:00Z'), sevenDay(5)])
  const session = engine(on, undefined)

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })

  expect(session.lines).toEqual(['c27 s12/2:13 w34'])
  expect(store.own()).toEqual(LIMITS)
})

test('shares each new reading for the other sessions, a terminal session too', async ($, on) => {
  mock.clock(on, { now: NOW })
  const store = sharedStore(on)
  const session = engine(on, undefined)
  session.surfaces = ['terminal']

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: CONTEXT, rateLimits: [fiveHour(20), sevenDay(35)], changed: ['rateLimits'] })
  await settle()

  expect(store.own()).toEqual([fiveHour(20), sevenDay(35)])
  expect(session.lines.every(line => line === undefined)).toBe(true)
})

test('writes only when its own reading changed, and never over what another session wrote', async ($, on) => {
  mock.clock(on, { now: NOW })
  const store = sharedStore(on, [fiveHour(50), sevenDay(40)])
  engine(on, undefined)

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  await $.session.measure({ context: { ...CONTEXT, percent: 30 }, rateLimits: [LIMITS[1]!, LIMITS[0]!], changed: ['context'] })
  await settle()

  expect(store.writes).toBe(1)
  expect(store.values.get('rateLimits:other')).toEqual([fiveHour(50), sevenDay(40)])
})

test('removes the reading a session shared once all its windows have reset', async ($, on) => {
  mock.clock(on, { now: NOW })
  const store = sharedStore(on, [fiveHour(80, '2026-10-11T07:13:00Z'), sevenDay(5, '2026-10-11T09:00:00Z')])
  engine(on, undefined)

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })

  expect(store.values.has('rateLimits:other')).toBe(false)
})

test('draws no shared limits in a session that has none of its own, as off a subscription', async ($, on) => {
  mock.clock(on, { now: NOW })
  sharedStore(on, [fiveHour(50), sevenDay(40)])
  const session = engine(on, undefined, { context: CONTEXT, rateLimits: [] })

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })

  expect(session.lines).toEqual(['c27'])
})

test('draws no shared reading of another window while its own still runs, as from another account', async ($, on) => {
  mock.clock(on, { now: NOW })
  sharedStore(on, [fiveHour(90, '2026-10-11T14:00:00Z'), sevenDay(80, '2026-10-17T00:00:00Z')])
  const session = engine(on, undefined)

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })

  expect(session.lines).toEqual(['c27 s12/2:13 w34'])
})

test('draws the window after its own once its own has reset and another session read the next', async ($, on) => {
  mock.clock(on, { now: NOW })
  sharedStore(on, [fiveHour(3, '2026-10-11T14:30:00Z'), sevenDay(34)])
  const passed = [fiveHour(70, '2026-10-11T09:30:00Z'), sevenDay(34)]
  const session = engine(on, undefined, { context: CONTEXT, rateLimits: passed })

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })

  expect(session.lines).toEqual(['c27 s3/4:30 w34'])
})

test('draws its own reading without a reset as it is, and leaves it unshared', async ($, on) => {
  mock.clock(on, { now: NOW })
  const store = sharedStore(on, [fiveHour(50), sevenDay(40)])
  const session = engine(on, undefined, { context: CONTEXT, rateLimits: [{ kind: 'five_hour', percentUsed: 20 }, sevenDay(34)] })

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })

  expect(session.lines).toEqual(['c27 s20 w40'])
  expect(store.own()).toEqual([sevenDay(34)])
})

test('picks up a reading another session shares on the next turn of the countdown', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const store = sharedStore(on)
  const session = engine(on, clock)

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  store.values.set('rateLimits:other', [fiveHour(30), sevenDay(36)])
  await clock.advance(60_000)

  expect(session.lines).toEqual(['c27 s12/2:13 w34', 'c27 s30/2:12 w36'])
})

test('keeps a newer shared reading over its own older one when it measures', async ($, on) => {
  mock.clock(on, { now: NOW })
  sharedStore(on, [fiveHour(50), sevenDay(40)])
  const session = engine(on, undefined)

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  await $.session.measure({ context: { ...CONTEXT, percent: 30 }, rateLimits: [fiveHour(13), sevenDay(34)], changed: ['rateLimits'] })

  expect(session.lines).toEqual(['c27 s50/2:13 w40', 'c30 s50/2:13 w40'])
})

test('reads what the other sessions shared as the desktop app attaches', async ($, on) => {
  mock.clock(on, { now: NOW })
  const store = sharedStore(on)
  const session = engine(on, undefined)
  session.surfaces = ['terminal']

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  store.values.set('rateLimits:other', [fiveHour(50), sevenDay(40)])
  session.surfaces = ['desktop']
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })

  expect(session.lines.at(-1)).toBe('c27 s50/2:13 w40')
})

test('draws its own figures when the store cannot be read or written', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('store.keys', () => {
    throw new Error('unreadable')
  })
  on('store.set', () => {
    throw new Error('unwritable')
  })
  const session = engine(on, undefined)

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  await $.session.measure({ context: CONTEXT, rateLimits: [fiveHour(20), sevenDay(35)], changed: ['rateLimits'] })

  expect(session.lines).toEqual(['c27 s12/2:13 w34', 'c27 s20/2:13 w35'])
})

test('pins the figures in the desktop app and counts the reset down each minute', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const session = engine(on, clock)

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  await clock.advance(60_000)
  await clock.set(Date.parse('2026-10-11T12:00:00Z'))

  expect(session.lines.slice(0, 2)).toEqual(['c27 s12/2:13 w34', 'c27 s12/2:12 w34'])
  expect(session.lines.at(-1)).toBe('c27 s12/0:13 w34')
})

test('rounds the time until the reset up to the minute, as Claude Desktop does', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-11T10:00:30Z') })
  const session = engine(on, clock)

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  await clock.set(Date.parse('2026-10-11T12:12:30Z'))

  expect(session.lines.slice(0, 1)).toEqual(['c27 s12/2:13 w34'])
  expect(session.lines.at(-1)).toBe('c27 s12/0:01 w34')
})

test('turns the countdown over as the minute left runs out, not a minute from the session start', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-11T10:00:30Z') })
  const session = engine(on, clock)

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  await clock.advance(29_999)
  const before = session.lines.at(-1)
  await clock.advance(1)

  expect([before, session.lines.at(-1)]).toEqual(['c27 s12/2:13 w34', 'c27 s12/2:12 w34'])
})

test('draws the week as started over the moment its reset passes, not on the next turn of the countdown', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const weekSoon: SessionRateLimit[] = [LIMITS[0]!, { kind: 'seven_day', percentUsed: 34, resetsAt: '2026-10-11T10:00:20Z' }]
  const session = engine(on, clock, { context: CONTEXT, rateLimits: weekSoon })

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  await clock.advance(20_000)

  expect(session.lines).toEqual(['c27 s12/2:13 w34', 'c27 s12/2:13 w0'])
})

test('turns over on time even when a timer fires a moment early', async ($, on) => {
  const clock = creepingClock(on, NOW)
  const session = engine(on, undefined)

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  // due as 2:13 left turns to 2:12; fired 1 ms early, it draws 2:13 and is due again a moment later
  await clock.fire(1)
  await clock.fire()

  expect(session.lines.at(-1)).toBe('c27 s12/2:12 w34')
})

test('waits a minute at most, even with the week reset days ahead', async ($, on) => {
  const timers = stillClock(on)
  const passed: SessionRateLimit[] = [{ ...LIMITS[0]!, resetsAt: '2026-10-11T09:00:00Z' }, LIMITS[1]!]
  engine(on, undefined, { context: CONTEXT, rateLimits: passed })

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })

  expect(timers.waits).toEqual([60_000])
})

test('keeps no countdown while the line is hidden', async ($, on) => {
  const timers = stillClock(on)
  const session = engine(on, undefined)
  session.surfaces = ['terminal']

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: CONTEXT, rateLimits: LIMITS, changed: ['context'] })
  session.surfaces = ['desktop']
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  const whileShown = timers.armed
  session.surfaces = ['terminal']
  await $.session.attach({ surface: 'terminal', clientId: 'terminal:default' })
  await $.session.measure({ context: { ...CONTEXT, percent: 30 }, rateLimits: [{ ...LIMITS[0]!, resetsAt: '2026-10-11T14:00:00Z' }], changed: ['rateLimits'] })

  expect([whileShown, timers.armed]).toEqual([1, 1])
})

test('re-arms the countdown only when a reset moves', async ($, on) => {
  const timers = stillClock(on)
  engine(on, undefined)

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  await $.session.measure({ context: { ...CONTEXT, percent: 30 }, rateLimits: LIMITS, changed: ['context'] })
  const unmoved = timers.armed
  const moved = [{ ...LIMITS[0]!, resetsAt: '2026-10-11T14:00:00Z' }, LIMITS[1]!]
  await $.session.measure({ context: CONTEXT, rateLimits: moved, changed: ['rateLimits'] })
  await Promise.resolve()

  expect([unmoved, timers.armed]).toEqual([1, 2])
})

test('still pins the line when the countdown cannot be armed', async ($, on) => {
  stillClock(on, true)
  const session = engine(on, undefined)

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  await $.session.measure({ context: { ...CONTEXT, percent: 30 }, rateLimits: LIMITS, changed: ['context'] })

  expect(session.lines).toEqual(['c27 s12/2:13 w34', 'c30 s12/2:13 w34'])
})

test('redraws on each measurement, leaving out a figure not yet reported', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const session = engine(on, clock, { context: { window: 200000 }, rateLimits: [] })

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  await $.session.measure({ context: CONTEXT, rateLimits: LIMITS, changed: ['context', 'rateLimits'] })

  expect(session.lines).toEqual([undefined, 'c27 s12/2:13 w34'])
})

test('counts a window whose reset has passed as started over', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const session = engine(on, clock)

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  await clock.set(Date.parse('2026-10-11T12:13:00Z'))

  expect(session.lines.at(-1)).toBe('c27 s0 w34')
})

test('rounds down, so a window shows 100 only once it is used up', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const session = engine(on, clock)
  const nearly = [{ ...LIMITS[0]!, percentUsed: 99.6 }, { ...LIMITS[1]!, percentUsed: 100 }]

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  await $.session.measure({ context: { ...CONTEXT, percent: 99 }, rateLimits: nearly, changed: ['rateLimits'] })

  expect(session.lines.at(-1)).toBe('c99 s99/2:13 w100')
})

for (const surfaces of [['terminal'], ['terminal', 'desktop']] as const) {
  test(`shows nothing in a session a terminal draws on (${surfaces.join(', ')})`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const session = engine(on, clock)
    session.surfaces = surfaces

    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.session.measure({ context: CONTEXT, rateLimits: LIMITS, changed: ['context'] })
    await clock.advance(60_000)

    expect(session.lines.every(line => line === undefined)).toBe(true)
  })
}

test('draws once the desktop app attaches, and clears the line when it leaves', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const session = engine(on, clock)
  session.surfaces = []

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  session.surfaces = ['desktop']
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  session.surfaces = []
  await $.session.detach({ clientId: 'desktop:default', reason: 'detach' })

  expect(session.lines).toEqual([undefined, 'c27 s12/2:13 w34', undefined])
})

test('keeps one countdown however often a session starts', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const session = engine(on, clock)

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  await clock.advance(60_000)

  expect(session.lines).toEqual(['c27 s12/2:13 w34', 'c27 s12/2:13 w34', 'c27 s12/2:12 w34'])
})

test('never pins older figures over newer ones when draws overlap', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const session = engine(on, clock)

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  session.surfacesLateMs = 1_000
  const attaching = $.session.attach({ surface: 'desktop', clientId: 'desktop:second' })
  await $.session.measure({ context: { ...CONTEXT, percent: 40 }, rateLimits: LIMITS, changed: ['context'] })
  await clock.advance(1_000)
  await attaching

  expect(session.lines.at(-1)).toBe('c40 s12/2:13 w34')
})
