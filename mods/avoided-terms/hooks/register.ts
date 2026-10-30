import type { Register } from 'claude-code'

import { avoidedTermsIn, avoidedUses, proseOf, type AvoidedTerm } from './terms'

/** The issue and pull request text a shell command writes; a prose of its own, since the command is no file. */
const ISSUE_TEXT = /\bgh\s+(issue|pr)\s+(create|edit|comment)\b/

function note(path: string, uses: readonly AvoidedTerm[]): string {
  const terms = uses.map(({ avoided, preferred }) => `"${avoided}" (write "${preferred}")`).join(', ')
  return `${path} uses ${terms}: CONTEXT.md lists these as terms to avoid.`
}

// A note rides on the result and never blocks the write. A session whose root has no CONTEXT.md is untouched.
export const register: Register = on => {
  async function termsOf($: { session: { root(): Promise<string> }; fs: { read(path: string): Promise<unknown> } }): Promise<AvoidedTerm[]> {
    const context = await $.fs.read(`${await $.session.root()}/CONTEXT.md`).catch(() => undefined)
    return typeof context === 'string' ? avoidedTermsIn(context) : []
  }

  for (const tool of ['Edit', 'Write'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const terms = await termsOf($)
      const result = await next(e)
      if (terms.length === 0) return result
      const uses = avoidedUses(proseOf(e.file_path, e.tool === 'Edit' ? e.new_string : e.content), terms)
      return uses.length === 0 ? result : { ...result, context: [...(result.context ?? []), note(e.file_path, uses)] }
    })
  }

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    if (!ISSUE_TEXT.test(e.command)) return result
    const terms = await termsOf($)
    const uses = avoidedUses(e.command.replace(/`[^`\n]*`/g, ''), terms)
    return uses.length === 0 ? result : { ...result, context: [...(result.context ?? []), note('The issue text', uses)] }
  })
}
