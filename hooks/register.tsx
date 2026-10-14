import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptSubmitInput, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type {
  AgentRecord,
  BigResult,
  CacheHit,
  CacheLoss,
  ContextFill,
  DayStats,
  FileReads,
  RateLimitFill,
  Tokens,
  ToolUsage,
  TurnRecord,
} from '../types'
import {
  addTokens,
  addDay,
  baseName,
  cacheHitPercent,
  cacheSavings,
  callLabel,
  clip,
  cacheColor,
  cacheLossReason,
  contextColor,
  dayKey,
  dayLabel,
  dayTokens,
  estimateTokens,
  formatBar,
  formatClock,
  formatReset,
  formatTime,
  formatTokens,
  inputEquivalent,
  keepBiggest,
  lastDays,
  limitColor,
  limitLabel,
  mergeDays,
  NO_DAY,
  NO_TOKENS,
  parseTzOffset,
  plural,
  sparkline,
  sumDays,
  toolGroup,
  totalTokens,
  turnSummary,
} from './format'
import type { ContextThresholds } from './format'

const PANE = 'cache-meter'
const STATS_PANE = 'cache-stats'
/** Each session's days are one store key, so parallel sessions never overwrite each other. */
const STORE_PREFIX = 'days:'
const KEEP_DAYS = 60
const KEEPALIVE_PROMPT = 'Служебный запрос для продления кэша: ответь одним словом «ok».'
const COMPACT_POLL_MS = 1000
const COMPACT_POLL_ATTEMPTS = 30

const last = atom({ plugin: 'cache-meter', key: 'last' } as const, null)
const contextFill = atom({ plugin: 'cache-meter', key: 'context' } as const, null)
const limits = atom({ plugin: 'cache-meter', key: 'rateLimits' } as const, [])
const clockNow = atom({ plugin: 'cache-meter', key: 'now' } as const, 0)
const warnedFor = atom({ plugin: 'cache-meter', key: 'warnedFor' } as const, null)
const compactedAt = atom({ plugin: 'cache-meter', key: 'compactedAt' } as const, null)
const turns = atom({ plugin: 'cache-meter', key: 'turns' } as const, [])
const losses = atom({ plugin: 'cache-meter', key: 'losses' } as const, [])
const agentLog = atom({ plugin: 'cache-meter', key: 'agentLog' } as const, [])
const agentTotals = atom({ plugin: 'cache-meter', key: 'agentTotals' } as const, { runs: 0, tokens: 0 })
const tzOffset = atom({ plugin: 'cache-meter', key: 'tzOffsetMinutes' } as const, 0)
const toolUsage = atom({ plugin: 'cache-meter', key: 'toolUsage' } as const, {})
const autoCredits = atom({ plugin: 'cache-meter', key: 'autoCredits' } as const, 1)
const bigResults = atom({ plugin: 'cache-meter', key: 'bigResults' } as const, [])
const fileReads = atom({ plugin: 'cache-meter', key: 'fileReads' } as const, {})
const ownDays = atom({ plugin: 'cache-meter', key: 'ownDays' } as const, {})
const otherDays = atom({ plugin: 'cache-meter', key: 'otherDays' } as const, {})

type Settings = { ttlMs: number; ttlLabel: string; warnMs: number; autoMs: number }

const SEND = 'Отправить'
const COMPACT_AND_SEND = 'Сжать и отправить'
const CANCEL = 'Отмена'

type KeepaliveOutcome = { isRefreshed: boolean; text: string }

/** This plugin's own commands: typing them does not count as writing a message. */
const OWN_COMMANDS = ['cache-meter', 'cache-stats', 'keepalive']

/** What a main-thread answer in progress has added up so far. */
type TurnTally = { requests: number; tokens: Tokens; agentRuns: number; agentTokens: number }

const tallies = new Map<string, TurnTally>()
let currentTurnId: string | null = null
let isTurnRunning = false
let isKeepaliveRunning = false
/** This load's store key: a hot reload starts a new one, so nothing is counted twice. */
let storeKey = ''
/** Set by the compact hook, so a compaction this plugin asked for is not handled twice. */
let isCompactHandled = false

function thousands(value: unknown, fallback: number): number {
  return typeof value === 'number' && value > 0 ? value * 1000 : fallback * 1000
}

function toFill(usage: SessionContextUsage): ContextFill | null {
  if (usage.tokens === undefined) return null
  return { tokens: usage.tokens, window: usage.window, percent: usage.percent ?? 0 }
}

function toLimits(rateLimits: readonly SessionRateLimit[]): RateLimitFill[] {
  return rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt }))
}

function tallyOf(turnId: string): TurnTally {
  let tally = tallies.get(turnId)
  if (tally === undefined) {
    tally = { requests: 0, tokens: NO_TOKENS, agentRuns: 0, agentTokens: 0 }
    tallies.set(turnId, tally)
  }
  return tally
}

// The compact hook runs before the compacted transcript is installed: until
// then the window still reports the last response from before it, and the
// breakdown's Messages row is reconciled to that, so it reads the old size.
// Once installed, the window has no response yet and context.tokens is absent.
async function measureCompacted($: EngineInterface, before: number | null, attempt: number): Promise<void> {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const tokens = usage.context.breakdown?.totalTokens
  if (usage.context.tokens !== undefined || tokens === undefined) {
    if (attempt < COMPACT_POLL_ATTEMPTS) {
      $.clock.after(COMPACT_POLL_MS, () => void measureCompacted($, before, attempt + 1))
    } else {
      $.ui.log(`сжатие: ${before === null ? '' : `${formatTokens(before)} → `}размер покажет первый ответ`)
    }
    return
  }
  const window = usage.context.window
  const fill: ContextFill = { tokens, window, percent: Math.round((tokens / window) * 100), isEstimate: true }
  await update($, contextFill, () => fill)
  $.ui.log(`сжатие: ${before === null ? '' : `${formatTokens(before)} → `}≈${formatTokens(tokens)}`)
}

/** What follows any main-thread compaction: the countdown restarts with the next request. */
async function afterCompact($: EngineInterface, before: number | null, usage: Tokens | null): Promise<void> {
  isCompactHandled = true
  const at = await $.clock.now()
  await update($, compactedAt, () => at)
  await update($, last, () => null)
  await recordDay($, d => ({ ...d, compactions: d.compactions + 1, service: usage === null ? d.service : addTokens(d.service, usage) }))
  $.clock.after(COMPACT_POLL_MS, () => void measureCompacted($, before, 1))
}

/**
 * A message over an expired cache writes the whole context again at twice the
 * input price: asks first, offering to compact before it goes out. Resolves
 * the refusal to answer with, or null to send the message.
 */
async function askOverExpired(
  $: EngineInterface,
  e: PromptSubmitInput,
  settings: Settings,
  minTokens: number,
): Promise<{ drop: string } | null> {
  if (minTokens === 0 || e.command !== undefined || e.isMeta === true) return null
  if (e.turnId !== undefined || e.origin.kind !== 'composer' || isTurnRunning) return null
  const hit = await read($, last)
  const fill = await read($, contextFill)
  if (hit === null || fill === null || fill.tokens < minTokens) return null
  const expiredFor = (await $.clock.now()) - hit.at - settings.ttlMs
  if (expiredFor < 0) return null

  const question =
    `Кэш истёк ${Math.floor(expiredFor / 60_000)} мин назад: сообщение заново запишет ` +
    `~${formatTokens(fill.tokens)} контекста (≈${formatTokens(fill.tokens * 2)} вх.). Что делаем?`
  const answer = await $.ui
    .ask(question, { header: 'Кэш истёк', options: [SEND, COMPACT_AND_SEND, CANCEL] })
    .catch(() => CANCEL)
  if (answer === SEND) return null

  if (answer === COMPACT_AND_SEND) {
    isCompactHandled = false
    const compacted = await $.session.compact().catch((error: unknown) => ({ skip: String(error) }))
    if (compacted.skip === undefined) {
      if (!isCompactHandled) {
        await afterCompact($, fill.tokens, compacted.usage === undefined ? null : usageTokens(compacted.usage))
      }
      return null
    }
    restoreDraft($, e.text)
    return { drop: `Сжать не вышло (${compacted.skip}), сообщение не отправлено и возвращено в поле ввода.` }
  }
  restoreDraft($, e.text)
  return { drop: 'Сообщение не отправлено и возвращено в поле ввода.' }
}

/** Puts a message that was not sent back into the prompt box, once the box is free again. */
function restoreDraft($: EngineInterface, text: string): void {
  $.clock.after(200, () => void $.prompt.fill({ text }))
}

/** Adds to today's figures of this session and writes them to the store, which outlives the session. */
async function recordDay($: EngineInterface, change: (d: DayStats) => DayStats): Promise<void> {
  if (storeKey === '') return
  const today = dayKey(await $.clock.now(), await read($, tzOffset))
  const days = await update($, ownDays, all => ({ ...all, [today]: change(all[today] ?? NO_DAY) }))
  await $.store.set(storeKey, days).catch(() => undefined)
}

/** Every other session's days from the store, summed; keys whose last day is past KEEP_DAYS are dropped. */
async function loadOtherDays($: EngineInterface): Promise<Record<string, DayStats>> {
  const oldest = dayKey((await $.clock.now()) - KEEP_DAYS * 86_400_000, await read($, tzOffset))
  const maps: Record<string, DayStats>[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(STORE_PREFIX) || key === storeKey) continue
    const value = await $.store.get(key)
    const days = typeof value === 'object' && value !== null ? (value as Record<string, DayStats>) : {}
    const keys = Object.keys(days)
    if (keys.length === 0 || keys.every(k => k < oldest)) {
      await $.store.delete(key)
      continue
    }
    maps.push(days)
  }
  return mergeDays(maps)
}

function usageTokens(u: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; output_tokens: number }): Tokens {
  return { input: u.input_tokens, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, output: u.output_tokens }
}

async function tick($: EngineInterface, settings: Settings): Promise<void> {
  const now = await $.clock.now()
  await update($, clockNow, () => now)

  const hit = await read($, last)
  if (hit === null || isTurnRunning || isKeepaliveRunning) return

  const left = hit.at + settings.ttlMs - now
  if (left <= 0) return
  const credits = await read($, autoCredits)

  if (settings.autoMs > 0 && credits > 0 && left <= settings.autoMs) {
    await update($, autoCredits, () => 0)
    isKeepaliveRunning = true
    try {
      const outcome = await keepalive($, settings)
      const text = `Автопродление: ${outcome.text} Следующее — после вашего сообщения.`
      $.ui.log(text)
      $.ui.toast(text, { timeoutMs: 15_000 })
    } finally {
      isKeepaliveRunning = false
    }
    return
  }

  if (settings.warnMs <= 0 || left > settings.warnMs || (await read($, warnedFor)) === hit.at) return

  await update($, warnedFor, () => hit.at)
  const fill = await read($, contextFill)
  const resend = fill === null ? '' : `: следующий запрос заново запишет ~${formatTokens(fill.tokens)}`
  const next =
    settings.autoMs > 0 && credits > 0
      ? `за ${Math.ceil(settings.autoMs / 60_000)} мин до конца продлю сам (1 раз)`
      : '/keepalive продлит его'
  const text = `Кэш промпта истекает через ${Math.ceil(left / 60_000)} мин${resend}. ${next}`
  $.ui.toast(text, { timeoutMs: 15_000 })
  await $.ui.notify(text, { title: 'cache-meter' })
}

async function keepalive($: EngineInterface, settings: Settings): Promise<KeepaliveOutcome> {
  const prev = await read($, last)
  const fill = await read($, contextFill)
  const sentAt = await $.clock.now()
  const reply = await $.model.fork({ prompt: KEEPALIVE_PROMPT })

  // Only the nothing-to-fork arm carries no usage: no request was made.
  if (!('usage' in reply)) {
    return {
      isRefreshed: false,
      text: 'Продлевать пока нечего: после запуска, возобновления сессии или /clear продление работает с первого ответа модели.',
    }
  }

  const u = reply.usage
  await recordDay($, d => ({ ...d, service: addTokens(d.service, usageTokens(u)) }))
  const prompt = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  const hitPercent = prompt === 0 ? 0 : Math.round((u.cache_read_input_tokens / prompt) * 100)
  const failure = reply.isAnswered ? '' : ` (запрос завершился: ${reply.reason})`
  const counts = `прочитано ${formatTokens(u.cache_read_input_tokens)}, записано ${formatTokens(u.cache_creation_input_tokens)}, вывод ${formatTokens(u.output_tokens)}`

  if (hitPercent < 50) {
    return {
      isRefreshed: false,
      text: `Кэш уже не жил: hit ${hitPercent}%, ${counts}${failure}. Следующий настоящий запрос всё равно запишет префикс заново.`,
    }
  }

  const hit: CacheHit = {
    at: sentAt,
    hitPercent,
    model: prev?.model ?? '',
    effort: prev?.effort,
  }
  await update($, last, () => hit)
  const until = formatTime(sentAt + settings.ttlMs, await read($, tzOffset))
  const size = fill === null ? '' : ` (~${formatTokens(fill.tokens)})`
  return { isRefreshed: true, text: `Кэш${size} продлён до ${until}: hit ${hitPercent}%, ${counts}${failure}.` }
}

export const register: Register = (on, options) => {
  const ttlMs = options.cacheTtl === '5m' ? 5 * 60_000 : 60 * 60_000
  const warnMinutes = typeof options.warnMinutes === 'number' ? options.warnMinutes : 5
  const settings: Settings = {
    ttlMs,
    ttlLabel: options.cacheTtl === '5m' ? '5m' : '1h',
    // Never warn earlier than a fifth of the TTL in: a 5m cache warns at 1 minute left.
    warnMs: Math.min(warnMinutes * 60_000, ttlMs / 5),
    // A 5m cache auto-refreshes at 30 seconds left at the latest.
    autoMs:
      options.autoKeepalive === false
        ? 0
        : Math.min((typeof options.autoKeepaliveMinutes === 'number' ? options.autoKeepaliveMinutes : 2) * 60_000, ttlMs / 10),
  }
  const bigResultTokens = thousands(options.bigResultK, 15)
  const bigResultsOff = options.bigResultK === 0
  const repeatReads = typeof options.repeatReads === 'number' ? options.repeatReads : 3
  // A request over an expired cache this big asks first; 0 never asks.
  const confirmExpiredTokens = options.confirmExpiredK === 0 ? 0 : thousands(options.confirmExpiredK, 100)
  const thresholds: ContextThresholds = {
    yellow: thousands(options.ctxYellowK, 200),
    orange: thousands(options.ctxOrangeK, 300),
    red: thousands(options.ctxRedK, 400),
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    $.ui.status(undefined)
    await $.command.register({
      name: 'cache-meter',
      description: 'Pane with context growth, answer costs, cache losses and subagents',
    })
    await $.command.register({
      name: 'cache-stats',
      description: 'Pane with token use by day and week, over every session',
    })
    await $.command.register({
      name: 'keepalive',
      description: 'Refresh the prompt cache TTL with one cheap request over this conversation',
    })

    const usage = await $.session.usage()
    const fill = toFill(usage.context)
    await update($, contextFill, () => fill)
    await update($, limits, () => toLimits(usage.rateLimits))

    const date = await $.process.run(['date', '+%z']).catch(() => null)
    const offset = date === null ? 0 : parseTzOffset(date.stdout)
    await update($, tzOffset, () => offset)

    storeKey = `${STORE_PREFIX}${await $.clock.now()}-${Math.random().toString(36).slice(2, 8)}`
    await update($, ownDays, () => ({}))

    await tick($, settings)
    $.clock.every(1000, () => void tick($, settings))
    return started
  })

  on('command.run', { command: 'cache-meter' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Cache meter' })
    return { text: 'Панель cache-meter открыта.' }
  })

  on('command.run', { command: 'cache-stats' }, async $ => {
    const others = await loadOtherDays($)
    await update($, otherDays, () => others)
    await $.ui.open({ id: STATS_PANE, title: 'Cache stats' })
    return { text: 'Панель статистики по дням открыта.' }
  })

  on('command.run', { command: 'keepalive' }, async $ => {
    if (isKeepaliveRunning) return { text: 'Продление уже идёт.' }
    isKeepaliveRunning = true
    try {
      return { text: (await keepalive($, settings)).text }
    } finally {
      isKeepaliveRunning = false
    }
  })

  // Each message the person types allows one more auto keepalive.
  on('prompt.submit', async ($, e, next) => {
    const refused = await askOverExpired($, e, settings, confirmExpiredTokens)
    if (refused !== null) return refused
    const result = await next(e)
    if (result.drop === undefined && e.isMeta !== true && !OWN_COMMANDS.includes(e.command?.name ?? '')) {
      await update($, autoCredits, () => 1)
    }
    return result
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && result.text !== undefined) {
      const group = toolGroup(e.tool)
      const tokens = estimateTokens(result.text)
      await update($, toolUsage, usage => {
        const was: ToolUsage = usage[group] ?? { calls: 0, tokens: 0 }
        return { ...usage, [group]: { calls: was.calls + 1, tokens: was.tokens + tokens } }
      })

      const input = e as unknown as Readonly<Record<string, unknown>>
      const big: BigResult = { at: await $.clock.now(), label: callLabel(e.tool, input), tokens }
      await update($, bigResults, list => keepBiggest(list, big, 10))
      if (!bigResultsOff && tokens >= bigResultTokens) {
        $.ui.toast(`${big.label} добавил в контекст ~${formatTokens(tokens)}`, { timeoutMs: 10_000 })
      }

      const path = e.tool === 'Read' && typeof input.file_path === 'string' ? input.file_path : null
      if (path !== null) {
        const reads = await read($, fileReads)
        const was: FileReads = reads[path] ?? { reads: 0, tokens: 0 }
        const now: FileReads = { reads: was.reads + 1, tokens: was.tokens + tokens }
        await update($, fileReads, all => ({ ...all, [path]: now }))
        if (repeatReads > 0 && now.reads === repeatReads) {
          $.ui.toast(
            `${baseName(path)} прочитан ${now.reads} ${plural(now.reads, 'раз', 'раза', 'раз')}, ~${formatTokens(now.tokens)} в контексте`,
            { timeoutMs: 10_000 },
          )
        }
      }
    }
    return result
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    // Right after a compaction the window has no response yet: keep the estimate.
    const fill = toFill(e.context)
    if (fill !== null) await update($, contextFill, () => fill)
    await update($, limits, () => toLimits(e.rateLimits))
    return next(e)
  })

  // No turn ends at a compaction, so no session.measure follows it: the band
  // would keep the old size until the next answer. Count the new size locally,
  // and drop the cache countdown, since the compacted prefix is not cached yet.
  on('session.compact', async ($, e, next) => {
    const before = (await read($, contextFill))?.tokens ?? null
    const result = await next(e)
    if (e.agentId !== undefined || e.trigger === 'precompute' || result.messages === undefined) return result
    await afterCompact($, before, result.usage === undefined ? null : usageTokens(result.usage))
    return result
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      currentTurnId = e.turnId
      isTurnRunning = true
      tallyOf(e.turnId)
    } else {
      const id = e.agentId
      const known = (await read($, agentLog)).find(a => a.id === id)
      if (known !== undefined) {
        // Another run of the same agent's loop (it was messaged again).
        await update($, agentLog, list => list.map(a => (a.id === id ? { ...a, isRunning: true } : a)))
      } else {
        const info = (await $.agent.list()).find(a => a.id === id)
        const record: AgentRecord = {
          id,
          type: info?.type ?? 'agent',
          description: info?.description ?? '',
          isRunning: true,
          startedAt: await $.clock.now(),
          tokens: 0,
        }
        await update($, agentLog, list => [...list, record].slice(-50))
        await update($, agentTotals, t => ({ ...t, runs: t.runs + 1 }))
        if (currentTurnId !== null) tallyOf(currentTurnId).agentRuns += 1
      }
    }
    return next(e)
  })

  // The cache entry's TTL restarts when a request reads or writes it, so the
  // moment the main-thread request is sent is what the countdown runs from.
  on('turn.step', async function* ($, e, next) {
    const sentAt = await $.clock.now()
    const result = yield* next(e)
    if (result.usage === null) return result

    const u = result.usage
    const tokens = usageTokens(u)

    if (e.agentId !== undefined) {
      const spent = totalTokens(tokens)
      await update($, agentLog, list => list.map(a => (a.id === e.agentId ? { ...a, tokens: a.tokens + spent } : a)))
      await update($, agentTotals, t => ({ ...t, tokens: t.tokens + spent }))
      if (currentTurnId !== null) tallyOf(currentTurnId).agentTokens += spent
      await recordDay($, d => ({ ...d, agents: addTokens(d.agents, tokens) }))
      return result
    }

    const tally = tallyOf(e.turnId)
    tally.requests += 1
    tally.tokens = addTokens(tally.tokens, tokens)

    const prompt = tokens.input + tokens.read + tokens.write
    const hitPercent = prompt === 0 ? 0 : Math.round((tokens.read / prompt) * 100)
    const hit: CacheHit = { at: sentAt, hitPercent, model: u.model, effort: e.effort }

    const prev = await read($, last)
    const compacted = await read($, compactedAt)
    const compactedSince = compacted !== null && prev !== null && compacted >= prev.at
    const reason = cacheLossReason(prev, hit, prompt, compactedSince, settings.ttlMs)
    if (reason !== null) {
      const loss: CacheLoss = { at: sentAt, hitPercent, written: tokens.write, reason }
      await update($, losses, list => [...list, loss].slice(-50))
      $.ui.toast(`Кэш потерян (hit ${hitPercent}%, записано ~${formatTokens(tokens.write)}): ${reason}`, {
        timeoutMs: 15_000,
      })
    }

    await update($, last, () => hit)
    await recordDay($, d => ({
      ...d,
      requests: d.requests + 1,
      main: addTokens(d.main, tokens),
      losses: d.losses + (reason === null ? 0 : 1),
      lostWritten: d.lostWritten + (reason === null ? 0 : tokens.write),
    }))
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId !== undefined) {
      await update($, agentLog, list => list.map(a => (a.id === e.agentId ? { ...a, isRunning: false } : a)))
      return result
    }

    isTurnRunning = false
    const tally = tallies.get(e.turnId)
    tallies.delete(e.turnId)
    if (currentTurnId === e.turnId) currentTurnId = null
    if (tally === undefined || tally.requests === 0) return result

    const fill = await read($, contextFill)
    const turn: TurnRecord = {
      at: await $.clock.now(),
      requests: tally.requests,
      tokens: tally.tokens,
      agentRuns: tally.agentRuns,
      agentTokens: tally.agentTokens,
      contextTokens: fill?.tokens ?? null,
    }
    await update($, turns, list => [...list, turn].slice(-100))
    await recordDay($, d => ({ ...d, answers: d.answers + 1 }))
    $.ui.log(turnSummary(turn))
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const fill = await read($, contextFill)
    const hit = await read($, last)
    const now = await read($, clockNow)
    const rateLimits = await read($, limits)
    const running = (await read($, agentLog)).filter(a => a.isRunning)
    const tz = await read($, tzOffset)
    const label = `кэш ${settings.ttlLabel}: `

    const ctx =
      fill === null ? (
        <Text dimColor>ctx —</Text>
      ) : (
        <Text>
          <Text dimColor>ctx </Text>
          <Text key="bar" color={contextColor(fill.tokens, thresholds)}>
            {formatBar(fill.tokens / fill.window)}
          </Text>
          {` ${fill.isEstimate === true ? '≈' : ''}${formatTokens(fill.tokens)}/${formatTokens(fill.window)} (${fill.percent}%)`}
        </Text>
      )

    let cache
    if (hit === null) {
      const after = fill?.isEstimate === true ? ' (после сжатия запишется с первым запросом)' : ''
      cache = <Text dimColor>{`${label}—${after}`}</Text>
    } else {
      const left = hit.at + settings.ttlMs - now
      const color = cacheColor(left, settings.ttlMs)
      cache =
        left > 0 ? (
          <Text>
            <Text dimColor>{label}</Text>
            <Text key="cache" color={color}>{formatClock(left)}</Text>
            <Text dimColor>{` · hit ${hit.hitPercent}%`}</Text>
          </Text>
        ) : (
          <Text>
            <Text dimColor>{label}</Text>
            <Text key="cache" color={color}>
              {`истёк ${Math.floor(-left / 60_000)} мин назад`}
            </Text>
            {fill === null ? '' : `, следующий запрос заново запишет ~${formatTokens(fill.tokens)}`}
          </Text>
        )
    }

    const limitRuns = rateLimits.map(r => {
      const reset = r.resetsAt === undefined ? null : formatReset(r.resetsAt, now, tz)
      return (
        <Text key={`limit-${r.kind}`}>
          <Text dimColor>{` · ${limitLabel(r.kind)} `}</Text>
          <Text color={limitColor(r.percentUsed)}>{`${r.percentUsed}%`}</Text>
          {reset === null ? '' : <Text dimColor>{` до ${reset}`}</Text>}
        </Text>
      )
    })

    const agentRun =
      running.length === 0 ? (
        ''
      ) : (
        <Text key="agents">
          <Text dimColor>{' · агенты '}</Text>
          {`${running.length} (${formatTokens(running.reduce((s, a) => s + a.tokens, 0))})`}
        </Text>
      )

    return (
      <Box>
        <Text>
          {ctx}
          <Text dimColor> · </Text>
          {cache}
          {limitRuns}
          {agentRun}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const history = await read($, turns)
    const lost = await read($, losses)
    const totals = await read($, agentTotals)
    const agentRows = [...(await read($, agentLog))]
      .sort((a, b) => Number(b.isRunning) - Number(a.isRunning) || b.startedAt - a.startedAt)
      .slice(0, 15)
    const tz = await read($, tzOffset)
    const tools = Object.entries(await read($, toolUsage)).sort((a, b) => b[1].tokens - a[1].tokens)
    const toolTotal = tools.reduce((sum, [, u]) => sum + u.tokens, 0)
    const biggest = await read($, bigResults)
    const repeated = Object.entries(await read($, fileReads))
      .filter(([, f]) => f.reads >= 2)
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .slice(0, 10)

    const sizes = history.map(t => t.contextTokens ?? 0)
    const first = sizes.find(s => s > 0)
    const lastSize = sizes[sizes.length - 1]
    const recent = history.slice(-10).reverse()
    const costly = [...history].sort((a, b) => inputEquivalent(b.tokens) - inputEquivalent(a.tokens)).slice(0, 5)
    const session = history.reduce((sum, t) => addTokens(sum, t.tokens), NO_TOKENS)

    const row = (t: TurnRecord, key: string) => (
      <Text key={key}>
        <Text dimColor>{`${formatTime(t.at, tz)}  `}</Text>
        {`≈${formatTokens(inputEquivalent(t.tokens))} вх. · ${t.requests} запр. · чтение ${formatTokens(t.tokens.read)} / запись ${formatTokens(t.tokens.write)} · вывод ${formatTokens(t.tokens.output)}`}
        {t.agentRuns === 0 ? '' : <Text dimColor>{` · агенты ${t.agentRuns} (${formatTokens(t.agentTokens)})`}</Text>}
      </Text>
    )

    return (
      <Box flexDirection="column">
        <Text weight="bold">Контекст по ответам</Text>
        {sizes.length === 0 ? (
          <Text dimColor>Ещё нет ответов.</Text>
        ) : (
          <Text>
            <Text color={contextColor(lastSize ?? 0, thresholds)}>{sparkline(sizes.slice(-60))}</Text>
            {`  ${formatTokens(first ?? 0)} → ${formatTokens(lastSize ?? 0)}`}
          </Text>
        )}
        <Text> </Text>

        <Text weight="bold">За сессию</Text>
        <Text>
          {`${history.length} ответов · ≈${formatTokens(inputEquivalent(session))} вх. · чтение ${formatTokens(session.read)} / запись ${formatTokens(session.write)} · вывод ${formatTokens(session.output)}`}
        </Text>
        <Text dimColor>
          {`агенты: ${totals.runs} запусков, ${formatTokens(totals.tokens)} токенов · «вх.» — цена в токенах обычного ввода (чтение ×0.05, запись ×2, вывод ×5)`}
        </Text>
        <Text> </Text>

        <Text weight="bold">Агенты</Text>
        {agentRows.length === 0 ? (
          <Text dimColor>Не запускались.</Text>
        ) : (
          agentRows.map((a, i) => (
            <Text key={`agent-${i}`}>
              <Text dimColor>{`${formatTime(a.startedAt, tz)}  `}</Text>
              {`${clip(a.type, 16).padEnd(16)} ${clip(a.description || '—', 40).padEnd(40)} `}
              <Text color={a.isRunning ? '#e5c000' : undefined} dimColor={!a.isRunning}>
                {a.isRunning ? 'идёт ' : 'готов'}
              </Text>
              {`  ≈${formatTokens(a.tokens).padStart(5)}`}
            </Text>
          ))
        )}
        <Text> </Text>

        <Text weight="bold">Что принесли в контекст инструменты</Text>
        {tools.length === 0 ? (
          <Text dimColor>—</Text>
        ) : (
          tools.slice(0, 10).map(([group, u], i) => (
            <Text key={`tool-${i}`}>
              {`${group.padEnd(16)} ≈${formatTokens(u.tokens).padStart(5)}`}
              <Text dimColor>{`  ${Math.round((u.tokens / Math.max(1, toolTotal)) * 100)}% · ${u.calls} вызовов`}</Text>
            </Text>
          ))
        )}
        <Text dimColor>оценка по длине результатов, ~4 символа на токен; без субагентов</Text>
        <Text> </Text>

        <Text weight="bold">Самые большие результаты</Text>
        {biggest.length === 0 ? (
          <Text dimColor>—</Text>
        ) : (
          biggest.map((b, i) => (
            <Text key={`big-${i}`}>
              <Text dimColor>{`${formatTime(b.at, tz)}  `}</Text>
              {`≈${formatTokens(b.tokens).padStart(5)}  ${b.label}`}
            </Text>
          ))
        )}
        <Text> </Text>

        <Text weight="bold">Повторно прочитанные файлы</Text>
        {repeated.length === 0 ? (
          <Text dimColor>Не было.</Text>
        ) : (
          repeated.map(([path, f], i) => (
            <Text key={`reread-${i}`}>
              {`${baseName(path)}  ${f.reads}×  ≈${formatTokens(f.tokens)}`}
              <Text dimColor>{`  ${path}`}</Text>
            </Text>
          ))
        )}
        <Text> </Text>

        <Text weight="bold">Самые дорогие ответы</Text>
        {costly.length === 0 ? <Text dimColor>—</Text> : costly.map((t, i) => row(t, `costly-${i}`))}
        <Text> </Text>

        <Text weight="bold">Последние ответы</Text>
        {recent.length === 0 ? <Text dimColor>—</Text> : recent.map((t, i) => row(t, `recent-${i}`))}
        <Text> </Text>

        <Text weight="bold">Потери кэша</Text>
        {lost.length === 0 ? (
          <Text dimColor>Не было.</Text>
        ) : (
          [...lost].reverse().slice(0, 10).map((l, i) => (
            <Text key={`loss-${i}`}>
              <Text dimColor>{`${formatTime(l.at, tz)}  `}</Text>
              <Text color="#f44336">{`hit ${l.hitPercent}%, записано ${formatTokens(l.written)}`}</Text>
              {`: ${l.reason}`}
            </Text>
          ))
        )}
      </Box>
    )
  })
  on('ui.render', { component: 'Pane', requestId: STATS_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const days = mergeDays([await read($, otherDays), await read($, ownDays)])
    const today = dayKey(await read($, clockNow), await read($, tzOffset))
    const recent = lastDays(today, 14)
    const yesterday = recent[recent.length - 2] ?? today
    const periods: [string, DayStats][] = [
      ['Сегодня', sumDays(days, [today])],
      ['Вчера', sumDays(days, [yesterday])],
      ['7 дней', sumDays(days, lastDays(today, 7))],
      ['30 дней', sumDays(days, lastDays(today, 30))],
    ]
    const perDay = recent.map(key => ({ key, cost: inputEquivalent(dayTokens(days[key] ?? NO_DAY)), day: days[key] ?? NO_DAY }))
    const top = Math.max(1, ...perDay.map(d => d.cost))

    return (
      <Box flexDirection="column">
        <Text weight="bold">По периодам</Text>
        {periods.map(([label, d], i) => {
          const all = dayTokens(d)
          return (
            <Box key={`period-${i}`} flexDirection="column">
              <Text>
                <Text weight="bold">{label.padEnd(9)}</Text>
                {`≈${formatTokens(inputEquivalent(all))} вх. · ${d.answers} ${plural(d.answers, 'ответ', 'ответа', 'ответов')}, ${d.requests} запр. · hit ${cacheHitPercent(all)}%`}
                {` · чтение ${formatTokens(all.read)} / запись ${formatTokens(all.write)} · ввод ${formatTokens(all.input)} · вывод ${formatTokens(all.output)}`}
              </Text>
              <Text dimColor>
                {`${''.padEnd(9)}основной ≈${formatTokens(inputEquivalent(d.main))} · агенты ≈${formatTokens(inputEquivalent(d.agents))} · продления и сжатия ≈${formatTokens(inputEquivalent(d.service))}`}
                {` · потери кэша ${d.losses}${d.losses === 0 ? '' : ` (записано ${formatTokens(d.lostWritten)})`} · сжатий ${d.compactions} · кэш сэкономил ≈${formatTokens(Math.max(0, cacheSavings(all)))}`}
              </Text>
            </Box>
          )
        })}
        <Text> </Text>

        <Text weight="bold">По дням</Text>
        {perDay.map((d, i) => (
          <Text key={`day-${i}`}>
            <Text dimColor={d.key !== today}>{`${dayLabel(d.key)}  `}</Text>
            <Text color="#4caf50">{formatBar(d.cost / top)}</Text>
            {d.cost === 0 ? '      —' : ` ≈${formatTokens(d.cost).padStart(5)} вх.`}
            <Text dimColor>
              {d.day.answers === 0
                ? ''
                : `  ${d.day.answers} отв. · hit ${cacheHitPercent(dayTokens(d.day))}%${d.day.losses === 0 ? '' : ` · потерь ${d.day.losses}`}`}
            </Text>
          </Text>
        ))}
        <Text> </Text>
        <Text dimColor>
          все сессии, учёт с версии 0.7.0 · «вх.» — цена в токенах обычного ввода (чтение ×0.05, запись ×2, вывод ×5) · другие сессии прочитаны при открытии, текущая обновляется сама
        </Text>
      </Box>
    )
  })
}
