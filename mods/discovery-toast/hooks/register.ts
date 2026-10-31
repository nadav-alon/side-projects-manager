import type { Register } from 'claude-code'

import { managerHomeReader } from './manager-home/reader'

/** The manager home: the plugin sits at `<home>/mods/<name>`, so the home is two levels up. */
function managerHome(pluginRoot: string): string {
  return pluginRoot.replace(/\/+$/, '').split('/').slice(0, -2).join('/')
}

/** How often the discoveries folder is read, in milliseconds. */
const POLL_MS = 5000

/** The status entry counting the pending discoveries and naming the newest; `undefined` clears it at zero. */
function pendingStatus(pending: number, newest: string | undefined): string | undefined {
  if (pending === 0) return undefined
  const count = `${pending} pending discover${pending === 1 ? 'y' : 'ies'}`
  return newest === undefined ? count : `${count} (newest: ${newest})`
}

/** The longest title shown whole; a longer one is cut to this many characters, ending in an ellipsis. */
const MAX_TITLE = 50

/** `title`, cut to `MAX_TITLE` characters and kept to one line. */
function oneLine(title: string): string {
  const line = title.replace(/\s+/g, ' ').trim()
  return line.length <= MAX_TITLE ? line : `${line.slice(0, MAX_TITLE - 1)}…`
}

/** What a discovery is called: its `<kind>: <title>`, or `undefined` when its file cannot be read as one. */
async function describe(read: (path: string) => Promise<string>, home: string, discovery: string) {
  try {
    const document: unknown = JSON.parse(await read(`${home}/discoveries/${discovery}`))
    if (typeof document === 'object' && document !== null) {
      const { kind, title } = document as Record<string, unknown>
      if (typeof kind === 'string' && typeof title === 'string') return `${kind}: ${oneLine(title)}`
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
    // The same discoveries in the order the session first saw them, so the last one still pending is the newest.
    const order: string[] = []
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
        if (!seen.has(discovery)) order.push(discovery)
        seen.add(discovery)
      }
      const newest = order.findLast(discovery => pending.includes(discovery))
      const name = newest === undefined ? undefined : ((await describe(read, home, newest)) ?? newest)
      $.ui.status(pendingStatus(pending.length, name))
    }

    await refresh()
    $.clock.every(POLL_MS, () => void refresh())
    return next(e)
  })
}
