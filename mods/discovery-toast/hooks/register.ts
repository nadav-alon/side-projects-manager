import type { Register } from 'claude-code'

import { managerHomeReader, type HomeFs } from './manager-home/reader'

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

/**
 * The longest title shown whole; a longer one is cut to this many characters, ending in an ellipsis.
 * With the longest kind, the count and the wrapper, the status entry then stays under 80 characters.
 */
const MAX_TITLE = 30

/** The kinds a discovery has; a file naming any other is not read as a discovery. */
const KINDS = ['correction', 'prerequisite', 'clarification', 'suggestion'] as const

type DiscoveryKind = (typeof KINDS)[number]

/** A discovery as its file holds it; `body` is absent when the file has none. */
interface Discovery {
  kind: DiscoveryKind
  title: string
  body?: string
}

type Read = (path: string) => Promise<string>

function isKind(value: unknown): value is DiscoveryKind {
  return KINDS.some(kind => kind === value)
}

/** The discovery at `discovery`, or `undefined` when its file cannot be read as one: the one rule for what counts as a discovery. */
async function parse(read: Read, home: string, discovery: string): Promise<Discovery | undefined> {
  try {
    const document: unknown = JSON.parse(await read(`${home}/discoveries/${discovery}`))
    if (typeof document === 'object' && document !== null) {
      const { kind, title, body } = document as Record<string, unknown>
      if (isKind(kind) && typeof title === 'string') {
        return typeof body === 'string' ? { kind, title, body } : { kind, title }
      }
    }
  } catch {
    // Unreadable or unparseable: the caller names the discovery by its path.
  }
  return undefined
}

/** `title`, cut to `MAX_TITLE` characters and kept to one line. */
function shortTitle(title: string): string {
  const line = title.replace(/\s+/g, ' ').trim()
  return line.length <= MAX_TITLE ? line : `${line.slice(0, MAX_TITLE - 1)}…`
}

/** What a discovery is called: its `<kind>: <title>`, or `undefined` when its file cannot be read as one. */
async function describe(read: Read, home: string, discovery: string) {
  const found = await parse(read, home, discovery)
  return found === undefined ? undefined : `${found.kind}: ${shortTitle(found.title)}`
}

/** A discovery path's run folder and the number its file is named by (`run-x/10.json` is run `run-x`, number 10). */
function position(discovery: string): { run: string; number: number } {
  const slash = discovery.lastIndexOf('/')
  return { run: discovery.slice(0, slash), number: Number.parseInt(discovery.slice(slash + 1), 10) }
}

/**
 * The newest of the `pending` discoveries, among those `seen` in the order first seen: a later-seen one
 * wins, except that within one run folder the higher file number does, since an agent files `1.json`,
 * `2.json`, … in order and a listing sorts `10.json` before `9.json`. Across run folders the order
 * first seen stands, as the listing carries no file times.
 */
function newestOf(seen: Iterable<string>, pending: string[]): string | undefined {
  let newest: string | undefined
  for (const discovery of seen) {
    if (!pending.includes(discovery)) continue
    if (newest !== undefined) {
      const [now, before] = [position(discovery), position(newest)]
      if (now.run === before.run && now.number < before.number) continue
    }
    newest = discovery
  }
  return newest
}

/** A discovery in full, as `/discoveries` lists it: its path, kind, title and body. */
function listing(path: string, discovery: Discovery): string {
  const heading = `${path} — ${discovery.kind}: ${discovery.title}`
  return discovery.body === undefined ? heading : `${heading}\n${discovery.body}`
}

/** `pending` with each run's files in the order they were filed, the runs staying in listed order. */
function inFilingOrder(pending: string[]): string[] {
  const runs = new Map<string, string[]>()
  for (const discovery of pending) {
    const { run } = position(discovery)
    runs.set(run, [...(runs.get(run) ?? []), discovery])
  }
  return [...runs.values()].flatMap(files => files.sort((a, b) => position(a).number - position(b).number))
}

/** The manager home the mod sits in, the file reading it goes through and its reader. */
function readerFor($: { plugin: { root: string }; fs: HomeFs }) {
  const home = managerHome($.plugin.root)
  const read: Read = path => $.fs.read(path)
  return { home, read, reader: managerHomeReader({ read, list: path => $.fs.list(path) }, home) }
}

/** Whether `home` is a manager home: one holding a journal or a state document. */
async function isManagerHome(read: Read, home: string): Promise<boolean> {
  for (const file of ['journal.json', 'state.json']) {
    try {
      await read(`${home}/${file}`)
      return true
    } catch {
      // Not there: try the next.
    }
  }
  return false
}

export const register: Register = on => {
  on('command.run', { command: 'discoveries' }, async $ => {
    const { home, read, reader } = readerFor($)
    const pending = await reader.discoveries()
    // No discoveries folder in a real home is none pending; outside a home there is no home to read.
    if (pending === undefined && !(await isManagerHome(read, home))) {
      return { text: 'There is no manager home to read discoveries from.' }
    }
    const entries: string[] = []
    for (const discovery of inFilingOrder(pending ?? [])) {
      const found = await parse(read, home, discovery)
      entries.push(found === undefined ? `${discovery} — could not be read or parsed as a discovery` : listing(discovery, found))
    }
    return { text: entries.length === 0 ? 'No pending discoveries.' : entries.join('\n\n') }
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'discoveries', description: 'List the pending discoveries in full' })
    const { home, read, reader } = readerFor($)

    // Every discovery the session has seen, in the order first seen: the ones present at start are
    // never toasted, and one that goes and comes back is not toasted twice.
    const seen = new Set<string>()
    // Each discovery's name once described: a filed discovery never changes, so its file is read once.
    const names = new Map<string, string | undefined>()
    const nameOf = async (discovery: string) => {
      if (!names.has(discovery)) names.set(discovery, await describe(read, home, discovery))
      return names.get(discovery)
    }
    let isFirstRead = true

    const refresh = async () => {
      const pending = await reader.discoveries()
      // A folder that cannot be read at start had nothing present at start: the baseline is empty.
      const isBaseline = isFirstRead
      isFirstRead = false
      // An unreadable folder is nothing known: leave the status as it stands.
      if (pending === undefined) return
      for (const discovery of pending) {
        if (seen.has(discovery)) continue
        seen.add(discovery)
        // The toast falls back to its usual "New discovery: <path>" wording; the status, which has no
        // such lead-in, shows the bare path.
        if (!isBaseline) $.ui.toast((await nameOf(discovery)) ?? `New discovery: ${discovery}`)
      }
      const newest = newestOf(seen, pending)
      const name = newest === undefined ? undefined : ((await nameOf(newest)) ?? newest)
      $.ui.status(pendingStatus(pending.length, name))
    }

    await refresh()
    $.clock.every(POLL_MS, () => void refresh())
    return next(e)
  })
}
