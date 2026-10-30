import type { Register } from 'claude-code'

import { runWorktrees, type Git } from './worktrees.ts'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'worktrees',
      description: "List the session repo's agent worktrees; /worktrees prune removes the merged ones",
    })
    return next(e)
  })

  on('command.run', { command: 'worktrees' }, async ($, e) => {
    const git: Git = async (gitArgs, cwd) => {
      const { exitCode, stdout, stderr } = await $.process.run(['git', ...gitArgs], { cwd })
      if (exitCode !== 0) throw new Error(`git ${gitArgs.join(' ')} failed (exit ${exitCode}): ${stderr.trim()}`)
      return stdout
    }
    return { text: await runWorktrees(e.args, git, () => $.session.root(), (question, options) => $.ui.ask(question, [...options])) }
  })
}
