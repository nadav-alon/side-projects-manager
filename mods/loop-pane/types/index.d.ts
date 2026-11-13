import type { JournaledTicket, RecordedDiscovery, RunInProgress } from '../hooks/manager-home/reader.ts'
import type { ProcessId, TokenCount } from '../hooks/manager-home/types.ts'

/** What the pane draws: the invocation in flight, the 5-hour window's spend and the discoveries waiting on the developer. Each is `null` when nothing is known; no recorded discoveries is an empty list. */
export type LoopSnapshot = {
  inFlight: {
    openedAt: string
    pid: ProcessId
    /** Whether the process that opened the record still runs; a record left open by a dead process is not in flight. */
    alive: boolean
    runs: RunInProgress[]
    freed: JournaledTicket[]
  } | null
  /** `spendable` is the allowance less the reserve: what the gate compares spend against. */
  usage: { tokensUsed: TokenCount; spendable: TokenCount } | null
  /** The recorded discoveries, newest filed first; `null` when the document cannot be read. */
  discoveries: Pick<RecordedDiscovery, 'repo' | 'number' | 'kind' | 'title'>[] | null
}

declare module 'claude-code' {
  interface PluginState {
    'loop-pane': { snapshot: LoopSnapshot; notice: string | null }
  }
}
