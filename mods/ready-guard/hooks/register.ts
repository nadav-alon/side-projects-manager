import type { Register } from 'claude-code'

import { checkReadyLabel, isIssueRef, issueParts, issueRef, optionalRepo, repoSlug, type Tracker } from './guard'
import { environmentRepo } from './target-repo/target'

/** The tracker as `gh` reads it, run on the host from the session's working directory. */
function ghTracker(run: (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>): Tracker {
  async function gh(...argv: string[]): Promise<string> {
    const { exitCode, stdout, stderr } = await run(['gh', ...argv])
    if (exitCode !== 0) throw new Error(stderr.trim() || `gh ${argv[0]} exited ${exitCode}`)
    return stdout
  }

  return {
    async currentRepo() {
      return repoSlug((await gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner')).trim())
    },
    environmentRepo() {
      return environmentRepo(run, optionalRepo)
    },
    async body(issue) {
      const { repo, number } = issueParts(issue)
      return gh('issue', 'view', String(number), '--repo', repo, '--json', 'body', '--jq', '.body')
    },
    async linkedBlockers(issue) {
      const { repo, number } = issueParts(issue)
      const out = await gh(
        'api',
        '--paginate',
        `repos/${repo}/issues/${number}/dependencies/blocked_by`,
        '--jq',
        '.[] | (.repository_url | sub(".*/repos/"; "")) + "#" + (.number | tostring)',
      )
      return out
        .split('\n')
        .map((line) => line.trim().toLowerCase())
        .filter(isIssueRef)
        .map((ref) => issueRef(ref))
    },
  }
}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = await checkReadyLabel(e.command, ghTracker(argv => $.process.run(argv)))
    if (verdict.kind === 'deny') return { deny: verdict.reason }
    const result = await next(e)
    if (verdict.kind === 'allow') return result
    // The toast reaches the human only; the context is what the model reads after the result.
    $.ui.toast(verdict.warning)
    return { ...result, context: [...(result.context ?? []), verdict.warning] }
  })
}
