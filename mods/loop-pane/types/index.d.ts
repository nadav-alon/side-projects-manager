/** What the pane draws: the invocation in flight, and the 5-hour window's spend. Each is `null` when nothing is known. */
export type LoopSnapshot = {
  inFlight: {
    openedAt: string
    runs: { repo: string; number: number; kind: string }[]
    freed: { repo: string; number: number }[]
  } | null
  usage: { tokensUsed: number; allowance: number } | null
}

declare module 'claude-code' {
  interface PluginState {
    'loop-pane': { snapshot: LoopSnapshot }
  }
}
