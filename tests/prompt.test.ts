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

const live: Record<string, unknown> = { ...expired, last: { at: NOW - 15 * 60_000, hitPercent: 97, model: 'opus' } }
const modelCommand = {
  command: 'model',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 160 },
} as const

test('/model over a live cache asks first, and a cancel keeps the cache', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('state.get', ($, e, next) =>
    e.plugin === 'cache-meter' && e.key in live ? { value: { value: live[e.key], version: 1 } } : next(e),
  )
  const asked: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    asked.push(e.questions[0]?.question ?? '')
    return { result: { questions: e.questions, answers: { [e.questions[0]?.question ?? '']: 'Отмена' } } }
  })
  let ran = 0
  on('command.run', { command: 'model' }, () => (ran++, { text: 'picker' }))

  const result = await $.command.run(modelCommand)
  expect(asked[0]).toMatch(/^Смена модели сбросит кэш: следующий запрос заново запишет ~300k \(≈600k вх\.\), а кэш жив ещё 45 мин/)
  expect(result.text).toBe('Смена модели отменена, кэш сохранён.')
  expect(ran).toBe(0)
})

test('/model over an expired cache runs without asking', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('state.get', ($, e, next) =>
    e.plugin === 'cache-meter' && e.key in expired ? { value: { value: expired[e.key], version: 1 } } : next(e),
  )
  let asked = 0
  on('tool.call', { tool: 'AskUserQuestion' }, () => (asked++, { deny: 'no' }))
  on('command.run', { command: 'model' }, () => ({ text: 'picker' }))

  expect((await $.command.run(modelCommand)).text).toBe('picker')
  expect(asked).toBe(0)
})
