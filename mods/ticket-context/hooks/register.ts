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

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    const references = referencesIn(e.text)
    if (references.length === 0) return next(e)

    const run: Run = argv => $.process.run(argv)
    const blocks: string[] = []
    let sessionRepo: string | undefined
    for (const reference of references) {
      const repo = reference.repo ?? (sessionRepo ??= await currentRepo(run))
      blocks.push(describeTicket(`${repo}#${reference.number}`, await fetchTicket(run, repo, reference.number)))
    }
    return next({ ...e, context: [...(e.context ?? []), ...blocks] })
  })
}
