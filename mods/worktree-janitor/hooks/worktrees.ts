import { isBranchName, type BranchName } from './branch-name.ts'

/** Runs `git` with `args` in `cwd` and returns its stdout; rejects when git fails. */
export type Git = (args: readonly string[], cwd: string) => Promise<string>

/** One worktree under the repo's agent-worktree folder. `branch` is `undefined` for a detached HEAD. */
export type Worktree = {
  path: string
  branch: BranchName | undefined
  /** Whether the branch is already contained in the main worktree's HEAD; never true without a branch. */
  merged: boolean
  /** Whether the worktree has uncommitted changes, untracked files included. */
  dirty: boolean
  /** Seconds since the worktree's last commit. */
  ageSeconds: number
}

/** The folder, under the repo root, where Claude Code puts the worktrees its agents work in. */
export const AGENT_WORKTREE_FOLDER = '.claude/worktrees'

export const NO_WORKTREES = 'No agent worktrees in this repo.'

type Listed = { path: string; branch: BranchName | undefined }

/** Reads `git worktree list --porcelain`; the first entry is the main worktree. */
export function parseWorktreeList(porcelain: string): Listed[] {
  return porcelain
    .split(/\n\n+/)
    .map(block => block.split('\n'))
    .flatMap(lines => {
      const path = lines.find(l => l.startsWith('worktree '))?.slice('worktree '.length)
      if (path === undefined) return []
      const ref = lines.find(l => l.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length)
      return [{ path, branch: ref !== undefined && isBranchName(ref) ? ref : undefined }]
    })
}

/** The names `git branch --merged` prints: each line carries a two-character marker before the name. */
function parseMergedBranches(output: string): Set<string> {
  return new Set(output.split('\n').map(l => l.slice(2).trim()).filter(l => l !== ''))
}

/** Every worktree under the agent-worktree folder of the repo `cwd` belongs to, with its state. */
export async function listAgentWorktrees(git: Git, cwd: string): Promise<Worktree[]> {
  const [main, ...others] = parseWorktreeList(await git(['worktree', 'list', '--porcelain'], cwd))
  if (main === undefined) return []
  const folder = `${main.path.replace(/\/+$/, '')}/${AGENT_WORKTREE_FOLDER}/`
  const agents = others.filter(w => w.path.startsWith(folder))
  if (agents.length === 0) return []
  const merged = parseMergedBranches(await git(['branch', '--merged', 'HEAD'], main.path))
  const nowSeconds = Math.floor(Date.now() / 1000)
  return Promise.all(
    agents.map(async ({ path, branch }) => {
      const [status, committed] = await Promise.all([
        git(['status', '--porcelain'], path),
        git(['log', '-1', '--format=%ct'], path),
      ])
      return {
        path,
        branch,
        merged: branch !== undefined && merged.has(branch),
        dirty: status.trim() !== '',
        ageSeconds: Math.max(0, nowSeconds - Number(committed.trim())),
      }
    }),
  )
}

/** An age as its largest whole unit: `5m`, `3h`, `2d`. */
export function formatAge(seconds: number): string {
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

/** One line per worktree: its folder name, branch, merged state, uncommitted changes and age. */
export function formatListing(worktrees: readonly Worktree[]): string {
  if (worktrees.length === 0) return NO_WORKTREES
  return worktrees
    .map(w => {
      const name = w.path.slice(w.path.lastIndexOf('/') + 1)
      const state = [w.merged ? 'merged' : 'unmerged', ...(w.dirty ? ['uncommitted changes'] : [])].join(', ')
      return `${name}  ${w.branch ?? '(detached)'}  ${state}  ${formatAge(w.ageSeconds)}`
    })
    .join('\n')
}
