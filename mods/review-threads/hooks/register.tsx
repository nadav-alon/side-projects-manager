import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { PullRequestAction, PullRequestNumber } from './threads'
import {
  commentArgs,
  confirmationFor,
  parseDraftPullRequests,
  pullRequestLines,
  readArgs,
  repoSlug,
} from './threads'

const PANE = 'review-threads'
const TITLE = 'Review threads'
const YES = 'Yes'
const NO = 'No'

const pullRequests = atom({ plugin: 'review-threads', key: 'pullRequests' } as const, null)
const notice = atom({ plugin: 'review-threads', key: 'notice' } as const, '')

const BUTTONS: { action: PullRequestAction; label: string }[] = [
  { action: 'apply-review', label: 'Apply review' },
  { action: 'rebase', label: 'Rebase' },
]

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The part of the engine's `$.process` the reads and posts use. */
interface Shell {
  process: { run(command: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> }
}

/** The session repo, read from the checkout the session runs in. */
async function sessionRepo($: Shell) {
  const { exitCode, stdout, stderr } = await $.process.run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  if (exitCode !== 0) throw new Error(`gh repo view failed: ${stderr.trim()}`)
  return repoSlug(stdout.trim())
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'review-threads', description: 'Show draft pull requests and their open review threads in a pane' })
    return next(e)
  })

  on('command.run', { command: 'review-threads' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    await refresh($)
    return { text: 'Review threads pane opened.' }
  })

  /** Re-reads the tracker into the pane's state; a failure is shown in the pane, not thrown. */
  async function refresh($: Parameters<typeof update>[0] & Shell) {
    try {
      const { exitCode, stdout, stderr } = await $.process.run(['gh', ...readArgs(await sessionRepo($))])
      if (exitCode !== 0) throw new Error(`gh api failed: ${stderr.trim()}`)
      await update($, pullRequests, () => parseDraftPullRequests(stdout))
      await update($, notice, () => '')
    } catch (error) {
      await update($, notice, () => `Could not read the tracker: ${messageOf(error)}`)
    }
  }

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, pullRequests)
    const message = await read($, notice)

    const post = async (number: PullRequestNumber, action: PullRequestAction) => {
      const answer = await $.ui.ask(confirmationFor(action, number), [YES, NO]).catch(() => NO)
      if (answer !== YES) return
      try {
        const { exitCode, stderr } = await $.process.run(['gh', ...commentArgs(await sessionRepo($), number, action)])
        if (exitCode !== 0) throw new Error(stderr.trim())
        await update($, notice, () => `Posted /${action} on #${number}.`)
      } catch (error) {
        await update($, notice, () => `Posting /${action} on #${number} failed: ${messageOf(error)}`)
      }
    }

    return (
      <Box flexDirection="column">
        <Button key="refresh" onPress={() => refresh($)}>
          Refresh
        </Button>
        {message !== '' && <Text>{message}</Text>}
        {list === null && <Text dimColor>Not read yet.</Text>}
        {list?.length === 0 && <Text dimColor>No draft pull requests.</Text>}
        {list?.map(pr => (
          <Box flexDirection="column">
            {pullRequestLines(pr).map(line => (
              <Text>{line}</Text>
            ))}
            <Box>
              {BUTTONS.map(({ action, label }) => (
                <Button key={`${action}-${pr.number}`} onPress={() => post(pr.number, action)}>
                  {label}
                </Button>
              ))}
            </Box>
          </Box>
        ))}
      </Box>
    )
  })
}
