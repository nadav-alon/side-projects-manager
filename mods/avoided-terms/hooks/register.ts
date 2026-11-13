import type { Register } from 'claude-code'

import { avoidedUses, proseOf, type AvoidedTerm } from './terms'
import { vocabularySources } from './sources'
import type { ShellTrail } from './target-repo/target'
import { sessionTerms, usesIn } from './vocabulary'
import { ghWrites } from './writes'

/** This checkout's root: the mod sits at `mods/avoided-terms/hooks`. */
const CHECKOUT_ROOT = import.meta.dir.split('/').slice(0, -3).join('/')

type Result = { context?: string[] }

function note(plugin: string, subject: string, uses: readonly AvoidedTerm[]): string {
  const terms = uses.map(({ avoided, preferred }) => `"${avoided}" (write "${preferred}")`).join(', ')
  return `${plugin}: ${subject} uses ${terms}: CONTEXT.md lists these as terms to avoid.`
}

function withNote<R extends Result>(result: R, plugin: string, subject: string, uses: readonly AvoidedTerm[]): R {
  return uses.length === 0 ? result : { ...result, context: [...(result.context ?? []), note(plugin, subject, uses)] }
}

/** A write that was denied or failed wrote nothing, so there is no text to advise on. */
function wrote(result: { deny?: unknown; isError?: boolean }): boolean {
  return result.deny === undefined && result.isError !== true
}

// A note rides on the result and never blocks the write. A session whose repo has no CONTEXT.md is untouched.
export const register: Register = on => {
  for (const tool of ['Edit', 'Write'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const result = await next(e)
      if (!wrote(result)) return result
      const terms = await sessionTerms(vocabularySources($, CHECKOUT_ROOT))
      if (terms.length === 0) return result
      const prose = proseOf(e.file_path, e.tool === 'Edit' ? e.new_string : e.content)
      // An edit carries over the text around it, so only a term it adds is news.
      const before = e.tool === 'Edit' ? avoidedUses(proseOf(e.file_path, e.old_string), terms).map(t => t.avoided) : []
      const uses = avoidedUses(prose, terms).filter(t => !before.includes(t.avoided))
      return withNote(result, $.plugin.name, e.file_path, uses)
    })
  }

  // One trail per loaded mod: it must outlive each call, but a hot reload forgets a `cd` from before it.
  const trail: ShellTrail = { moved: false }
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    // Walked whether or not the call wrote, so a `cd` reaches the trail.
    const writes = ghWrites(e.command, trail)
    if (!wrote(result) || writes.length === 0) return result
    return withNote(result, $.plugin.name, 'The issue text', await usesIn(writes, vocabularySources($, CHECKOUT_ROOT)))
  })
}
