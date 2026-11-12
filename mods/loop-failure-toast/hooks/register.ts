import type { EngineInterface, Register } from 'claude-code'

import { failureKey, repeatingFailures, type FailureKey } from './failures'
import { managerHomeReader } from './manager-home/reader'

/** The manager home, as `src/adapters/manager-home.ts` resolves it: `SIDE_PROJECTS_MANAGER_HOME` when set, else the checkout, which the plugin sits two levels below (`<checkout>/mods/<name>`). The hooks run without `process`, so the shell is asked. */
async function managerHome($: EngineInterface): Promise<string> {
  const { stdout } = await $.process.run(['sh', '-c', 'printf "%s" "$SIDE_PROJECTS_MANAGER_HOME"'])
  return stdout || $.plugin.root.replace(/\/+$/, '').split('/').slice(0, -2).join('/')
}

/** How often the trigger log is read, in milliseconds. */
const POLL_MS = 5000

/** How many trigger-log lines are read: enough to span the invocations a repeat is judged over. */
const LOG_LINES = 500

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const reader = managerHomeReader({ read: path => $.fs.read(path), list: path => $.fs.list(path) }, await managerHome($))

    // The failures currently toasted for. One whose streak the log shows ended leaves the set, so it toasts
    // again if it starts again; one the window merely stops showing stays.
    let announced = new Set<FailureKey>()

    const refresh = async () => {
      const lines = await reader.recentTriggerLog(LOG_LINES)
      // An unreadable log is nothing known: keep what has been toasted.
      if (lines === undefined) return
      const { repeating, ended } = repeatingFailures(lines)
      for (const failure of repeating) {
        if (!announced.has(failureKey(failure))) {
          $.ui.toast(`${failure.repo} #${failure.number} keeps failing: ${failure.reason}`)
        }
      }
      announced = new Set([...announced].filter(key => !ended(key)).concat(repeating.map(failureKey)))
    }

    await refresh()
    $.clock.every(POLL_MS, () => void refresh())
    return next(e)
  })
}
