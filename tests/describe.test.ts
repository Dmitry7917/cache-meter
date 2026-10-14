import { expect, test } from 'claude-code/testing'

import {
  baseName,
  cacheHitPercent,
  cacheSavings,
  dayKey,
  dayLabel,
  lastDays,
  mergeDays,
  sumDays,
  addDay,
  agentTypeRows,
  modelLabel,
  modelRows,
  NO_DAY,
  NO_TOKENS,
  withAgentType,
  withModel,
  mcpPrefix,
  usageOver,
  withMcpCall,
  withSkillCall,
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
  contextGradient,
  gradientColor,
  joinCells,
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

test('counts days in local time and sums sessions', async () => {
  const day = { answers: 1, requests: 2, main: { input: 1, read: 100, write: 10, output: 1 }, agents: { input: 0, read: 0, write: 0, output: 0 }, service: { input: 0, read: 0, write: 0, output: 0 }, losses: 0, lostWritten: 0, compactions: 0 }
  expect(dayKey(Date.parse('2026-10-13T22:30:00Z'), 180)).toBe('2026-10-14')
  expect(dayKey(Date.parse('2026-10-13T22:30:00Z'), 0)).toBe('2026-10-13')
  expect(dayLabel('2026-10-10')).toBe('сб 10.10')
  expect(lastDays('2026-10-01', 3)).toEqual(['2026-09-29', '2026-09-30', '2026-10-01'])
  const merged = mergeDays([{ '2026-10-14': day }, { '2026-10-14': day, '2026-10-13': day }])
  expect(merged['2026-10-14']?.answers).toBe(2)
  expect(sumDays(merged, ['2026-10-13', '2026-10-14', '2026-10-12']).requests).toBe(6)
  expect(cacheHitPercent(day.main)).toBe(90)
  // 100 read at 0.95 saved, 10 written at 1 more than input.
  expect(cacheSavings(day.main)).toBe(85)
})

test('splits days by model and subagent type, and reads days stored before without them', async () => {
  const t = { input: 1_000, read: 100_000, write: 10_000, output: 2_000 }
  expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(modelLabel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5')
  expect(modelLabel('claude-opus-4')).toBe('Opus 4')
  expect(modelLabel('gpt-x')).toBe('gpt-x')

  // The same model under two ids is one row.
  let day = withModel(withModel(NO_DAY, 'claude-opus-5-5', t), 'claude-opus-5-5[1m]', t)
  day = withModel(day, 'claude-haiku-4-5-20251001', t)
  day = withModel(day, '', t)
  day = withAgentType(withAgentType(day, 'Explore', 1, NO_TOKENS), 'Explore', 0, t)
  day = withAgentType(day, 'Plan', 1, { ...t, output: 0 })
  expect(modelRows(day).map(m => [m.label, m.tokens.read])).toEqual([['Opus 5.5', 200_000], ['Haiku 4.5', 100_000]])
  expect(agentTypeRows(day).map(a => [a.type, a.runs])).toEqual([['Explore', 1], ['Plan', 1]])

  // A day from before 0.11.0 has neither map: summing keeps the other day's.
  const sum = addDay(day, NO_DAY)
  expect(sum.models?.['claude-opus-5-5']?.read).toBe(100_000)
  expect(addDay(sum, day).agentTypes?.Explore?.runs).toBe(2)
  expect(addDay(NO_DAY, NO_DAY).models).toBeUndefined()
})

test('counts MCP calls by tool prefix and skill runs, with the last day used', async () => {
  expect(mcpPrefix('mcp__claude_ai_Claude_Docs__batch')).toBe('mcp__claude_ai_Claude_Docs__')
  expect(mcpPrefix('Read')).toBeNull()
  const days = {
    '2026-10-12': withSkillCall(withMcpCall(NO_DAY, 'mcp__phpstorm__'), 'graphify'),
    '2026-10-14': withMcpCall(withMcpCall(NO_DAY, 'mcp__phpstorm__'), 'mcp__phpstorm__'),
    '2026-10-13': NO_DAY,
  }
  const usage = usageOver(days, ['2026-10-12', '2026-10-13', '2026-10-14'], d => d.mcpCalls)
  expect(usage.get('mcp__phpstorm__')).toEqual({ calls: 3, lastDay: '2026-10-14' })
  expect(usageOver(days, ['2026-10-13', '2026-10-14'], d => d.skillCalls).has('graphify')).toBe(false)
  expect(addDay(days['2026-10-12'], days['2026-10-14']).mcpCalls).toEqual({ mcp__phpstorm__: 3 })
})

test('draws the context as a gradient with each zone dashed ahead', async () => {
  const t = { yellow: 200_000, orange: 300_000, red: 400_000 }
  expect(gradientColor(0, t)).toBe(GREEN)
  expect(gradientColor(200_000, t)).toBe(YELLOW)
  expect(gradientColor(400_000, t)).toBe(RED)
  expect(gradientColor(900_000, t)).toBe(RED)

  // The line ends at red: 25 cells of 16k.
  const cells = contextGradient(250_000, t)
  expect(cells).toHaveLength(25)
  expect(cells.filter(c => c.isFilled)).toHaveLength(16)
  expect(cells.slice(16).map(c => c.color)).toEqual([...Array(3).fill(YELLOW), ...Array(6).fill(ORANGE)])
  expect(joinCells(cells.slice(16)).map(r => r.char)).toEqual(['╌╌╌', '╌╌╌╌╌╌'])
  expect(contextGradient(400_000, t).every(c => c.isFilled && c.color === RED)).toBe(true)
  expect(contextGradient(0, t).some(c => c.isFilled)).toBe(false)
})
