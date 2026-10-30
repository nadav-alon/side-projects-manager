import type { Register } from 'claude-code'

import { lineNamingManager } from './naming'
import { HARNESS_SOURCE, relativeToHome, uniformFilesIn } from './uniform'

// Only `Edit` and `Write` are guarded: shell redirection and any other tool that writes a file reach a uniform file unchecked.
export const register: Register = on => {
  for (const tool of ['Edit', 'Write'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const home = await $.session.root()
      const relative = relativeToHome(home, e.file_path)
      if (relative === undefined) return next(e)

      // A session outside the manager has no harness source, so nothing here applies to it.
      const harness = await $.fs.read(`${home}/${HARNESS_SOURCE}`).catch(() => undefined)
      if (typeof harness !== 'string') return next(e)

      const uniform = uniformFilesIn(harness)
      if (uniform.length === 0) {
        return { deny: `${$.plugin.name}: ${HARNESS_SOURCE} declares no UNIFORM_FILES this guard can read, so it cannot tell which files may not name the manager.` }
      }
      if (!uniform.includes(relative)) return next(e)

      const content = e.tool === 'Edit' ? await editedContent($, e.file_path, e) : e.content
      const offending = lineNamingManager(content)
      return offending === undefined
        ? next(e)
        : {
            deny: `${$.plugin.name}: ${relative} is copied byte for byte into every project, so it may not name the manager. Offending text: ${JSON.stringify(offending)}`,
          }
    })
  }
}

/** The file as the edit leaves it; the edit's own fragment when the file cannot be read. */
async function editedContent(
  $: { fs: { read(path: string): Promise<unknown> } },
  path: string,
  e: { old_string: string; new_string: string; replace_all?: boolean },
): Promise<string> {
  const current = await $.fs.read(path).catch(() => undefined)
  if (typeof current !== 'string') return e.new_string
  return e.replace_all ? current.split(e.old_string).join(e.new_string) : current.replace(e.old_string, () => e.new_string)
}
