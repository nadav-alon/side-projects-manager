import type { Register } from 'claude-code'

import { describeTicket, referencesIn, type Ticket } from './ticket'

type Run = (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>

/** The ticket as `gh` reads it, run on the host from the session's working directory. */
async function fetchTicket(run: Run, repo: string, number: number): Promise<Ticket> {
  async function gh(...argv: string[]): Promise<string> {
    const { exitCode, stdout, stderr } = await run(['gh', ...argv])
    if (exitCode !== 0) throw new Error(stderr.trim() || `gh ${argv[0]} exited ${exitCode}`)
    return stdout
  }

  const issue = JSON.parse(await gh('issue', 'view', String(number), '--repo', repo, '--json', 'title,body,labels')) as {
    title: string
    body: string
    labels: { name: string }[]
  }
  const blockers = await gh(
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
    for (const { repo, number } of references) {
      if (repo === null) continue
      blocks.push(describeTicket(`${repo}#${number}`, await fetchTicket(run, repo, number)))
    }
    return next({ ...e, context: [...(e.context ?? []), ...blocks] })
  })
}
