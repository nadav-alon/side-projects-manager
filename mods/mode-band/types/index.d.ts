export type Mode = 'grill' | 'standup' | 'triage' | 'wayfinder'

export type Ticket = { repo: string; number: number }

/** The mode skill the session last invoked, and the ticket its prompt named, if any. */
export type ModeBand = { mode: Mode; ticket: Ticket | null }

declare module 'claude-code' {
  interface PluginState {
    'mode-band': { current: ModeBand | null }
  }
}
