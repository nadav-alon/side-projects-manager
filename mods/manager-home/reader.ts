// A mod-side reader of the manager home: the journal, the state document, the budget document, the
// trigger log and the discoveries folder, read through the engine's file interface (`$.fs`).
//
// Every read answers `undefined` — "nothing known" — for a missing home, a missing file or a document
// that cannot be read as what it claims to be, and never throws, so a mod drawing from it stays blank
// instead of failing its hook. It is not itself a mod; any mod's hooks import it.

/** The part of the engine's `$.fs` the reader uses. */
export interface HomeFs {
  read(path: string): Promise<string>
  list(path: string): Promise<readonly { name: string }[]>
}

/** The invocation the journal records as still open. */
export interface InFlightInvocation {
  openedAt: Date
  pid: number
  /** Tickets the state document's worked-today record names this invocation as having selected. */
  iterations: number
}

/** The usage of the 5-hour window, and what the budget document allows of it. */
export interface FiveHourUsage {
  /** Tokens the manager's own runs recorded in the state document over the five hours up to `now`. */
  tokensUsed: number
  allowance: number
  reserveFraction: number
}

/** The manager's default 5-hour allowance and reserve, for a budget document that names neither. */
export const DEFAULT_FIVE_HOUR_ALLOWANCE = 15_000_000
export const DEFAULT_FIVE_HOUR_RESERVE_FRACTION = 0

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000

/** How many lines of the trigger log `recentTriggerLog` returns unless told otherwise. */
export const DEFAULT_TRIGGER_LOG_LINES = 20

export interface ManagerHomeReader {
  /** The newest journal record with no `closedAt`, or `undefined` when none is open or the journal is unreadable. */
  inFlightInvocation(): Promise<InFlightInvocation | undefined>
  /** The 5-hour window's usage at `now`, with the budget's allowance and reserve fraction. */
  fiveHourUsage(now: Date): Promise<FiveHourUsage | undefined>
  /** The last `limit` non-empty lines of the trigger log, oldest first; `undefined` when there is no log. */
  recentTriggerLog(limit?: number): Promise<string[] | undefined>
  /** The names in the discoveries folder, sorted; `undefined` when it cannot be listed. */
  discoveries(): Promise<string[] | undefined>
}

/** Reads the manager home at `home` through `fs`. */
export function managerHomeReader(fs: HomeFs, home: string): ManagerHomeReader {
  const at = (name: string) => `${home.replace(/\/+$/, '')}/${name}`

  return {
    async inFlightInvocation() {
      const journal = await readJson(fs, at('journal.json'))
      const records = isRecord(journal) ? journal.records : undefined
      if (!Array.isArray(records)) return undefined

      const open = records.filter(record => isRecord(record) && record.closedAt === undefined).at(-1)
      if (!isRecord(open)) return undefined
      const openedAt = instant(open.openedAt)
      const pid = open.process
      if (openedAt === undefined || typeof pid !== 'number' || !Number.isInteger(pid)) return undefined

      const state = await readJson(fs, at('state.json'))
      return { openedAt, pid, iterations: iterationsRecordedBy(state, openedAt, pid) }
    },

    async fiveHourUsage(now) {
      const state = await readJson(fs, at('state.json'))
      const projects = isRecord(state) ? state.projects : undefined
      if (!isRecord(projects)) return undefined

      const budget = await readJson(fs, at('budget.json'), true)
      if (budget === null) return undefined
      const allowance = budgetNumber(budget, 'fiveHourAllowance', DEFAULT_FIVE_HOUR_ALLOWANCE, n => n > 0)
      const reserveFraction = budgetNumber(
        budget,
        'fiveHourReserveFraction',
        DEFAULT_FIVE_HOUR_RESERVE_FRACTION,
        n => n >= 0 && n < 1,
      )
      if (allowance === undefined || reserveFraction === undefined) return undefined

      const since = now.getTime() - FIVE_HOURS_MS
      let tokensUsed = 0
      for (const project of Object.values(projects)) {
        const runs = isRecord(project) ? project.runs : undefined
        if (!Array.isArray(runs)) return undefined
        for (const run of runs) {
          const when = isRecord(run) ? instant(run.at) : undefined
          const tokens = isRecord(run) ? run.tokensUsed : undefined
          if (when === undefined || typeof tokens !== 'number') return undefined
          if (when.getTime() > since && when.getTime() <= now.getTime()) tokensUsed += tokens
        }
      }
      return { tokensUsed, allowance, reserveFraction }
    },

    async recentTriggerLog(limit = DEFAULT_TRIGGER_LOG_LINES) {
      const text = await attempt(() => fs.read(at('trigger.log')))
      if (text === undefined) return undefined
      const lines = text.split('\n').filter(line => line.trim() !== '')
      return limit > 0 ? lines.slice(-limit) : []
    },

    async discoveries() {
      const entries = await attempt(() => fs.list(at('discoveries')))
      return entries?.map(entry => entry.name).sort()
    },
  }
}

/** How many worked-today entries `state` records as selected by the invocation opened at `openedAt` by `pid`. */
function iterationsRecordedBy(state: unknown, openedAt: Date, pid: number): number {
  const tickets = isRecord(state) && isRecord(state.workedToday) ? state.workedToday.tickets : undefined
  if (!Array.isArray(tickets)) return 0
  return tickets.filter(ticket => {
    const by = isRecord(ticket) ? ticket.recordedBy : undefined
    return isRecord(by) && by.process === pid && instant(by.openedAt)?.getTime() === openedAt.getTime()
  }).length
}

/**
 * A numeric budget field: `fallback` when the document does not name it, `undefined` when it names
 * something `valid` refuses. A document that is not an object is an empty one.
 */
function budgetNumber(
  budget: unknown,
  field: string,
  fallback: number,
  valid: (n: number) => boolean,
): number | undefined {
  const value = isRecord(budget) ? budget[field] : undefined
  if (value === undefined) return fallback
  return typeof value === 'number' && valid(value) ? value : undefined
}

/**
 * The parsed document at `file`. `undefined` when it is missing or garbled; with `absentIsEmpty`, a
 * missing one reads as an empty document (`{}`) while a garbled one reads as `null`.
 */
async function readJson(fs: HomeFs, file: string, absentIsEmpty = false): Promise<unknown> {
  const text = await attempt(() => fs.read(file))
  if (text === undefined) return absentIsEmpty ? {} : undefined
  try {
    return JSON.parse(text)
  } catch {
    return absentIsEmpty ? null : undefined
  }
}

async function attempt<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read()
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function instant(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? undefined : at
}
