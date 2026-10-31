import type { Register } from 'claude-code'

import {
  describeTicket,
  issueRef,
  parseBlockers,
  parseIssue,
  referencesIn,
  repoSlug,
  type IssueNumber,
  type IssueRef,
  type RepoSlug,
  type Ticket,
} from './ticket'

type Run = (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>

/** A ticket whose repo is known: a bare `#n` once the session repo is looked up. */
type Resolved = { repo: RepoSlug; number: IssueNumber }

/** `gh`, run on the host from the session's working directory; throws with its own words on failure. */
async function gh(run: Run, ...argv: string[]): Promise<string> {
  const { exitCode, stdout, stderr } = await run(['gh', ...argv])
  if (exitCode !== 0) throw new Error(stderr.trim() || `gh ${argv[0]} exited ${exitCode}`)
  return stdout
}

/** The repo the session's working directory is a clone of. */
async function currentRepo(run: Run): Promise<RepoSlug> {
  return repoSlug((await gh(run, 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner')).trim())
}

/** The ticket and its open blockers; the blockers failing alone leaves them unknown rather than losing the ticket. */
async function fetchTicket(run: Run, { repo, number }: Resolved): Promise<Ticket> {
  const issue = parseIssue(await gh(run, 'issue', 'view', String(number), '--repo', repo, '--json', 'title,body,labels'))
  try {
    const out = await gh(
      run,
      'api',
      '--paginate',
      `repos/${repo}/issues/${number}/dependencies/blocked_by`,
      '--jq',
      '.[] | select(.state == "open") | (.repository_url | sub(".*/repos/"; "")) + "#" + (.number | tostring)',
    )
    return { ...issue, blockers: parseBlockers(out) }
  } catch {
    return { ...issue, blockers: null }
  }
}

/** The first line of an error's message: a note is one line. */
function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]
}

/** How many named tickets one prompt may pull in; the rest are left as typed. */
const MAX_REFERENCES = 5

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    const named = referencesIn(e.text)
    if (named.length === 0) return next(e)

    const cwd = await $.session.cwd()
    const run: Run = argv => $.process.run(argv, { cwd })
    const blocks: string[] = []
    const notes: string[] = []

    // The session repo is looked up once, and only when a bare #n needs it; its failing is one note, not one per #n.
    const bare = named.filter(reference => reference.repo === null)
    let sessionRepo: RepoSlug | null = null
    if (bare.length > 0) {
      try {
        sessionRepo = await currentRepo(run)
      } catch (error) {
        const names = bare.map(reference => `#${reference.number}`).join(', ')
        notes.push(`${$.plugin.name}: could not fetch ${names}: the session repo is unknown (${firstLine(error)})`)
      }
    }

    // Deduped once resolved, so a bare #42 and acme/pilot#42 typed in acme/pilot are one ticket.
    const resolved = new Map<IssueRef, Resolved>()
    for (const { repo: typedRepo, number } of named) {
      const repo = typedRepo ?? sessionRepo
      if (repo === null) continue
      const ref = issueRef(repo, number)
      if (!resolved.has(ref)) resolved.set(ref, { repo, number })
    }
    const chosen = [...resolved].slice(0, MAX_REFERENCES)

    for (const [ref, target] of chosen) {
      try {
        blocks.push(describeTicket(ref, await fetchTicket(run, target)))
      } catch (error) {
        notes.push(`${$.plugin.name}: could not fetch ${ref}: ${firstLine(error)}`)
      }
    }
    if (resolved.size > chosen.length) {
      notes.push(`${$.plugin.name}: ${resolved.size} tickets named, the first ${chosen.length} fetched.`)
    }
    for (const note of notes) $.ui.toast(note)
    return next({ ...e, context: [...(e.context ?? []), ...blocks, ...notes] })
  })
}
