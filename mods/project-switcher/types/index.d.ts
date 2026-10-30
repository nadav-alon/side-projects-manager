export type RepoSlug = string & { readonly __repoSlug: true }

export type CiState = 'passing' | 'failing' | 'running' | 'none'

/** One registered project as the pane shows it. */
export type ProjectRow =
  | { reachable: true; repo: RepoSlug; turbo: boolean; ready: number; openPullRequests: number; ci: CiState }
  | { reachable: false; repo: RepoSlug; turbo: boolean; reason: string }

declare module 'claude-code' {
  interface PluginState {
    'project-switcher': { rows: ProjectRow[] | null; selected: RepoSlug | null; clonePath: string | null }
  }
}
