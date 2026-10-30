import type { Register } from 'claude-code'

import { lineNamingManager } from './naming'
import { HARNESS_SOURCE, uniformFilesIn } from './uniform'

export const register: Register = on => {
  for (const tool of ['Edit', 'Write'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const root = await $.session.root()
      if (!e.file_path.startsWith(`${root}/`)) return next(e)

      // A session outside the manager has no harness source, so nothing here applies to it.
      const harness = await $.fs.read(`${root}/${HARNESS_SOURCE}`).catch(() => undefined)
      if (typeof harness !== 'string') return next(e)

      const relative = e.file_path.slice(root.length + 1)
      if (!uniformFilesIn(harness).includes(relative)) return next(e)

      const offending = lineNamingManager(e.tool === 'Edit' ? e.new_string : e.content)
      return offending === undefined
        ? next(e)
        : {
            deny: `${$.plugin.name}: ${relative} is copied byte for byte into every project, so it may not name the manager. Offending text: ${JSON.stringify(offending)}`,
          }
    })
  }
}
