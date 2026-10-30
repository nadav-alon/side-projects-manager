import type { Register } from 'claude-code'

import { formatListing, listAgentWorktrees, pruneAgentWorktrees, type Git } from './worktrees.ts'

const USAGE = 'Usage: /worktrees [prune]'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'worktrees',
      description: "List the session repo's agent worktrees; /worktrees prune removes the merged ones",
    })
    return next(e)
  })

  on('command.run', { command: 'worktrees' }, async ($, e) => {
    const args = e.args.trim()
    if (args !== '' && args !== 'prune') return { text: USAGE }
    const git: Git = async (gitArgs, cwd) => {
      const { exitCode, stdout, stderr } = await $.process.run(['git', ...gitArgs], { cwd })
      if (exitCode !== 0) throw new Error(`git ${gitArgs.join(' ')} failed (exit ${exitCode}): ${stderr.trim()}`)
      return stdout
    }
    try {
      const root = await $.session.root()
      if (args === 'prune') {
        const confirm = async (question: string) => (await $.ui.ask(question, ['Yes', 'No']).catch(() => 'No')) === 'Yes'
        return { text: await pruneAgentWorktrees(git, root, confirm) }
      }
      return { text: formatListing(await listAgentWorktrees(git, root)) }
    } catch (error) {
      return { text: `/worktrees failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  })
}
