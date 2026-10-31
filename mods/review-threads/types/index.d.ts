import type { DraftPullRequest } from '../hooks/threads'

declare module 'claude-code' {
  interface PluginState {
    'review-threads': {
      /** The draft pull requests the last read found; `null` before the first read. */
      pullRequests: DraftPullRequest[] | null
      /** What the last read or post came to, shown above the list; empty when there is nothing to say. */
      notice: string
    }
  }
}
