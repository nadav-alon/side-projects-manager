import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { LoopSnapshot } from '../types'
import { isProcessId, type ProcessId } from './manager-home/types.ts'
import { compactCount, elapsed, issueUrlOf, localTime, percentOf } from './format'
import { managerHomeOf, resolveManagerHome } from './manager-home/home'
import { readSnapshot } from './snapshot'
import { sessionLogsFolder } from './session-logs'

const PANE = 'loop-pane'
const REFRESH_MS = 2000
const YES = 'Yes'
const NO = 'No'

const EMPTY: LoopSnapshot = { inFlight: null, usage: null, discoveries: [] }
const snapshot = atom({ plugin: 'loop-pane', key: 'snapshot' } as const, EMPTY)

/** What the last button press has to say — a failure, or word that nothing was done or that a start went out — or `null` when it has nothing (or none was pressed). */
const notice = atom({ plugin: 'loop-pane', key: 'notice' } as const, null as { text: string; failure: boolean } | null)

/** A process run, as `$.process.run` answers it. */
type Run = (argv: string[]) => Promise<{ exitCode: number; stderr: string }>

/** Whether a process is alive, read as the loop's own guard reads it: another user's process (`kill -0` fails with "not permitted") is alive, and a check that cannot run says nothing of the process, so it is not called dead. */
function processAlive(run: Run): (pid: ProcessId) => Promise<boolean> {
  return pid => run(['kill', '-0', String(pid)]).then(({ exitCode, stderr }) => exitCode === 0 || /not permitted/i.test(stderr), () => true)
}

/** The manager scripts the buttons run, as `npm run <script>`; `confirm` is the question asked first, when there is one. */
const BUTTONS = [
  { key: 'halt', label: 'Halt', script: 'halt' },
  { key: 'resume', label: 'Resume', script: 'resume' },
  { key: 'stop', label: 'Stop', script: 'stop', confirm: 'Stop the morning loop?' },
] as const

/**
 * Starts an invocation as the schedule's cron line does — env file sourced, the checkout fast-forwarded, output appended to `trigger.log` — detached so closing the pane does not stop it. The checkout is `$1`: the manager home may lie outside it, and the log goes there.
 * What can fail (the env file, the directory, `node` missing) is checked in the foreground so the press sees a non-zero exit; the pull and the run go in the background.
 * The env file is the one `scripts/install-triggers.sh` writes as `ENV_FILE`: keep the two paths the same.
 */
const START_SCRIPT = [
  'set -a; . "$HOME/.side-projects-manager.env" || exit; set +a',
  'cd "$1" || exit',
  'command -v node >/dev/null || { echo "node is not on PATH" >&2; exit 1; }',
  '(setsid nohup bash -c \'git pull --ff-only -q; node src/bin/morning-run.ts\' >> "${SIDE_PROJECTS_MANAGER_HOME:-$1}/trigger.log" 2>&1 < /dev/null &)',
].join('\n')

/** What a pane element holds: elements, or the `false` a skipped condition leaves behind. */
type Child = JSX.Element | false | null
type Children = Child | readonly Child[]

/** The pane's building blocks, as the host resolves them. */
type Parts = {
  Box: (props: { flexDirection?: 'column'; marginTop?: number; children?: Children }) => JSX.Element
  Text: (props: { bold?: boolean; underline?: boolean; children?: string }) => JSX.Element
}

/** A titled block of the pane, set apart from the one above it. */
function Section({ Box, Text, title, children }: Parts & { title: string; children?: Children }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold underline>{title}</Text>
      {children}
    </Box>
  )
}

/** The context a hook receives; `poll` is called from more than one hook. */
type HookContext = Parameters<Hook<'command.run'>>[0]

/** What the polling shares across hooks: the running tick, and the session whose `$` it writes through. */
type Polling = { tick: { cancel(): void } | undefined; sessionId: string | undefined }

/** Reads the manager home `home` into the pane's state through `$`, then keeps doing so every `REFRESH_MS`. */
async function poll($: HookContext, polling: Polling, home: string) {
  polling.sessionId = await $.session.id()
  // The config directory cannot change during a session, so the shell is asked once.
  const logs = sessionLogsFolder(argv => $.process.run(argv))
  const refresh = async () => {
    const next = await readSnapshot(
      { read: path => $.fs.read(path), list: path => $.fs.list(path) },
      processAlive(argv => $.process.run(argv)),
      home,
      new Date(await $.clock.now()),
      await logs,
    )
    await update($, snapshot, () => next)
  }
  await refresh()
  polling.tick?.cancel()
  polling.tick = $.clock.every(REFRESH_MS, () => refresh())
}

export const register: Register = on => {
  // The manager home cannot change during a session, so the shell is asked once.
  let homeOf: ReturnType<typeof resolveManagerHome> | undefined
  const polling: Polling = { tick: undefined, sessionId: undefined }
  const stopPolling = () => {
    polling.tick?.cancel()
    polling.tick = undefined
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'loop-pane', description: "Show the manager's morning loop in a pane" })
    return next(e)
  })

  on('command.run', { command: 'loop-pane' }, async $ => {
    await poll($, polling, await (homeOf ??= resolveManagerHome(argv => $.process.run(argv), $.plugin.root)))
    await $.ui.open({ id: PANE, title: 'Morning loop' })
    return { text: 'Loop pane opened.' }
  })

  // A /clear ends the session whose `$` the polling writes through, and its state with it: the pane is drawn
  // again, and that draw, holding the new session's `$`, restarts the polling there.
  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    if (e.reason === 'clear' && polling.tick !== undefined) $.ui.invalidate('ui.render')
    return ended
  })

  // The new session's first hook is where its polling starts again: waiting for a draw would leave the pane
  // stale if the host never redraws, so the pane asks for one itself.
  on('classic.SessionStart', async ($, e, next) => {
    const started = await next(e)
    if (e.source === 'clear' && polling.tick !== undefined) {
      polling.tick.cancel()
      await poll($, polling, await (homeOf ??= resolveManagerHome(argv => $.process.run(argv), $.plugin.root)))
      $.ui.invalidate('ui.render')
    }
    return started
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) stopPolling()
    return closed
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const home = await (homeOf ??= resolveManagerHome(argv => $.process.run(argv), $.plugin.root))
    const sessionId = await $.session.id()
    if (polling.tick !== undefined && sessionId !== polling.sessionId) {
      // A draw may not write state, so the restart waits for the draw to end.
      polling.sessionId = sessionId
      polling.tick.cancel()
      polling.tick = $.clock.after(0, () => void poll($, polling, home))
    }
    const { inFlight, usage, discoveries } = await read($, snapshot)
    const said = await read($, notice)
    const now = await $.clock.now()
    const checkout = managerHomeOf('', $.plugin.root)

    const parts = { Box, Text }
    const alive = processAlive(argv => $.process.run(argv))
    // Runs a command for a button, clearing the notice first and reporting a failure under `label`.
    const runReporting = async (label: string, argv: string[]) => {
      await update($, notice, () => null)
      try {
        const { exitCode, stdout, stderr } = await $.process.run(argv, { cwd: home })
        if (exitCode === 0) return true
        await update($, notice, () => ({ text: `${label} failed (exit ${exitCode}): ${(stderr || stdout).trim()}`, failure: true }))
      } catch (error) {
        await update($, notice, () => ({ text: `${label} failed: ${error instanceof Error ? error.message : String(error)}`, failure: true }))
      }
      return false
    }
    const running = inFlight !== null && inFlight.alive
    const opened = inFlight === null ? null : new Date(inFlight.openedAt)
    const span = opened === null ? '' : `${localTime(opened)} (${elapsed(opened, new Date(now))}`

    return (
      <Box flexDirection="column">
        <Section {...parts} title="Status">
          {inFlight === null ? (
            <Text dimColor>No invocation is running.</Text>
          ) : running ? (
            <Text>Running since {span})</Text>
          ) : (
            <Text>Opened at {span} ago), process died</Text>
          )}
          {inFlight !== null && !inFlight.alive && (
            <Text color="red">Process {inFlight.pid} has died without closing its record; nothing below is running.</Text>
          )}
        </Section>
        {inFlight !== null && (
          <Section {...parts} title="Current runs">
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
          <Section {...parts} title="5-hour spend">
            <Text>
              5h window: {compactCount(usage.tokensUsed)} / {compactCount(usage.spendable)} spendable tokens ({percentOf(usage.tokensUsed, usage.spendable)})
            </Text>
          </Section>
        )}
        <Section {...parts} title="Discoveries waiting on you">
          {discoveries === null && <Text dimColor>Recorded discoveries cannot be read.</Text>}
          {discoveries?.length === 0 && <Text dimColor>No discovery is waiting on you.</Text>}
          {discoveries?.map(discovery => (
            // One block per discovery, stacked, never side-by-side columns: a narrow pane squeezes
            // columns until `repo#n` and `[kind]` break mid-word, and a link split across lines is
            // no longer clickable.
            <Box key={`${discovery.repo}#${discovery.number}:${discovery.kind}:${discovery.title}`} flexDirection="column">
              <Text>
                <Text bold>{`${discovery.repo}#${discovery.number}`}</Text>
                {' '}
                <Text color="cyan">{`[${discovery.kind}]`}</Text>
              </Text>
              <Box paddingLeft={2} flexDirection="column">
                <Text>{discovery.title}</Text>
                <Text dimColor>{issueUrlOf(discovery.repo, discovery.number)}</Text>
              </Box>
            </Box>
          ))}
        </Section>
        <Section {...parts} title="Controls">
          {said !== null && (said.failure ? <Text color="red">{said.text}</Text> : <Text>{said.text}</Text>)}
          <Box gap={1}>
            {BUTTONS.map(button => (
              <Button
                key={button.key}
                onPress={async () => {
                  if ('confirm' in button) {
                    const answer = await $.ui.ask(button.confirm, [YES, NO]).catch(() => NO)
                    if (answer !== YES) return
                  }
                  await runReporting(button.label, ['npm', 'run', '--silent', button.script])
                }}
              >
                {button.label}
              </Button>
            ))}
            <Button
              key="start"
              onPress={async () => {
                await update($, notice, () => null)
                // The loop's own guard: a lease file naming a live process, or a takeover in progress.
                const holder = Number.parseInt(await $.fs.read(`${home}/invocation.lease`).catch(() => ''), 10)
                const takeover = await $.fs.read(`${home}/invocation.lease.takeover`).then(() => true, () => false)
                if (takeover || (isProcessId(holder) && (await alive(holder)))) {
                  await update($, notice, () => ({ text: 'An invocation is already running.', failure: false }))
                  return
                }
                if (await runReporting('Start now', ['bash', '-c', START_SCRIPT, 'start', checkout])) {
                  await update($, notice, () => ({ text: 'Started an invocation.', failure: false }))
                }
              }}
            >
              Start now
            </Button>
            <Button
              key="close"
              onPress={async () => {
                // In the test kit a plugin's own ui.close call does not reach its ui.close hook, so polling stops here too.
                stopPolling()
                await $.ui.close({ id: PANE })
              }}
            >
              Close
            </Button>
          </Box>
        </Section>
      </Box>
    )
  })
}
