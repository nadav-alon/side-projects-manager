import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  AGENT_WORKTREE_FOLDER,
  NO_WORKTREES,
  NOTHING_TO_PRUNE,
  PRUNE_CANCELLED,
  USAGE,
  formatAge,
  formatListing,
  listAgentWorktrees,
  pruneAgentWorktrees,
  runWorktrees,
  toSeconds,
  type Git,
} from './worktrees.ts'

const ROOT = '/work/repo'
const NOW = Math.floor(Date.now() / 1000)
const FOLDER = `${ROOT}/${AGENT_WORKTREE_FOLDER}`

type Fake = {
  branch: string | null
  dirty: boolean
  committedAgoSeconds: number
  merged: boolean
  /** The branch has no commit of its own: its tip is the commit it was cut from. */
  untouched?: boolean
  /** What `git status` does in the worktree. */
  statusFails?: boolean
  /** What `git log -1 --format=%ct` prints, in place of the real timestamp. */
  timestamp?: string
}

/** A git whose repo at ROOT has the agent worktrees `fakes` (keyed by folder name) plus one outside the folder. */
function fakeGit(fakes: Record<string, Fake>): Git {
  const entries = Object.entries(fakes)
  return async (args, cwd) => {
    const [command] = args
    if (command === 'worktree') {
      const blocks = [`worktree ${ROOT}\nHEAD abc\nbranch refs/heads/master`]
      blocks.push(`worktree /elsewhere/other\nHEAD abc\nbranch refs/heads/other`)
      for (const [name, f] of entries) {
        blocks.push(`worktree ${FOLDER}/${name}\nHEAD abc\n${f.branch === null ? 'detached' : `branch refs/heads/${f.branch}`}`)
      }
      return blocks.join('\n\n') + '\n'
    }
    if (command === 'symbolic-ref') throw new Error('no origin/HEAD')
    if (command === 'branch') {
      assert.equal(args[2], 'master', 'merged is judged against the default branch')
      return ['* master', ...entries.filter(([, f]) => f.merged && f.branch !== null).map(([, f]) => `+ ${f.branch}`)].join('\n') + '\n'
    }
    const fake = entries.find(([name]) => cwd === `${FOLDER}/${name}`)?.[1]
    if (fake === undefined) throw new Error(`unexpected ${args.join(' ')} in ${cwd}`)
    if (command === 'reflog') return (fake.untouched ? ['aaa', 'aaa'] : ['bbb', 'aaa']).join('\n') + '\n'
    if (command === 'status' && fake.statusFails) throw new Error(`cannot chdir to ${cwd}`)
    if (command === 'status') return fake.dirty ? ' M file.ts\n' : ''
    if (command === 'log') return `${fake.timestamp ?? NOW - fake.committedAgoSeconds}\n`
    throw new Error(`unexpected ${args.join(' ')}`)
  }
}

describe('listAgentWorktrees', () => {
  it('lists each worktree under the agent-worktree folder with branch, merged state and age', async () => {
    const git = fakeGit({
      done: { branch: 'issue-1-done', dirty: false, committedAgoSeconds: 3 * 86400, merged: true },
      open: { branch: 'issue-2-open', dirty: false, committedAgoSeconds: 2 * 3600, merged: false },
    })
    const listed = await listAgentWorktrees(git, ROOT)
    assert.deepEqual(
      listed.map(w => [w.path, w.branch, w.merged, w.dirty]),
      [
        [`${FOLDER}/done`, 'issue-1-done', true, false],
        [`${FOLDER}/open`, 'issue-2-open', false, false],
      ],
    )
    assert.equal(formatListing(listed), ['done  issue-1-done  merged  3d', 'open  issue-2-open  unmerged  2h'].join('\n'))
  })

  it('lists a worktree with uncommitted changes and says so', async () => {
    const git = fakeGit({ wip: { branch: 'issue-3-wip', dirty: true, committedAgoSeconds: 600, merged: true } })
    const listed = await listAgentWorktrees(git, ROOT)
    assert.equal(formatListing(listed), 'wip  issue-3-wip  merged, uncommitted changes  10m')
  })

  it('lists a detached worktree as unmerged', async () => {
    const git = fakeGit({ loose: { branch: null, dirty: false, committedAgoSeconds: 60, merged: false } })
    assert.equal(formatListing(await listAgentWorktrees(git, ROOT)), 'loose  (detached)  unmerged  1m')
  })

  it('does not count a branch with no commit of its own as merged', async () => {
    const git = fakeGit({ fresh: { branch: 'issue-4-fresh', dirty: false, committedAgoSeconds: 5, merged: true, untouched: true } })
    assert.equal(formatListing(await listAgentWorktrees(git, ROOT)), 'fresh  issue-4-fresh  unmerged  0m')
  })

  it('lists a worktree git cannot read with its error, beside the others', async () => {
    const git = fakeGit({
      gone: { branch: 'issue-5-gone', dirty: false, committedAgoSeconds: 5, merged: true, statusFails: true },
      done: { branch: 'issue-1-done', dirty: false, committedAgoSeconds: 60, merged: true },
    })
    assert.equal(
      formatListing(await listAgentWorktrees(git, ROOT)),
      [`gone  issue-5-gone  error: cannot chdir to ${FOLDER}/gone`, 'done  issue-1-done  merged  1m'].join('\n'),
    )
  })

  it('shows an unknown age when git gives no timestamp', async () => {
    const git = fakeGit({ blank: { branch: 'issue-6-blank', dirty: false, committedAgoSeconds: 0, merged: false, timestamp: '' } })
    assert.equal(formatListing(await listAgentWorktrees(git, ROOT)), 'blank  issue-6-blank  unmerged  ?')
  })

  it('says so when the repo has no agent worktrees', async () => {
    const listed = await listAgentWorktrees(fakeGit({}), ROOT)
    assert.deepEqual(listed, [])
    assert.equal(formatListing(listed), NO_WORKTREES)
  })
})

describe('formatAge', () => {
  it('uses the largest whole unit', () => {
    assert.deepEqual([0, 59, 3599, 3600, 86399, 86400].map(n => formatAge(toSeconds(n))), ['0m', '0m', '59m', '1h', '23h', '1d'])
    assert.equal(formatAge(undefined), '?')
  })
})

describe('pruneAgentWorktrees', () => {
  const fakes = {
    done: { branch: 'issue-1-done', dirty: false, committedAgoSeconds: 86400, merged: true },
    open: { branch: 'issue-2-open', dirty: false, committedAgoSeconds: 60, merged: false },
    wip: { branch: 'issue-3-wip', dirty: true, committedAgoSeconds: 60, merged: true },
  }

  /** `fakeGit` that also records the `worktree remove` calls. */
  function recording(f: Record<string, Fake>) {
    const removed: string[] = []
    const inner = fakeGit(f)
    const git: Git = async (args, cwd) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        removed.push(args[2]!)
        return ''
      }
      return inner(args, cwd)
    }
    return { git, removed }
  }

  it('removes only merged worktrees without uncommitted changes, after confirmation', async () => {
    const { git, removed } = recording(fakes)
    const asked: string[] = []
    const out = await pruneAgentWorktrees(git, ROOT, async q => (asked.push(q), true))
    assert.deepEqual(removed, [`${FOLDER}/done`])
    assert.deepEqual(asked, ['Remove 1 merged worktree?\ndone  issue-1-done  merged  1d'])
    assert.equal(out, 'Removed 1 worktree:\ndone  issue-1-done  merged  1d')
  })

  it('removes nothing when the person declines', async () => {
    const { git, removed } = recording(fakes)
    assert.equal(await pruneAgentWorktrees(git, ROOT, async () => false), PRUNE_CANCELLED)
    assert.deepEqual(removed, [])
  })

  it('never offers a worktree with uncommitted changes, even a merged one, and asks nothing when none is prunable', async () => {
    const { git, removed } = recording({ wip: fakes.wip, open: fakes.open })
    let asked = 0
    const out = await pruneAgentWorktrees(git, ROOT, async () => (asked++, true))
    assert.equal(out, NOTHING_TO_PRUNE)
    assert.equal(asked, 0)
    assert.deepEqual(removed, [])
  })

  it('says there are no worktrees when the repo has none, and nothing to prune when it has only unprunable ones', async () => {
    assert.equal(await pruneAgentWorktrees(recording({}).git, ROOT, async () => true), NO_WORKTREES)
    assert.equal(await pruneAgentWorktrees(recording({ open: fakes.open }).git, ROOT, async () => true), NOTHING_TO_PRUNE)
  })

  it('never removes a worktree that became prunable while the question was open', async () => {
    const { git: inner, removed } = recording(fakes)
    let listings = 0
    const git: Git = async (args, cwd) => {
      if (args[0] === 'worktree' && args[1] === 'list') listings++
      if (args[0] === 'worktree' && args[1] === 'list' && listings > 1) {
        return (await inner(args, cwd)) + `\nworktree ${FOLDER}/late\nHEAD abc\nbranch refs/heads/issue-9-late\n`
      }
      if (cwd === `${FOLDER}/late`) return args[0] === 'log' ? `${NOW - 60}\n` : args[0] === 'reflog' ? 'b\na\n' : ''
      if (args[0] === 'branch' && listings > 1) return (await inner(args, cwd)) + '+ issue-9-late\n'
      return inner(args, cwd)
    }
    const out = await pruneAgentWorktrees(git, ROOT, async () => true)
    assert.deepEqual(removed, [`${FOLDER}/done`])
    assert.equal(out, 'Removed 1 worktree:\ndone  issue-1-done  merged  1d')
  })

  it('reports the removals that succeeded and the ones git refused', async () => {
    const { git: inner } = recording({
      first: { branch: 'issue-1-a', dirty: false, committedAgoSeconds: 60, merged: true },
      second: { branch: 'issue-2-b', dirty: false, committedAgoSeconds: 60, merged: true },
    })
    const git: Git = async (args, cwd) => {
      if (args[1] === 'remove' && args[2]!.endsWith('/first')) throw new Error('contains modified or untracked files')
      return inner(args, cwd)
    }
    assert.equal(
      await pruneAgentWorktrees(git, ROOT, async () => true),
      ['Removed 1 worktree:', 'second  issue-2-b  merged  1m', 'Could not remove 1 worktree:', 'first  contains modified or untracked files'].join('\n'),
    )
  })
})

describe('runWorktrees', () => {
  const root = async () => ROOT
  const fakes = { done: { branch: 'issue-1-done', dirty: false, committedAgoSeconds: 86400, merged: true } }
  const never: (...a: unknown[]) => Promise<string> = async () => assert.fail('asked')

  it('lists with no argument and answers a usage line to anything else', async () => {
    assert.equal(await runWorktrees('  ', fakeGit(fakes), root, never), 'done  issue-1-done  merged  1d')
    assert.equal(await runWorktrees('nuke', fakeGit(fakes), root, never), USAGE)
  })

  it('prunes when the person answers Yes, and not otherwise', async () => {
    assert.match(await runWorktrees('prune', fakeGit(fakes), root, async () => 'Yes'), /^Removed 1 worktree/)
    assert.equal(await runWorktrees('prune', fakeGit(fakes), root, async () => 'No'), PRUNE_CANCELLED)
  })

  it('treats a question that cannot be asked as No', async () => {
    assert.equal(await runWorktrees('prune', fakeGit(fakes), root, async () => Promise.reject(new Error('no ui'))), PRUNE_CANCELLED)
  })

  it('tells a failure instead of throwing it', async () => {
    const failing: Git = async () => { throw new Error('not a git repository') }
    assert.equal(await runWorktrees('', failing, root, never), '/worktrees failed: not a git repository')
    assert.equal(await runWorktrees('', fakeGit(fakes), async () => Promise.reject(new Error('no session')), never), '/worktrees failed: no session')
  })
})
