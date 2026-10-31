import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { LoopSnapshot } from '../types'
import { compactCount, elapsed, localTime, percentOf } from './format'
import { managerHome, readSnapshot } from './snapshot'

const PANE = 'loop-pane'
const REFRESH_MS = 2000
const YES = 'Yes'
const NO = 'No'

const EMPTY: LoopSnapshot = { inFlight: null, usage: null }
const snapshot = atom({ plugin: 'loop-pane', key: 'snapshot' } as const, EMPTY)

/** What the last button press came to when it did not succeed, or `null` when it did (or none was pressed). */
const notice = atom({ plugin: 'loop-pane', key: 'notice' } as const, null as string | null)

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
      const next = await readSnapshot(
        { read: path => $.fs.read(path), list: path => $.fs.list(path) },
        // A check that cannot run says nothing of the process, so it is not called dead.
        pid => $.process.run(['kill', '-0', String(pid)]).then(({ exitCode }) => exitCode === 0, () => true),
        home,
        new Date(await $.clock.now()),
      )
      await update($, snapshot, () => next)
    }
    await refresh()
    await $.ui.open({ id: PANE, title: 'Morning loop' })
    tick?.cancel()
    tick = $.clock.every(REFRESH_MS, () => refresh())
    return { text: 'Loop pane opened.' }
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) {
      tick?.cancel()
      tick = undefined
    }
    return closed
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { inFlight, usage } = await read($, snapshot)
    const failure = await read($, notice)
    const now = await $.clock.now()
    const home = managerHome($.plugin.root)

    const Section = ({ title, children }: { title: string; children?: unknown }) => (
      <Box flexDirection="column" marginTop={1}>
        <Text bold underline>{title}</Text>
        {children as never}
      </Box>
    )
    const running = inFlight !== null && inFlight.alive

    return (
      <Box flexDirection="column">
        <Section title="Status">
          {inFlight === null ? (
            <Text dimColor>No invocation is running.</Text>
          ) : (
            <Text>Running since {localTime(new Date(inFlight.openedAt))} ({elapsed(now - Date.parse(inFlight.openedAt))})</Text>
          )}
          {inFlight !== null && !inFlight.alive && (
            <Text color="red">Process {inFlight.pid} has died without closing its record; nothing below is running.</Text>
          )}
        </Section>
        {inFlight !== null && (
          <Section title="Current runs">
            {running && inFlight.runs.length === 0 && <Text dimColor>No run is in progress.</Text>}
            {running && inFlight.runs.map(run => (
              <Box gap={1}>
                <Text bold>Run:</Text>
                <Text>
                  {run.repo}#{run.number}
                </Text>
                <Text color="cyan">[{run.kind}]</Text>
              </Box>
            ))}
            {inFlight.freed.length > 0 && <Text>Freed entries:</Text>}
            {inFlight.freed.map(entry => (
              <Text>
                {entry.repo}#{entry.number}
              </Text>
            ))}
          </Section>
        )}
        {usage !== null && (
          <Section title="5-hour spend">
            <Text>
              5-hour spend of the loop's own runs: {compactCount(usage.tokensUsed)} / {compactCount(usage.spendable)} spendable tokens ({percentOf(usage.tokensUsed, usage.spendable)})
            </Text>
          </Section>
        )}
        <Section title="Controls">
          {failure !== null && <Text color="red">{failure}</Text>}
          <Box gap={1}>
            {BUTTONS.map(button => (
              <Button
                key={button.key}
                onPress={async () => {
                  if ('confirm' in button) {
                    const answer = await $.ui.ask(button.confirm, [YES, NO]).catch(() => NO)
                    if (answer !== YES) return
                  }
                  await update($, notice, () => null)
                  try {
                    const { exitCode, stdout, stderr } = await $.process.run(['npm', 'run', '--silent', button.script], { cwd: home })
                    if (exitCode !== 0) {
                      await update($, notice, () => `${button.label} failed (exit ${exitCode}): ${(stderr || stdout).trim()}`)
                    }
                  } catch (error) {
                    await update($, notice, () => `${button.label} failed: ${error instanceof Error ? error.message : String(error)}`)
                  }
                }}
              >
                {button.label}
              </Button>
            ))}
          </Box>
        </Section>
      </Box>
    )
  })
}
