import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-14T09:00:00Z')

/** An hour and twenty minutes since the last request: the 1h cache expired 20 minutes ago. */
const expired: Record<string, unknown> = {
  context: { tokens: 300_000, window: 1_000_000, percent: 30 },
  last: { at: NOW - 80 * 60_000, hitPercent: 97, model: 'opus' },
}

const typed = { text: 'продолжай', wait: false, origin: { kind: 'composer' } } as const

test('over an expired cache, a cancelled question keeps the message out and puts it back in the box', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('state.get', ($, e, next) =>
    e.plugin === 'cache-meter' && e.key in expired ? { value: { value: expired[e.key], version: 1 } } : next(e),
  )
  const asked: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    asked.push(e.questions[0]?.question ?? '')
    return { deny: 'dismissed' }
  })
  const entered: string[] = []
  on('prompt.submit', ($, e) => (entered.push(e.text), { text: e.text }))
  const filled: string[] = []
  on('prompt.fill', ($, e) => (filled.push(e.text), { isFilled: true }))

  const result = await $.prompt.submit(typed)
  await clock.advance(500)

  expect(asked[0]).toMatch(/истёк 20 мин назад: сообщение заново запишет ~300k контекста \(≈600k вх\.\)/)
  expect(result.drop).toMatch(/не отправлено/)
  expect(entered).toEqual([])
  expect(filled).toEqual(['продолжай'])
})

test('over an expired cache, «Отправить» lets the message through', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('state.get', ($, e, next) =>
    e.plugin === 'cache-meter' && e.key in expired ? { value: { value: expired[e.key], version: 1 } } : next(e),
  )
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => ({
    result: { questions: e.questions, answers: { [e.questions[0]?.question ?? '']: 'Отправить' } },
  }))
  const entered: string[] = []
  on('prompt.submit', ($, e) => (entered.push(e.text), { text: e.text }))

  const result = await $.prompt.submit(typed)
  expect(result.drop).toBeUndefined()
  expect(entered).toEqual(['продолжай'])
})

test('a live cache, a small context or the setting at 0 never asks', async ($, on) => {
  mock.clock(on, { now: NOW })
  const live: Record<string, unknown> = { ...expired, last: { at: NOW - 10 * 60_000, hitPercent: 97, model: 'opus' } }
  on('state.get', ($, e, next) =>
    e.plugin === 'cache-meter' && e.key in live ? { value: { value: live[e.key], version: 1 } } : next(e),
  )
  let asked = 0
  on('tool.call', { tool: 'AskUserQuestion' }, () => (asked++, { deny: 'no' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))

  expect((await $.prompt.submit(typed)).drop).toBeUndefined()
  expect(asked).toBe(0)
})
