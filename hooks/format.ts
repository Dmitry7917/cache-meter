import type { BigResult, CacheHit, Tokens, TurnRecord } from '../types'

export const GREEN = '#4caf50'
export const YELLOW = '#e5c000'
export const ORANGE = '#ff8c00'
export const RED = '#f44336'

/** Context sizes, in tokens, where the bar turns yellow, orange and red. */
export type ContextThresholds = { yellow: number; orange: number; red: number }

/** A request this big that read under this share from the cache lost it. */
const LOSS_MIN_PROMPT = 20_000
const LOSS_MAX_HIT_PERCENT = 50

const BAR_CELLS = 20
const PARTIAL = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
const LIMIT_LABELS: Record<string, string> = { five_hour: '5ч', seven_day: '7д' }
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']

/**
 * Relative price of each count against uncached input, as on Opus 5.5 with
 * the 1h TTL: cache read 0.05x, cache write 2x, output 5x.
 */
const WEIGHT = { input: 1, read: 0.05, write: 2, output: 5 }

export const NO_TOKENS: Tokens = { input: 0, read: 0, write: 0, output: 0 }

export function addTokens(a: Tokens, b: Tokens): Tokens {
  return {
    input: a.input + b.input,
    read: a.read + b.read,
    write: a.write + b.write,
    output: a.output + b.output,
  }
}

export function totalTokens(t: Tokens): number {
  return t.input + t.read + t.write + t.output
}

/** What the tokens cost in uncached-input tokens, so answers can be compared. */
export function inputEquivalent(t: Tokens): number {
  return t.input * WEIGHT.input + t.read * WEIGHT.read + t.write * WEIGHT.write + t.output * WEIGHT.output
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return `${n}`
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function formatBar(fraction: number): string {
  const eighths = Math.round(Math.min(1, Math.max(0, fraction)) * BAR_CELLS * 8)
  const full = Math.floor(eighths / 8)
  const partial = PARTIAL[eighths % 8] ?? ''
  const empty = BAR_CELLS - full - (partial === '' ? 0 : 1)
  return '█'.repeat(full) + partial + '░'.repeat(empty)
}

/** One character per value, scaled from 0 to the largest value. */
export function sparkline(values: readonly number[]): string {
  const max = Math.max(1, ...values)
  return values.map(v => SPARK[Math.min(7, Math.floor((v / max) * 7.999))] ?? '▁').join('')
}

function local(ms: number, tzOffsetMinutes: number): Date {
  return new Date(ms + tzOffsetMinutes * 60_000)
}

function hhmm(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/** Local wall-clock time of `ms`: `14:30`. */
export function formatTime(ms: number, tzOffsetMinutes: number): string {
  return hhmm(local(ms, tzOffsetMinutes))
}

/** When a limit window resets: `14:30` within a day, `пт 10:00` later on. */
export function formatReset(resetsAt: string, now: number, tzOffsetMinutes: number): string | null {
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at)) return null
  const d = local(at, tzOffsetMinutes)
  return at - now < 24 * 60 * 60_000 ? hhmm(d) : `${WEEKDAYS[d.getUTCDay()]} ${hhmm(d)}`
}

/** `date +%z` output (`+0300`) as minutes east of UTC; 0 when unreadable. */
export function parseTzOffset(text: string): number {
  const m = /^([+-])(\d{2})(\d{2})/.exec(text.trim())
  if (m === null) return 0
  const minutes = Number(m[2]) * 60 + Number(m[3])
  return m[1] === '-' ? -minutes : minutes
}

/**
 * Context size against absolute thresholds, not the share of the window:
 * quality drops long before a 1M window fills, so the window does not matter.
 */
export function contextColor(tokens: number, t: ContextThresholds): string {
  if (tokens >= t.red) return RED
  if (tokens >= t.orange) return ORANGE
  if (tokens >= t.yellow) return YELLOW
  return GREEN
}

/** Share of the TTL left: over half green, then yellow, orange under 25%, red under 10% and expired. */
export function cacheColor(leftMs: number, ttlMs: number): string {
  const share = leftMs / ttlMs
  if (share <= 0.1) return RED
  if (share <= 0.25) return ORANGE
  if (share <= 0.5) return YELLOW
  return GREEN
}

export function limitColor(percentUsed: number): string {
  if (percentUsed >= 90) return RED
  if (percentUsed >= 75) return ORANGE
  if (percentUsed >= 50) return YELLOW
  return GREEN
}

export function limitLabel(kind: string): string {
  return LIMIT_LABELS[kind] ?? kind
}

/**
 * Why a request whose cache entry should still be alive read little of it,
 * or null when it read enough (or was too small to tell).
 */
export function cacheLossReason(
  prev: CacheHit | null,
  next: CacheHit,
  promptTokens: number,
  compactedSince: boolean,
  ttlMs: number,
): string | null {
  if (prev === null || next.at - prev.at >= ttlMs) return null
  if (promptTokens < LOSS_MIN_PROMPT || next.hitPercent >= LOSS_MAX_HIT_PERCENT) return null
  if (compactedSince) return null
  if (prev.model !== next.model) return `смена модели: ${prev.model} → ${next.model}`
  if (prev.effort !== next.effort) return `смена effort: ${prev.effort ?? 'default'} → ${next.effort ?? 'default'}`

  const gapMinutes = Math.floor((next.at - prev.at) / 60_000)
  const shortTtl = gapMinutes >= 5 ? `; или TTL сейчас 5m (пауза ${gapMinutes} мин)` : ''
  return `изменилось начало промпта: CLAUDE.md, инструменты/MCP, /clear${shortTtl}`
}

/** The line logged under an answer. */
export function turnSummary(turn: TurnRecord): string {
  const t = turn.tokens
  const requests = `${turn.requests} ${plural(turn.requests, 'запрос', 'запроса', 'запросов')}`
  const agents =
    turn.agentRuns === 0 ? '' : ` · агенты ${turn.agentRuns} (${formatTokens(turn.agentTokens)})`
  return (
    `ответ: ${requests} · кэш: чтение ${formatTokens(t.read)} / запись ${formatTokens(t.write)}` +
    ` · ввод ${formatTokens(t.input)} · вывод ${formatTokens(t.output)}${agents}` +
    ` · ≈${formatTokens(inputEquivalent(t))} вх.`
  )
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

/** Rough token count of text the model reads: about four characters a token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Groups MCP tools by server (`mcp__phpstorm__search` → `MCP phpstorm`), others by name. */
export function toolGroup(tool: string): string {
  const m = /^mcp__(.+?)__/.exec(tool)
  return m === null ? tool : `MCP ${m[1]}`
}

/** The last segment of a path: `/a/b/config.php` → `config.php`. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** What a call read or ran, short enough for a toast: `Read config.php`, `Bash make test`. */
export function callLabel(tool: string, input: Readonly<Record<string, unknown>>): string {
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : null)
  const path = text('file_path') ?? text('notebook_path') ?? text('path')
  if (path !== null && (tool === 'Read' || tool === 'NotebookRead')) return `${tool} ${baseName(path)}`
  const command = text('command')
  if (command !== null) return `${tool} ${clip(command, 40)}`
  const pattern = text('pattern') ?? text('query') ?? text('url')
  if (pattern !== null) return `${tool} ${clip(pattern, 40)}`
  return tool
}

/** Keeps the `limit` biggest results, biggest first. */
export function keepBiggest(list: readonly BigResult[], next: BigResult, limit: number): BigResult[] {
  return [...list, next].sort((a, b) => b.tokens - a.tokens).slice(0, limit)
}
