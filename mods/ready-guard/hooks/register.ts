import type { Register } from 'claude-code'

import { checkReadyLabel, isIssueRef, type IssueRef, type Tracker } from './guard'

/** The tracker as `gh` reads it, run on the host from the session's working directory. */
function ghTracker(run: (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>): Tracker {
  async function gh(...argv: string[]): Promise<string> {
    const { exitCode, stdout, stderr } = await run(['gh', ...argv])
    if (exitCode !== 0) throw new Error(stderr.trim() || `gh ${argv[0]} exited ${exitCode}`)
    return stdout
  }
  const split = (issue: IssueRef) => issue.split('#') as [string, string]

  return {
    async currentRepo() {
      return (await gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner')).trim()
    },
    async body(issue) {
      const [repo, number] = split(issue)
      return gh('issue', 'view', number, '--repo', repo, '--json', 'body', '--jq', '.body')
    },
    async linkedBlockers(issue) {
      const [repo, number] = split(issue)
      const out = await gh(
        'api',
        `repos/${repo}/issues/${number}/dependencies/blocked_by`,
        '--jq',
        '.[] | (.repository_url | sub(".*/repos/"; "")) + "#" + (.number | tostring)',
      )
      return out.split('\n').filter(isIssueRef)
    },
  }
}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = await checkReadyLabel(e.command, ghTracker(argv => $.process.run(argv)))
    if (verdict.kind === 'deny') return { deny: verdict.reason }
    if (verdict.kind === 'warn') $.ui.toast(verdict.warning)
    return next(e)
  })
}
