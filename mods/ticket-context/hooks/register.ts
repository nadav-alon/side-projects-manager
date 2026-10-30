import type { Register } from 'claude-code'

import { describeTicket, referencesIn, type Ticket } from './ticket'

type Run = (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>

/** `gh`, run on the host from the session's working directory; throws with its own words on failure. */
async function gh(run: Run, ...argv: string[]): Promise<string> {
  const { exitCode, stdout, stderr } = await run(['gh', ...argv])
  if (exitCode !== 0) throw new Error(stderr.trim() || `gh ${argv[0]} exited ${exitCode}`)
  return stdout
}

/** The repo the session's working directory is a clone of. */
async function currentRepo(run: Run): Promise<string> {
  return (await gh(run, 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner')).trim()
}

async function fetchTicket(run: Run, repo: string, number: number): Promise<Ticket> {
  const issue = JSON.parse(await gh(run, 'issue', 'view', String(number), '--repo', repo, '--json', 'title,body,labels')) as {
    title: string
    body: string
    labels: { name: string }[]
  }
  const blockers = await gh(
    run,
    'api',
    '--paginate',
    `repos/${repo}/issues/${number}/dependencies/blocked_by`,
    '--jq',
    '.[] | (.repository_url | sub(".*/repos/"; "")) + "#" + (.number | tostring)',
  )
  return {
    title: issue.title,
    body: issue.body,
    labels: issue.labels.map(label => label.name),
    blockers: blockers.split('\n').map(line => line.trim()).filter(line => line !== ''),
  }
}

/** How many named tickets one prompt may pull in; the rest are left as typed. */
const MAX_REFERENCES = 5

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    const named = referencesIn(e.text)
    if (named.length === 0) return next(e)
    const references = named.slice(0, MAX_REFERENCES)

    const run: Run = argv => $.process.run(argv)
    const blocks: string[] = []
    const notes: string[] = []
    let sessionRepo: string | undefined
    for (const reference of references) {
      const label = `${reference.repo ?? ''}#${reference.number}`
      try {
        const repo = reference.repo ?? (sessionRepo ??= await currentRepo(run))
        blocks.push(describeTicket(`${repo}#${reference.number}`, await fetchTicket(run, repo, reference.number)))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        notes.push(`${$.plugin.name}: could not fetch ${label}: ${reason.split('\n')[0]}`)
      }
    }
    if (named.length > references.length) {
      notes.push(`${$.plugin.name}: ${named.length} tickets named, the first ${references.length} fetched.`)
    }
    for (const note of notes) $.ui.toast(note)
    return next({ ...e, context: [...(e.context ?? []), ...blocks, ...notes] })
  })
}
