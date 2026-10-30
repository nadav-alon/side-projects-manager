import type { Register } from 'claude-code'

import { repoSlug, sizingReminder } from './reminder'

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const reminder = await sizingReminder(e.command, async () => {
      const { exitCode, stdout } = await $.process.run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
      if (exitCode !== 0) throw new Error('gh repo view failed')
      return repoSlug(stdout.trim())
    }).catch(() => null)
    const result = await next(e)
    return reminder === null ? result : { ...result, context: [...(result.context ?? []), reminder] }
  })
}
