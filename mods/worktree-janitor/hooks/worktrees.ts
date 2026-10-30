import { isBranch, type Branch } from './branch.ts'

declare const secondsBrand: unique symbol

/** A span of time in seconds, as `git log --format=%ct` counts it; never milliseconds. */
export type Seconds = number & { readonly [secondsBrand]: true }

/** Narrows `value` to `Seconds`, or `undefined` when it is not a whole number of 0 or more. */
export function toSeconds(value: number): Seconds | undefined {
  return Number.isSafeInteger(value) && value >= 0 ? (value as Seconds) : undefined
}

/** Runs `git` with `args` in `cwd` and returns its stdout; rejects when git fails. */
export type Git = (args: readonly string[], cwd: string) => Promise<string>

/** One worktree under the repo's agent-worktree folder. `branch` is `undefined` for a detached HEAD. */
export type Worktree = {
  path: string
  branch: Branch | undefined
  /** Whether the branch has commits of its own and the default branch contains them all; never true without a branch. */
  merged: boolean
  /** Whether the worktree has uncommitted changes, untracked files included. */
  dirty: boolean
  /** Time since the worktree's last commit; `undefined` when git gave no usable timestamp. */
  age: Seconds | undefined
  /** Why git could not read the worktree; such a worktree is listed but never pruned. */
  error: string | undefined
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

/** The branch merges are judged against: the remote's default branch, else the one the main worktree has checked out. */
async function defaultBranch(git: Git, main: Listed): Promise<string> {
  try {
    const ref = (await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], main.path)).trim()
    if (ref !== '') return ref
  } catch {
    // No origin/HEAD: fall back to what the main worktree has checked out.
  }
  return main.branch ?? 'HEAD'
}

/** Whether `branch` was committed to since it was created: its tip is not the commit its reflog starts at. An unreadable reflog counts as never. */
async function diverged(git: Git, branch: Branch, cwd: string): Promise<boolean> {
  const tips = (await git(['reflog', 'show', '--format=%H', `refs/heads/${branch}`], cwd)).split('\n').filter(l => l !== '')
  return tips.length > 1 && tips[0] !== tips[tips.length - 1]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Every worktree under the agent-worktree folder of the repo `cwd` belongs to, with its state. */
export async function listAgentWorktrees(git: Git, cwd: string): Promise<Worktree[]> {
  const [main, ...others] = parseWorktreeList(await git(['worktree', 'list', '--porcelain'], cwd))
  if (main === undefined) return []
  const folder = `${main.path.replace(/\/+$/, '')}/${AGENT_WORKTREE_FOLDER}/`
  const agents = others.filter(w => w.path.startsWith(folder))
  if (agents.length === 0) return []
  const merged = parseMergedBranches(await git(['branch', '--merged', await defaultBranch(git, main)], main.path))
  const nowSeconds = Math.floor(Date.now() / 1000)
  return Promise.all(
    agents.map(async ({ path, branch }): Promise<Worktree> => {
      try {
        const [status, committed] = await Promise.all([
          git(['status', '--porcelain'], path),
          git(['log', '-1', '--format=%ct'], path),
        ])
        const timestamp = committed.trim()
        return {
          path,
          branch,
          merged: branch !== undefined && merged.has(branch) && (await diverged(git, branch, path)),
          dirty: status.trim() !== '',
          age: timestamp === '' ? undefined : toSeconds(Math.max(0, nowSeconds - Number(timestamp))),
          error: undefined,
        }
      } catch (error) {
        return { path, branch, merged: false, dirty: false, age: undefined, error: messageOf(error) }
      }
    }),
  )
}

/** An age as its largest whole unit: `5m`, `3h`, `2d`; `?` when unknown. */
export function formatAge(age: Seconds | undefined): string {
  if (age === undefined) return '?'
  if (age < 3600) return `${Math.floor(age / 60)}m`
  if (age < 86400) return `${Math.floor(age / 3600)}h`
  return `${Math.floor(age / 86400)}d`
}

/** One line per worktree: its folder name, branch, merged state, uncommitted changes and age, or why git could not read it. */
export function formatListing(worktrees: readonly Worktree[]): string {
  if (worktrees.length === 0) return NO_WORKTREES
  return worktrees
    .map(w => {
      const name = w.path.slice(w.path.lastIndexOf('/') + 1)
      if (w.error !== undefined) return `${name}  ${w.branch ?? '(detached)'}  error: ${w.error.split('\n')[0]}`
      const state = [w.merged ? 'merged' : 'unmerged', ...(w.dirty ? ['uncommitted changes'] : [])].join(', ')
      return `${name}  ${w.branch ?? '(detached)'}  ${state}  ${formatAge(w.age)}`
    })
    .join('\n')
}

/** The worktrees a prune may remove: merged, with no uncommitted changes and readable by git. */
export function prunable(worktrees: readonly Worktree[]): Worktree[] {
  return worktrees.filter(w => w.merged && !w.dirty && w.error === undefined)
}

export const NOTHING_TO_PRUNE = 'No merged worktrees without uncommitted changes to prune.'
export const PRUNE_CANCELLED = '/worktrees prune cancelled.'
export const USAGE = 'Usage: /worktrees [prune]'

/** `3 merged worktrees`, `1 worktree`: a count with `adjective` (and its trailing space) before the noun. */
function countWorktrees(n: number, adjective = ''): string {
  return `${n} ${adjective}worktree${n === 1 ? '' : 's'}`
}

/** The question put to the person before a prune removes `candidates`. */
export function pruneQuestion(candidates: readonly Worktree[]): string {
  return `Remove ${countWorktrees(candidates.length, 'merged ')}?\n${formatListing(candidates)}`
}

/**
 * Removes the prunable worktrees of the repo `cwd` belongs to once `confirm` agrees to the question.
 * The worktrees are read again after the confirmation, and only those the person was shown and that are still prunable are removed.
 * Removal never forces: git itself refuses a worktree with uncommitted changes. Each removal's outcome is reported, a refusal included.
 */
export async function pruneAgentWorktrees(git: Git, cwd: string, confirm: (question: string) => Promise<boolean>): Promise<string> {
  const listed = await listAgentWorktrees(git, cwd)
  const candidates = prunable(listed)
  if (candidates.length === 0) return listed.length === 0 ? NO_WORKTREES : NOTHING_TO_PRUNE
  if (!(await confirm(pruneQuestion(candidates)))) return PRUNE_CANCELLED
  const confirmed = new Set(candidates.map(w => w.path))
  const toRemove = prunable(await listAgentWorktrees(git, cwd)).filter(w => confirmed.has(w.path))
  const removed: Worktree[] = []
  const refused: string[] = []
  for (const worktree of toRemove) {
    try {
      await git(['worktree', 'remove', worktree.path], cwd)
      removed.push(worktree)
    } catch (error) {
      refused.push(`${worktree.path.slice(worktree.path.lastIndexOf('/') + 1)}  ${messageOf(error).split('\n')[0]}`)
    }
  }
  return [
    `Removed ${countWorktrees(removed.length)}:\n${formatListing(removed)}`,
    ...(refused.length > 0 ? [`Could not remove ${countWorktrees(refused.length)}:\n${refused.join('\n')}`] : []),
  ].join('\n')
}

/** Asks `question` of the person; resolves to the answer, or rejects when they cannot be asked. */
export type Ask = (question: string, options: readonly string[]) => Promise<string>

/** Runs `/worktrees <args>` for the repo of the session `root` and returns what to tell the person. A failure is told, not thrown. */
export async function runWorktrees(args: string, git: Git, root: () => Promise<string>, ask: Ask): Promise<string> {
  const subcommand = args.trim()
  if (subcommand !== '' && subcommand !== 'prune') return USAGE
  try {
    if (subcommand === 'prune') {
      const confirm = async (question: string) => (await ask(question, ['Yes', 'No']).catch(() => 'No')) === 'Yes'
      return await pruneAgentWorktrees(git, await root(), confirm)
    }
    return formatListing(await listAgentWorktrees(git, await root()))
  } catch (error) {
    return `/worktrees failed: ${messageOf(error)}`
  }
}
