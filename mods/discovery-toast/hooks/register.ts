import type { Register } from 'claude-code'

import { managerHomeReader } from './manager-home/reader'

/** How often the discoveries folder is read, in milliseconds. */
const POLL_MS = 5000

/** The status entry naming the pending discoveries; `undefined` clears it at zero. */
function pendingStatus(pending: number): string | undefined {
  return pending === 0 ? undefined : `${pending} pending discover${pending === 1 ? 'y' : 'ies'}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // The mod sits at `<manager home>/mods/<mod>`.
    const reader = managerHomeReader({ read: path => $.fs.read(path), list: path => $.fs.list(path) }, `${$.plugin.root}/../..`)

    const refresh = async () => {
      const pending = await reader.discoveries()
      // An unreadable folder is nothing known: leave the status as it stands.
      if (pending === undefined) return
      $.ui.status(pendingStatus(pending.length))
    }

    await refresh()
    $.clock.every(POLL_MS, () => void refresh())
    return next(e)
  })
}
