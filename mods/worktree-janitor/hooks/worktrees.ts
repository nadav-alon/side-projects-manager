import { isBranch, type Branch } from './branch.ts'

/** Runs `git` with `args` in `cwd` and returns its stdout; rejects when git fails. */
export type Git = (args: readonly string[], cwd: string) => Promise<string>

/** One worktree under the repo's agent-worktree folder. `branch` is `undefined` for a detached HEAD. */
export type Worktree = {
  path: string
  branch: Branch | undefined
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

type Listed = { path: string; branch: Branch | undefined }

/** Reads `git worktree list --porcelain`; the first entry is the main worktree. */
export function parseWorktreeList(porcelain: string): Listed[] {
  return porcelain
    .split(/\n\n+/)
    .map(block => block.split('\n'))
    .flatMap(lines => {
      const path = lines.find(l => l.startsWith('worktree '))?.slice('worktree '.length)
      if (path === undefined) return []
      const ref = lines.find(l => l.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length)
      return [{ path, branch: ref !== undefined && isBranch(ref) ? ref : undefined }]
    })
}

/** The names `git branch --merged` prints: each line carries a two-character marker before the name. */
function parseMergedBranches(output: string): Set<Branch> {
  return new Set(output.split('\n').map(l => l.slice(2).trim()).filter(isBranch))
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

/** The worktrees a prune may remove: merged, with no uncommitted changes. */
export function prunable(worktrees: readonly Worktree[]): Worktree[] {
  return worktrees.filter(w => w.merged && !w.dirty)
}

export const NOTHING_TO_PRUNE = 'No merged worktrees without uncommitted changes to prune.'

/** The question put to the person before a prune removes `candidates`. */
export function pruneQuestion(candidates: readonly Worktree[]): string {
  return `Remove ${candidates.length} merged worktree${candidates.length === 1 ? '' : 's'}?\n${formatListing(candidates)}`
}

/**
 * Removes the prunable worktrees of the repo `cwd` belongs to once `confirm` agrees to the question.
 * The worktrees are read again after the confirmation, so one that changed meanwhile is judged as it now is.
 * Removal never forces: git itself refuses a worktree with uncommitted changes.
 */
export async function pruneAgentWorktrees(git: Git, cwd: string, confirm: (question: string) => Promise<boolean>): Promise<string> {
  const candidates = prunable(await listAgentWorktrees(git, cwd))
  if (candidates.length === 0) return NOTHING_TO_PRUNE
  if (!(await confirm(pruneQuestion(candidates)))) return '/worktrees prune cancelled.'
  const removed = prunable(await listAgentWorktrees(git, cwd))
  for (const { path } of removed) await git(['worktree', 'remove', path], cwd)
  return `Removed ${removed.length} worktree${removed.length === 1 ? '' : 's'}:\n${formatListing(removed)}`
}
