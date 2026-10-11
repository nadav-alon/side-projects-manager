/** A GitHub repository as `owner/repo`; values enter through `repoSlug` or `isRepoSlug` in `hooks/ticket.ts`. */
export type RepoSlug = string & { readonly __brand: 'RepoSlug' }

/** The number a ticket is known by in its tracker; values enter through `issueNumber` or `isIssueNumber` in `hooks/ticket.ts`. */
export type IssueNumber = number & { readonly __brand: 'IssueNumber' }

export type Mode = 'grill' | 'standup' | 'triage' | 'wayfinder'

export type Ticket = { repo: RepoSlug; number: IssueNumber }

/** The mode skill the session last invoked, and the ticket its prompt named, if any. */
export type ModeBand = { mode: Mode; ticket: Ticket | null }

declare module 'claude-code' {
  interface PluginState {
    'mode-band': { current: ModeBand | null }
  }
}
