export type CacheHit = {
  at: number
  hitPercent: number
  model: string
  effort?: string | number
}
export type ContextFill = { tokens: number; window: number; percent: number }
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

/** A subagent run in progress: its tokens so far, all four counts summed. */
export type AgentRun = { id: string; tokens: number }

export type AgentTotals = { runs: number; tokens: number }

/** What one tool (or one MCP server) put into the main context this session. */
export type ToolUsage = { calls: number; tokens: number }

/** One tool result, by what it read or ran: `Read config.php`, `Bash make test`. */
export type BigResult = { at: number; label: string; tokens: number }

/** How often one file was read into the main context, and how much it brought. */
export type FileReads = { reads: number; tokens: number }

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
      agents: AgentRun[]
      agentTotals: AgentTotals
      tzOffsetMinutes: number
      toolUsage: Record<string, ToolUsage>
      autoCredits: number
      bigResults: BigResult[]
      fileReads: Record<string, FileReads>
    }
  }
}
