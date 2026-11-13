import type { Register } from 'claude-code'

import { avoidedTermsIn, avoidedUses, issueTextOf, proseOf, type AvoidedTerm } from './terms'
import { termsForCommand } from './vocabulary'

/**
 * Issue and pull request text a `gh` command writes, checked as a whole: its `--title` and `--body` values.
 * Out of scope: `gh api … -f body=`, and `--body-file`, whose prose lives in a file the command only names.
 */
const ISSUE_TEXT = /\bgh\s+(issue|pr)\s+(create|edit|comment|review)\b/

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

async function termsOf($: { session: { cwd(): Promise<string> }; fs: { read(path: string): Promise<unknown> } }): Promise<AvoidedTerm[]> {
  const context = await $.fs.read(`${await $.session.cwd()}/CONTEXT.md`).catch(() => undefined)
  return typeof context === 'string' ? avoidedTermsIn(context) : []
}

/** Where the manager clones projects, resolved as `src/adapters/manager-home.ts` resolves it; null when neither it nor `HOME` is set. */
async function managedLocation($: { process: { run(argv: string[]): Promise<{ stdout: string }> } }): Promise<string | null> {
  const { stdout } = await $.process.run(['sh', '-c', 'printf "%s\\n%s" "$SIDE_PROJECTS_MANAGED_LOCATION" "$HOME"'])
  const [managed, home] = stdout.split('\n')
  return managed || (home ? `${home}/side-projects` : null)
}

/** The repo of the session's working directory, as lower-case `owner/repo`. */
async function sessionRepo($: { process: { run(argv: string[]): Promise<{ exitCode: number; stdout: string }> } }): Promise<string> {
  const { exitCode, stdout } = await $.process.run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  if (exitCode !== 0) throw new Error('gh repo view failed')
  return stdout.trim().toLowerCase()
}

// A note rides on the result and never blocks the write. A session whose repo has no CONTEXT.md is untouched.
export const register: Register = on => {
  for (const tool of ['Edit', 'Write'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const result = await next(e)
      if (!wrote(result)) return result
      const terms = await termsOf($)
      if (terms.length === 0) return result
      const prose = proseOf(e.file_path, e.tool === 'Edit' ? e.new_string : e.content)
      // An edit carries over the text around it, so only a term it adds is news.
      const before = e.tool === 'Edit' ? avoidedUses(proseOf(e.file_path, e.old_string), terms).map(t => t.avoided) : []
      const uses = avoidedUses(prose, terms).filter(t => !before.includes(t.avoided))
      return withNote(result, $.plugin.name, e.file_path, uses)
    })
  }

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    if (!wrote(result) || !ISSUE_TEXT.test(e.command)) return result
    const terms = await termsForCommand(e.command, {
      cwd: () => $.session.cwd(),
      managed: () => managedLocation($),
      sessionRepo: () => sessionRepo($),
      read: async path => {
        const text = await $.fs.read(path)
        return typeof text === 'string' ? text : null
      },
    })
    return withNote(result, $.plugin.name, 'The issue text', avoidedUses(issueTextOf(e.command), terms))
  })
}
