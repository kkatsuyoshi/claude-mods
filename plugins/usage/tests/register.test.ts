import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

const NOW = Date.parse('2026-10-11T10:00:00Z')
const CONTEXT = { window: 200000, tokens: 54000, percent: 27 }
const LIMITS = [
  { kind: 'five_hour', percentUsed: 12.4, resetsAt: '2026-10-11T12:13:00Z' },
  { kind: 'seven_day', percentUsed: 34, resetsAt: '2026-10-15T00:00:00Z' },
]

const engine = (on: On, surfaces: readonly RenderSurface[]) => {
  const lines: (string | undefined)[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.usage', () => ({ value: { startedAt: 0, context: CONTEXT, rateLimits: LIMITS } }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('ui.status', ($, e) => {
    lines.push(e.text)
    return { value: undefined }
  })

  return lines
}

test('pins the figures in the desktop app and counts the reset down each minute', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const lines = engine(on, ['desktop'])

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
  await clock.advance(60_000)
  await clock.set(Date.parse('2026-10-11T12:00:00Z'))

  expect(lines.slice(0, 2)).toEqual(['c27 s12/2:13 w34', 'c27 s12/2:12 w34'])
  expect(lines.at(-1)).toBe('c27 s12/0:13 w34')
})

test('redraws on each measurement, leaving out a figure not yet reported or a reset already passed', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-11T13:00:00Z') })
  const lines = engine(on, ['desktop'])

  await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })
  await $.session.measure({ context: CONTEXT, rateLimits: LIMITS, changed: ['context', 'rateLimits'] })

  expect(lines).toEqual([undefined, 'c27 s12 w34'])
})

for (const surfaces of [['terminal'], ['terminal', 'desktop']] as const) {
  test(`shows nothing in a session a terminal draws on (${surfaces.join(', ')})`, async ($, on) => {
    mock.clock(on, { now: NOW })
    const lines = engine(on, surfaces)

    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.session.measure({ context: CONTEXT, rateLimits: LIMITS, changed: ['context'] })

    expect(lines.every(line => line === undefined)).toBe(true)
  })
}

test('draws once the desktop app attaches', async ($, on) => {
  mock.clock(on, { now: NOW })
  const lines = engine(on, ['desktop'])
  on('session.attach', ($, e) => ({ clientId: e.clientId }))

  await $.session.measure({ context: CONTEXT, rateLimits: LIMITS, changed: ['context'] })
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })

  expect(lines).toEqual(['c27 s12/2:13 w34', 'c27 s12/2:13 w34'])
})
