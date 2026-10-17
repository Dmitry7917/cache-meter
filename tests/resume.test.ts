import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-17T09:00:00Z')
const scroll = { offset: 0, bodyRows: 40 }
const bandProps = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll, view: {} }
const start = { cwd: '/w', surface: 'terminal', isInteractive: true } as const

test('a resumed session shows its last context, cache and limits before the first answer', async ($, on) => {
  mock.clock(on, { now: NOW })
  const deleted: string[] = []
  on('store.delete', { key: 'snapshot:old' }, ($, e, next) => (deleted.push(e.key), next(e)))
  mock.store(on, {
    'snapshot:s1': {
      savedAt: NOW - 30 * 60_000,
      context: { tokens: 250_000, window: 1_000_000, percent: 25 },
      last: { at: NOW - 30 * 60_000, hitPercent: 97, model: 'opus' },
    },
    // A window already reset reads as nothing; the weekly one still holds.
    rateLimits: [
      { kind: 'five_hour', percentUsed: 40, resetsAt: '2026-10-17T08:00:00Z' },
      { kind: 'seven_day', percentUsed: 12, resetsAt: '2026-10-20T21:00:00Z' },
    ],
    'snapshot:old': { savedAt: NOW - 61 * 86_400_000, context: null, last: null },
  })
  on('session.id', () => ({ value: 's1' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))

  await $.session.start(start)

  const band = await $.ui.mount({ plugin: 'cache-meter', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
  expect(await band.find({ type: 'Text', text: / ≈250k\/1M \(25%\)$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^30:00$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^12%$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^40%$/ })).toBeUndefined()
  await band.unmount()
  expect(deleted).toEqual(['snapshot:old'])
})

test('a new session with nothing saved starts empty', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.id', () => ({ value: 'fresh' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))

  await $.session.start(start)

  const band = await $.ui.mount({ plugin: 'cache-meter', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
  expect(await band.find({ type: 'Text', text: /^ctx —$/ })).toBeDefined()
  await band.unmount()
})
