import type { JournaledTicket, RunInProgress } from '../hooks/manager-home/reader'
import type { TokenCount } from '../hooks/manager-home/types'

/** What the pane draws: the invocation in flight, and the 5-hour window's spend. Each is `null` when nothing is known. */
export type LoopSnapshot = {
  inFlight: {
    openedAt: string
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
