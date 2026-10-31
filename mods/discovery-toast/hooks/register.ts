import type { Register } from 'claude-code'

import { managerHomeReader } from './manager-home/reader'

/** The manager home: the plugin sits at `<home>/mods/<name>`, so the home is two levels up. */
function managerHome(pluginRoot: string): string {
  return pluginRoot.replace(/\/+$/, '').split('/').slice(0, -2).join('/')
}

/** How often the discoveries folder is read, in milliseconds. */
const POLL_MS = 5000

/** The status entry naming the pending discoveries; `undefined` clears it at zero. */
function pendingStatus(pending: number): string | undefined {
  return pending === 0 ? undefined : `${pending} pending discover${pending === 1 ? 'y' : 'ies'}`
}

/** What a discovery is called: its `<kind>: <title>`, or `undefined` when its file cannot be read as one. */
async function describe(read: (path: string) => Promise<string>, home: string, discovery: string) {
  try {
    const document: unknown = JSON.parse(await read(`${home}/discoveries/${discovery}`))
    if (typeof document === 'object' && document !== null) {
      const { kind, title } = document as Record<string, unknown>
      if (typeof kind === 'string' && typeof title === 'string') return `${kind}: ${title}`
    }
  } catch {
    // Unreadable or unparseable: the caller names the discovery by its path.
  }
  return undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const home = managerHome($.plugin.root)
    const read = (path: string) => $.fs.read(path)
    const reader = managerHomeReader({ read, list: path => $.fs.list(path) }, home)

    // Every discovery the session has seen: the ones present at start are never toasted, and one
    // that goes and comes back is not toasted twice.
    const seen = new Set<string>()
    let isFirstRead = true

    const refresh = async () => {
      const pending = await reader.discoveries()
      // A folder that cannot be read at start had nothing present at start: the baseline is empty.
      const isBaseline = isFirstRead
      isFirstRead = false
      // An unreadable folder is nothing known: leave the status as it stands.
      if (pending === undefined) return
      for (const discovery of pending) {
        if (!seen.has(discovery) && !isBaseline) {
          const name = await describe(read, home, discovery)
          $.ui.toast(name ?? `New discovery: ${discovery}`)
        }
        seen.add(discovery)
      }
      $.ui.status(pendingStatus(pending.length))
    }

    await refresh()
    $.clock.every(POLL_MS, () => void refresh())
    return next(e)
  })
}
