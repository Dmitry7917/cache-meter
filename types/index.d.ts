export type CacheHit = {
  at: number
  hitPercent: number
  model: string
  effort?: string | number
}
/** `isEstimate`: counted locally after a compaction, until the next response reports the real size. */
export type ContextFill = { tokens: number; window: number; percent: number; isEstimate?: boolean }
export type RateLimitFill = { kind: string; percentUsed: number; resetsAt?: string }

/** Token counts summed over requests: uncached input, cache read, cache write, output. */
export type Tokens = { input: number; read: number; write: number; output: number }

/** One finished main-thread answer. */
export type TurnRecord = {
  at: number
  requests: number
  tokens: Tokens
  agentRuns: number
  agentTokens: number
  contextTokens: number | null
}

export type CacheLoss = { at: number; hitPercent: number; written: number; reason: string }

/** One subagent of this session: what it was asked, whether it runs, its tokens so far (all four counts summed). */
export type AgentRecord = {
  id: string
  type: string
  description: string
  isRunning: boolean
  startedAt: number
  tokens: number
}

export type AgentTotals = { runs: number; tokens: number }

/** What one tool (or one MCP server) put into the main context this session. */
export type ToolUsage = { calls: number; tokens: number }

/** One tool result, by what it read or ran: `Read config.php`, `Bash make test`. */
export type BigResult = { at: number; label: string; tokens: number }

/** How often one file was read into the main context, and how much it brought. */
export type FileReads = { reads: number; tokens: number }

/** One subagent type's day: how many runs it started, and what all its requests read, wrote and produced. */
export type AgentTypeDay = { runs: number; tokens: Tokens }

/**
 * One local calendar day of one session: `main` the main thread's requests,
 * `agents` the subagents', `service` keepalives and compactions.
 * `models` splits all of them by the model that answered, `agentTypes` the
 * subagents by type; both counted since 0.11.0, absent in days stored before.
 */
export type DayStats = {
  answers: number
  requests: number
  main: Tokens
  agents: Tokens
  service: Tokens
  losses: number
  lostWritten: number
  compactions: number
  models?: Record<string, Tokens>
  agentTypes?: Record<string, AgentTypeDay>
}

/** Days by project root, each day by its local date: what one session, or every other summed, spent where. */
export type ProjectDays = Record<string, Record<string, DayStats>>

/** One row of the context as /context counts it; a deferred row is outside the window. */
export type ContextPart = { name: string; tokens: number; isDeferred: boolean }

/** What the context is made of, as of the last measure. */
export type ContextParts = {
  at: number
  total: number
  parts: ContextPart[]
  memory: { path: string; tokens: number }[]
  mcp: { server: string; tools: number; tokens: number }[]
}

declare module 'claude-code' {
  interface PluginState {
    'cache-meter': {
      last: CacheHit | null
      context: ContextFill | null
      rateLimits: RateLimitFill[]
      now: number
      warnedFor: number | null
      compactedAt: number | null
      turns: TurnRecord[]
      losses: CacheLoss[]
      agentLog: AgentRecord[]
      agentTotals: AgentTotals
      tzOffsetMinutes: number
      toolUsage: Record<string, ToolUsage>
      autoCredits: number
      bigResults: BigResult[]
      fileReads: Record<string, FileReads>
      /** This session's days by project, as last written to the store. */
      ownDays: ProjectDays
      /** Every other session's days by project, summed, as read from the store when /cache-stats opened. */
      otherDays: ProjectDays
      contextParts: ContextParts | null
    }
  }
}
