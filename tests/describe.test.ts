import { expect, test } from 'claude-code/testing'

import {
  baseName,
  callLabel,
  keepBiggest,
  estimateTokens,
  toolGroup,
  formatReset,
  formatTime,
  inputEquivalent,
  parseTzOffset,
  plural,
  sparkline,
  turnSummary,
  cacheColor,
  cacheLossReason,
  limitColor,
  limitLabel,
  contextColor,
  formatBar,
  formatClock,
  formatTokens,
  GREEN,
  ORANGE,
  RED,
  YELLOW,
} from '../hooks/format'

const HOUR = 60 * 60_000
const MIN = 60_000

test('formats tokens and clock', async () => {
  expect(formatTokens(950)).toBe('950')
  expect(formatTokens(123_456)).toBe('123k')
  expect(formatTokens(1_000_000)).toBe('1M')
  expect(formatClock(47 * MIN + 12_000)).toBe('47:12')
  expect(formatClock(0)).toBe('0:00')
})

test('draws the window fill as a 20-cell bar', async () => {
  expect(formatBar(0)).toBe('░'.repeat(20))
  expect(formatBar(1)).toBe('█'.repeat(20))
  expect(formatBar(0.123456)).toBe('██▌' + '░'.repeat(17))
  expect(formatBar(0.5)).toBe('█'.repeat(10) + '░'.repeat(10))
})

test('colors the context by absolute size, not window share', async () => {
  const t = { yellow: 100_000, orange: 150_000, red: 250_000 }
  expect(contextColor(99_999, t)).toBe(GREEN)
  expect(contextColor(100_000, t)).toBe(YELLOW)
  expect(contextColor(150_000, t)).toBe(ORANGE)
  expect(contextColor(250_000, t)).toBe(RED)
})

test('colors the cache by share of TTL left', async () => {
  expect(cacheColor(45 * MIN, HOUR)).toBe(GREEN)
  expect(cacheColor(30 * MIN, HOUR)).toBe(YELLOW)
  expect(cacheColor(15 * MIN, HOUR)).toBe(ORANGE)
  expect(cacheColor(6 * MIN, HOUR)).toBe(RED)
  expect(cacheColor(-MIN, HOUR)).toBe(RED)
  expect(cacheColor(4 * MIN, 5 * MIN)).toBe(GREEN)
  expect(cacheColor(30_000, 5 * MIN)).toBe(RED)
})

test('colors subscription limits and names their windows', async () => {
  expect(limitColor(10)).toBe(GREEN)
  expect(limitColor(50)).toBe(YELLOW)
  expect(limitColor(75)).toBe(ORANGE)
  expect(limitColor(90)).toBe(RED)
  expect(limitLabel('five_hour')).toBe('5ч')
  expect(limitLabel('seven_day')).toBe('7д')
  expect(limitLabel('spend_limit')).toBe('spend_limit')
})

test('names why a live cache was lost, and stays quiet otherwise', async () => {
  const prev = { at: 0, hitPercent: 98, model: 'opus', effort: 'high' }
  const at = (min: number) => ({ ...prev, at: min * MIN, hitPercent: 3 })

  expect(cacheLossReason(null, at(1), 100_000, false, HOUR)).toBeNull()
  expect(cacheLossReason(prev, { ...at(1), hitPercent: 97 }, 100_000, false, HOUR)).toBeNull()
  expect(cacheLossReason(prev, at(1), 5_000, false, HOUR)).toBeNull()
  expect(cacheLossReason(prev, at(61), 100_000, false, HOUR)).toBeNull()
  expect(cacheLossReason(prev, at(1), 100_000, true, HOUR)).toBeNull()

  expect(cacheLossReason(prev, { ...at(1), model: 'sonnet' }, 100_000, false, HOUR)).toBe(
    'смена модели: opus → sonnet',
  )
  expect(cacheLossReason(prev, { ...at(1), effort: 'low' }, 100_000, false, HOUR)).toBe(
    'смена effort: high → low',
  )
  expect(cacheLossReason(prev, at(1), 100_000, false, HOUR)).toBe(
    'изменилось начало промпта: CLAUDE.md, инструменты/MCP, /clear',
  )
  expect(cacheLossReason(prev, at(20), 100_000, false, HOUR)).toBe(
    'изменилось начало промпта: CLAUDE.md, инструменты/MCP, /clear; или TTL сейчас 5m (пауза 20 мин)',
  )
})

test('reads the local offset and shows reset times in it', async () => {
  expect(parseTzOffset('+0300\n')).toBe(180)
  expect(parseTzOffset('-0530')).toBe(-330)
  expect(parseTzOffset('garbage')).toBe(0)

  const now = Date.parse('2026-10-14T09:00:00Z')
  expect(formatTime(now, 180)).toBe('12:00')
  expect(formatReset('2026-10-14T11:30:00Z', now, 180)).toBe('14:30')
  expect(formatReset('2026-10-16T07:00:00Z', now, 180)).toBe('пт 10:00')
  expect(formatReset('not a date', now, 180)).toBeNull()
})

test('draws context growth as a sparkline', async () => {
  expect(sparkline([0, 50, 100])).toBe('▁▄█')
  expect(sparkline([])).toBe('')
})

test('weighs tokens by price and sums an answer up', async () => {
  const tokens = { input: 1_000, read: 100_000, write: 10_000, output: 2_000 }
  expect(inputEquivalent(tokens)).toBe(1_000 + 5_000 + 20_000 + 10_000)
  expect(turnSummary({ at: 0, requests: 3, tokens, agentRuns: 0, agentTokens: 0, contextTokens: null })).toBe(
    'ответ: 3 запроса · кэш: чтение 100k / запись 10k · ввод 1k · вывод 2k · ≈36k вх.',
  )
  expect(turnSummary({ at: 0, requests: 1, tokens, agentRuns: 2, agentTokens: 450_000, contextTokens: null })).toBe(
    'ответ: 1 запрос · кэш: чтение 100k / запись 10k · ввод 1k · вывод 2k · агенты 2 (450k) · ≈36k вх.',
  )
  expect(plural(11, 'запрос', 'запроса', 'запросов')).toBe('запросов')
  expect(plural(22, 'запрос', 'запроса', 'запросов')).toBe('запроса')
})

test('estimates tool output and groups MCP tools by server', async () => {
  expect(estimateTokens('x'.repeat(4_000))).toBe(1_000)
  expect(toolGroup('Read')).toBe('Read')
  expect(toolGroup('mcp__phpstorm__search_text')).toBe('MCP phpstorm')
  expect(toolGroup('mcp__claude-in-chrome__navigate')).toBe('MCP claude-in-chrome')
})

test('labels calls by what they read or ran', async () => {
  expect(baseName('/a/b/UserController.php')).toBe('UserController.php')
  expect(callLabel('Read', { file_path: '/a/b/config.php' })).toBe('Read config.php')
  expect(callLabel('Bash', { command: 'make   test\n  --filter X' })).toBe('Bash make test --filter X')
  expect(callLabel('Grep', { pattern: 'handleRequest' })).toBe('Grep handleRequest')
  expect(callLabel('mcp__phpstorm__get_file_problems', {})).toBe('mcp__phpstorm__get_file_problems')
  expect(callLabel('Bash', { command: 'x'.repeat(60) })).toBe('Bash ' + 'x'.repeat(39) + '…')
})

test('keeps the biggest results, biggest first', async () => {
  const r = (tokens: number) => ({ at: 0, label: `r${tokens}`, tokens })
  expect(keepBiggest([r(5), r(1)], r(3), 2).map(b => b.tokens)).toEqual([5, 3])
})
