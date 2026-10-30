import type { Register } from 'claude-code'

import { mergesMoreThanOnce } from './merges'

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, ($, e, next) =>
    mergesMoreThanOnce(e.command)
      ? { deny: `${$.plugin.name}: this command merges more than one pull request. Run one \`gh pr merge\` per shell call.` }
      : next(e),
  )
}
