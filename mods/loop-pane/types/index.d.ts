import type { JournaledTicket, RunInProgress } from '../hooks/manager-home/reader'
import type { ProcessId, TokenCount } from '../hooks/manager-home/types'

/** What the pane draws: the invocation in flight, and the 5-hour window's spend. Each is `null` when nothing is known. */
export type LoopSnapshot = {
  inFlight: {
    openedAt: string
    pid: ProcessId
    /** Whether the process that opened the record still runs; a record left open by a dead process is not in flight. */
    alive: boolean
    runs: RunInProgress[]
    freed: JournaledTicket[]
  } | null
  usage: { tokensUsed: TokenCount; allowance: TokenCount } | null
}

declare module 'claude-code' {
  interface PluginState {
    'loop-pane': { snapshot: LoopSnapshot; notice: string | null }
  }
}
