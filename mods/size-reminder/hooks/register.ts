import type { Register } from 'claude-code'

import { flagRepo, foldedRepoSlug, sizingReminder } from './reminder'
import { environmentRepo } from './target-repo/target'

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // Read the repo alongside the call; the reminder is only attached once the call has run.
    const pending = sizingReminder(e.command, async () => {
      const { exitCode, stdout, stderr } = await $.process.run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
      if (exitCode !== 0) throw new Error(`gh repo view failed: ${stderr.trim()}`)
      return foldedRepoSlug(stdout.trim())
    }, () => environmentRepo(argv => $.process.run(argv), flagRepo))
    const result = await next(e)
    const reminder = await pending
    return reminder === null ? result : { ...result, context: [...(result.context ?? []), reminder] }
  })
}
