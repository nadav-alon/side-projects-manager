import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { NO_WORKTREES, NOTHING_TO_PRUNE, formatAge, formatListing, listAgentWorktrees, pruneAgentWorktrees, type Git } from './worktrees.ts'

const ROOT = '/work/repo'
const NOW = Math.floor(Date.now() / 1000)

type Fake = { branch: string | null; dirty: boolean; committedAgoSeconds: number; merged: boolean }

/** A git whose repo at ROOT has the agent worktrees `fakes` (keyed by folder name) plus one outside the folder. */
function fakeGit(fakes: Record<string, Fake>): Git {
  const entries = Object.entries(fakes)
  return async (args, cwd) => {
    const [command] = args
    if (command === 'worktree') {
      const blocks = [`worktree ${ROOT}\nHEAD abc\nbranch refs/heads/master`]
      blocks.push(`worktree /elsewhere/other\nHEAD abc\nbranch refs/heads/other`)
      for (const [name, f] of entries) {
        blocks.push(`worktree ${ROOT}/.claude/worktrees/${name}\nHEAD abc\n${f.branch === null ? 'detached' : `branch refs/heads/${f.branch}`}`)
      }
      return blocks.join('\n\n') + '\n'
    }
    if (command === 'branch') {
      return ['* master', ...entries.filter(([, f]) => f.merged && f.branch !== null).map(([, f]) => `+ ${f.branch}`)].join('\n') + '\n'
    }
    const fake = entries.find(([name]) => cwd === `${ROOT}/.claude/worktrees/${name}`)?.[1]
    if (fake === undefined) throw new Error(`unexpected ${args.join(' ')} in ${cwd}`)
    if (command === 'status') return fake.dirty ? ' M file.ts\n' : ''
    if (command === 'log') return `${NOW - fake.committedAgoSeconds}\n`
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
        [`${ROOT}/.claude/worktrees/done`, 'issue-1-done', true, false],
        [`${ROOT}/.claude/worktrees/open`, 'issue-2-open', false, false],
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

  it('says so when the repo has no agent worktrees', async () => {
    const listed = await listAgentWorktrees(fakeGit({}), ROOT)
    assert.deepEqual(listed, [])
    assert.equal(formatListing(listed), NO_WORKTREES)
  })
})

describe('formatAge', () => {
  it('uses the largest whole unit', () => {
    assert.deepEqual([0, 59, 3599, 3600, 86399, 86400].map(formatAge), ['0m', '0m', '59m', '1h', '23h', '1d'])
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
    assert.deepEqual(removed, [`${ROOT}/.claude/worktrees/done`])
    assert.deepEqual(asked, ['Remove 1 merged worktree?\ndone  issue-1-done  merged  1d'])
    assert.equal(out, 'Removed 1 worktree:\ndone  issue-1-done  merged  1d')
  })

  it('removes nothing when the person declines', async () => {
    const { git, removed } = recording(fakes)
    assert.equal(await pruneAgentWorktrees(git, ROOT, async () => false), '/worktrees prune cancelled.')
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

  it('says so when the repo has no agent worktrees', async () => {
    const { git } = recording({})
    assert.equal(await pruneAgentWorktrees(git, ROOT, async () => true), NOTHING_TO_PRUNE)
  })
})
