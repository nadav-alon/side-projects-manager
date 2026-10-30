// The contract holds plain shapes only: it is self-contained and declares no value, so the branded
// types (`RepoSlug`, `AbsolutePath`) live in hooks/switcher.ts and meet the state through their guards.

/** One registered project as the pane shows it. */
export type ProjectRow =
  | { reachable: true; repo: string; turbo: boolean; ready: number; openPullRequests: number; ci: 'passing' | 'failing' | 'running' | 'none' }
  | { reachable: false; repo: string; turbo: boolean; reason: string }

declare module 'claude-code' {
  interface PluginState {
    'project-switcher': {
      rows: ProjectRow[] | null
      selected: string | null
      clonePath: string | null
      refreshing: boolean
      problem: string | null
    }
  }
}
