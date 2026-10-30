import type { Register } from 'claude-code'

import { foldedRepoSlug, isFoldedRepoSlug, sizingReminder } from './reminder'

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // Read the repo alongside the call; the reminder is only attached once the call has run.
    const pending = sizingReminder(e.command, async () => {
      const { exitCode, stdout, stderr } = await $.process.run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
      if (exitCode !== 0) throw new Error(`gh repo view failed: ${stderr.trim()}`)
      return foldedRepoSlug(stdout.trim())
    }, async () => {
      // `printenv` exits 1 when GH_REPO is unset.
      const { exitCode, stdout } = await $.process.run(['printenv', 'GH_REPO'])
      const value = stdout.trim().toLowerCase()
      return exitCode === 0 && isFoldedRepoSlug(value) ? value : null
    })
    const result = await next(e)
    const reminder = await pending
    return reminder === null ? result : { ...result, context: [...(result.context ?? []), reminder] }
  })
}
