import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { LoopSnapshot } from '../types'
import { managerHome, readSnapshot } from './snapshot'

const PANE = 'loop-pane'
const REFRESH_MS = 2000
const YES = 'Yes'
const NO = 'No'

const EMPTY: LoopSnapshot = { inFlight: null, usage: null }
const snapshot = atom({ plugin: 'loop-pane', key: 'snapshot' } as const, EMPTY)

/** The manager scripts the buttons run, as `npm run <script>`; `confirm` is the question asked first, when there is one. */
const BUTTONS = [
  { key: 'halt', label: 'Halt', script: 'halt' },
  { key: 'resume', label: 'Resume', script: 'resume' },
  { key: 'stop', label: 'Stop', script: 'stop', confirm: 'Stop the morning loop?' },
] as const

export const register: Register = on => {
  let tick: { cancel(): void } | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'loop-pane', description: "Show the manager's morning loop in a pane" })
    return next(e)
  })

  on('command.run', { command: 'loop-pane' }, async $ => {
    const home = managerHome($.plugin.root)
    const refresh = async () => {
      const next = await readSnapshot({ read: path => $.fs.read(path), list: path => $.fs.list(path) }, home, new Date(await $.clock.now()))
      await update($, snapshot, () => next)
    }
    await refresh()
    await $.ui.open({ id: PANE, title: 'Morning loop' })
    tick?.cancel()
    tick = $.clock.every(REFRESH_MS, () => refresh())
    return { text: 'Loop pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { inFlight, usage } = await read($, snapshot)
    const home = managerHome($.plugin.root)

    return (
      <Box flexDirection="column">
        {inFlight === null ? (
          <Text dimColor>No invocation is running.</Text>
        ) : (
          <Box flexDirection="column">
            <Text>Invocation open since {inFlight.openedAt}</Text>
            {inFlight.runs.length === 0 && <Text dimColor>No run is in progress.</Text>}
            {inFlight.runs.map(run => (
              <Text>
                {run.repo}#{run.number} {run.kind}
              </Text>
            ))}
            {inFlight.freed.length > 0 && <Text>Freed entries:</Text>}
            {inFlight.freed.map(entry => (
              <Text>
                {entry.repo}#{entry.number}
              </Text>
            ))}
          </Box>
        )}
        {usage !== null && (
          <Text>
            5-hour spend: {usage.tokensUsed} of {usage.allowance} tokens
          </Text>
        )}
        <Box>
          {BUTTONS.map(button => (
            <Button
              key={button.key}
              onPress={async () => {
                if ('confirm' in button) {
                  const answer = await $.ui.ask(button.confirm, [YES, NO]).catch(() => NO)
                  if (answer !== YES) return
                }
                await $.process.run(['npm', 'run', '--silent', button.script], { cwd: home }).catch(() => undefined)
              }}
            >
              {button.label}
            </Button>
          ))}
        </Box>
      </Box>
    )
  })
}
