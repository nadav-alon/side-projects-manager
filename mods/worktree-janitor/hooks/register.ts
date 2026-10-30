import type { Register } from 'claude-code'

import { formatListing, listAgentWorktrees, type Git } from './worktrees.ts'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'worktrees', description: "List the session repo's agent worktrees" })
    return next(e)
  })

  on('command.run', { command: 'worktrees' }, async $ => {
    const git: Git = async (args, cwd) => {
      const { exitCode, stdout, stderr } = await $.process.run(['git', ...args], { cwd })
      if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed (exit ${exitCode}): ${stderr.trim()}`)
      return stdout
    }
    try {
      return { text: formatListing(await listAgentWorktrees(git, await $.session.root())) }
    } catch (error) {
      return { text: `/worktrees failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  })
}
