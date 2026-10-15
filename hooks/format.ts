import type { AgentTypeDay, BigResult, CacheHit, DayStats, ProjectDays, Tokens, TurnRecord } from '../types'

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

/** `date +%z` output (`+0300`) as minutes east of UTC; null when unreadable. */
export function parseTzOffset(text: string): number | null {
  const m = /^([+-])(\d{2})(\d{2})/.exec(text.trim())
  if (m === null) return null
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

export function clip(text: string, max: number): string {
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

export const NO_DAY: DayStats = {
  answers: 0,
  requests: 0,
  main: NO_TOKENS,
  agents: NO_TOKENS,
  service: NO_TOKENS,
  losses: 0,
  lostWritten: 0,
  compactions: 0,
}

function mergeTokenMaps(
  a: Readonly<Record<string, Tokens>> | undefined,
  b: Readonly<Record<string, Tokens>> | undefined,
): Record<string, Tokens> | undefined {
  if (a === undefined || b === undefined) return a ?? b
  const merged: Record<string, Tokens> = { ...a }
  for (const [key, tokens] of Object.entries(b)) merged[key] = addTokens(merged[key] ?? NO_TOKENS, tokens)
  return merged
}

function mergeAgentTypes(
  a: Readonly<Record<string, AgentTypeDay>> | undefined,
  b: Readonly<Record<string, AgentTypeDay>> | undefined,
): Record<string, AgentTypeDay> | undefined {
  if (a === undefined || b === undefined) return a ?? b
  const merged: Record<string, AgentTypeDay> = { ...a }
  for (const [key, day] of Object.entries(b)) {
    const was = merged[key] ?? { runs: 0, tokens: NO_TOKENS }
    merged[key] = { runs: was.runs + day.runs, tokens: addTokens(was.tokens, day.tokens) }
  }
  return merged
}

function mergeCounts(
  a: Readonly<Record<string, number>> | undefined,
  b: Readonly<Record<string, number>> | undefined,
): Record<string, number> | undefined {
  if (a === undefined || b === undefined) return a ?? b
  const merged: Record<string, number> = { ...a }
  for (const [key, n] of Object.entries(b)) merged[key] = (merged[key] ?? 0) + n
  return merged
}

export function addDay(a: DayStats, b: DayStats): DayStats {
  const models = mergeTokenMaps(a.models, b.models)
  const agentTypes = mergeAgentTypes(a.agentTypes, b.agentTypes)
  const mcpCalls = mergeCounts(a.mcpCalls, b.mcpCalls)
  const skillCalls = mergeCounts(a.skillCalls, b.skillCalls)
  return {
    ...(models === undefined ? {} : { models }),
    ...(agentTypes === undefined ? {} : { agentTypes }),
    ...(mcpCalls === undefined ? {} : { mcpCalls }),
    ...(skillCalls === undefined ? {} : { skillCalls }),
    answers: a.answers + b.answers,
    requests: a.requests + b.requests,
    main: addTokens(a.main, b.main),
    agents: addTokens(a.agents, b.agents),
    service: addTokens(a.service, b.service),
    losses: a.losses + b.losses,
    lostWritten: a.lostWritten + b.lostWritten,
    compactions: a.compactions + b.compactions,
  }
}

/** A day with `tokens` added to what `model` answered; an unknown model ('') is left out. */
export function withModel(d: DayStats, model: string, tokens: Tokens): DayStats {
  if (model === '') return d
  return { ...d, models: mergeTokenMaps(d.models ?? {}, { [model]: tokens }) }
}

/** A day with `runs` more runs and `tokens` more spent by subagents of `type`. */
export function withAgentType(d: DayStats, type: string, runs: number, tokens: Tokens): DayStats {
  return { ...d, agentTypes: mergeAgentTypes(d.agentTypes ?? {}, { [type]: { runs, tokens } }) }
}

/** The wire-name prefix of an MCP tool (`mcp__phpstorm__search` → `mcp__phpstorm__`), or null for any other tool. */
export function mcpPrefix(tool: string): string | null {
  const m = /^mcp__.+?__/.exec(tool)
  return m === null ? null : m[0]
}

/** A day with one more MCP call under `prefix`. */
export function withMcpCall(d: DayStats, prefix: string): DayStats {
  return { ...d, mcpCalls: mergeCounts(d.mcpCalls ?? {}, { [prefix]: 1 }) }
}

/** A day with one more run of `skill`. */
export function withSkillCall(d: DayStats, skill: string): DayStats {
  return { ...d, skillCalls: mergeCounts(d.skillCalls ?? {}, { [skill]: 1 }) }
}

/** How often each key of `pick` was counted over `keys`, and the latest of those days it was. */
export function usageOver(
  days: Readonly<Record<string, DayStats>>,
  keys: readonly string[],
  pick: (d: DayStats) => Readonly<Record<string, number>> | undefined,
): Map<string, { calls: number; lastDay: string }> {
  const usage = new Map<string, { calls: number; lastDay: string }>()
  for (const key of keys) {
    for (const [name, n] of Object.entries(pick(days[key] ?? NO_DAY) ?? {})) {
      if (n === 0) continue
      const was = usage.get(name)
      usage.set(name, { calls: (was?.calls ?? 0) + n, lastDay: was === undefined || key > was.lastDay ? key : was.lastDay })
    }
  }
  return usage
}

/** `claude-opus-5-5` → `Opus 5.5`, `claude-haiku-4-5-20251001` → `Haiku 4.5`; anything else as it is. */
export function modelLabel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[[^\]]*\])?$/.exec(id)
  if (m === null) return id
  const family = m[1] ?? ''
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${m[2]}${m[3] === undefined ? '' : `.${m[3]}`}`
}

/** A period's tokens by model, ids of one model joined under its label, costliest first. */
export function modelRows(d: DayStats): { label: string; tokens: Tokens }[] {
  const byLabel = new Map<string, Tokens>()
  for (const [id, tokens] of Object.entries(d.models ?? {})) {
    const label = modelLabel(id)
    byLabel.set(label, addTokens(byLabel.get(label) ?? NO_TOKENS, tokens))
  }
  return [...byLabel]
    .map(([label, tokens]) => ({ label, tokens }))
    .sort((a, b) => inputEquivalent(b.tokens) - inputEquivalent(a.tokens))
}

/** A period's subagent types, costliest first. */
export function agentTypeRows(d: DayStats): ({ type: string } & AgentTypeDay)[] {
  return Object.entries(d.agentTypes ?? {})
    .map(([type, day]) => ({ type, ...day }))
    .sort((a, b) => inputEquivalent(b.tokens) - inputEquivalent(a.tokens))
}

/** Everything a day's requests read, wrote and produced, main thread, subagents and service requests together. */
export function dayTokens(d: DayStats): Tokens {
  return addTokens(addTokens(d.main, d.agents), d.service)
}

/** The local calendar date of `ms`: `2026-10-14`. */
export function dayKey(ms: number, tzOffsetMinutes: number): string {
  return local(ms, tzOffsetMinutes).toISOString().slice(0, 10)
}

/** `пт 10.10` for a `2026-10-10` day key. */
export function dayLabel(key: string): string {
  const d = new Date(`${key}T00:00:00Z`)
  return `${WEEKDAYS[d.getUTCDay()]} ${key.slice(8, 10)}.${key.slice(5, 7)}`
}

/** The day keys from `days` days before `today` up to `today`, oldest first. */
export function lastDays(today: string, days: number): string[] {
  const end = Date.parse(`${today}T00:00:00Z`)
  return Array.from({ length: days }, (_, i) => new Date(end - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10))
}

/** Several sessions' day maps summed into one. */
export function mergeDays(maps: readonly Readonly<Record<string, DayStats>>[]): Record<string, DayStats> {
  const merged: Record<string, DayStats> = {}
  for (const map of maps) {
    for (const [key, day] of Object.entries(map)) merged[key] = addDay(merged[key] ?? NO_DAY, day)
  }
  return merged
}

/** The days of `keys` summed. */
export function sumDays(days: Readonly<Record<string, DayStats>>, keys: readonly string[]): DayStats {
  return keys.reduce((sum, key) => addDay(sum, days[key] ?? NO_DAY), NO_DAY)
}

/** Share of the prompt read from the cache, 0 to 100. */
export function cacheHitPercent(t: Tokens): number {
  const prompt = t.input + t.read + t.write
  return prompt === 0 ? 0 : Math.round((t.read / prompt) * 100)
}

/**
 * What the cache saved against sending every prompt uncached, in input tokens:
 * reads cost less than input, writes cost more.
 */
export function cacheSavings(t: Tokens): number {
  return t.read * (WEIGHT.input - WEIGHT.read) - t.write * (WEIGHT.write - WEIGHT.input)
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/

/** A session's stored value as days by project; 0.7.0 stored bare days, under no project. */
export function toProjectDays(value: unknown): ProjectDays {
  if (typeof value !== 'object' || value === null) return {}
  const entries = Object.keys(value)
  if (entries.length > 0 && entries.every(k => DAY_KEY.test(k))) return { '': value as Record<string, DayStats> }
  return value as ProjectDays
}

/** Several sessions' projects summed, project by project. */
export function mergeProjects(list: readonly ProjectDays[]): ProjectDays {
  const merged: ProjectDays = {}
  for (const projects of list) {
    for (const [project, days] of Object.entries(projects)) merged[project] = mergeDays([merged[project] ?? {}, days])
  }
  return merged
}

/** Every project's days summed into one. */
export function allDays(projects: ProjectDays): Record<string, DayStats> {
  return mergeDays(Object.values(projects))
}

/** The latest day any project of a session has. */
export function latestDay(projects: ProjectDays): string | null {
  const keys = Object.values(projects).flatMap(days => Object.keys(days))
  return keys.length === 0 ? null : keys.reduce((a, b) => (a > b ? a : b))
}

/** One cell of the context gradient: what it shows and in which colour. */
export type GradientCell = { char: string; color: string; isFilled: boolean }

const GRADIENT_CELLS = 25
const FILLED = '━'
const EMPTY = '╌'

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a)
  const [br, bg, bb] = hexToRgb(b)
  const c = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0')
  return `#${c(ar, br)}${c(ag, bg)}${c(ab, bb)}`
}

/** The colour at `tokens` on a smooth scale: green at 0, then yellow, orange and red at their thresholds. */
export function gradientColor(tokens: number, t: ContextThresholds): string {
  const stops: [number, string][] = [
    [0, GREEN],
    [t.yellow, YELLOW],
    [t.orange, ORANGE],
    [t.red, RED],
  ]
  for (let i = 1; i < stops.length; i++) {
    const [at, color] = stops[i]!
    const [from, fromColor] = stops[i - 1]!
    if (tokens <= at) return mix(fromColor, color, at === from ? 1 : (tokens - from) / (at - from))
  }
  return RED
}

/**
 * The context as a line from 0 to the red threshold: filled cells in the
 * smooth gradient, empty ones dashed in their zone's own colour, so every
 * boundary shows before the context reaches it. Past red the whole line is red.
 */
export function contextGradient(tokens: number, t: ContextThresholds, cells = GRADIENT_CELLS): GradientCell[] {
  if (tokens >= t.red) return Array.from({ length: cells }, () => ({ char: FILLED, color: RED, isFilled: true }))
  const step = t.red / cells
  return Array.from({ length: cells }, (_, i) => {
    const mid = (i + 0.5) * step
    const isFilled = tokens >= mid
    return isFilled
      ? { char: FILLED, color: gradientColor(mid, t), isFilled }
      : { char: EMPTY, color: contextColor(mid, t), isFilled }
  })
}

/** Neighbouring cells of one colour and fill joined, so a line is a few runs, not one element a cell. */
export function joinCells(cells: readonly GradientCell[]): GradientCell[] {
  const runs: GradientCell[] = []
  for (const cell of cells) {
    const prev = runs[runs.length - 1]
    if (prev !== undefined && prev.color === cell.color && prev.isFilled === cell.isFilled) {
      runs[runs.length - 1] = { ...prev, char: prev.char + cell.char }
    } else {
      runs.push({ ...cell })
    }
  }
  return runs
}
