// A mod-side reader of the manager home: the journal, the state document, the budget document, the
// trigger log and the discoveries folder, read through the engine's file interface (`$.fs`).
//
// Every read answers `undefined` — "nothing known" — for a missing home, a missing file or a document
// that cannot be read as what it claims to be, and never throws, so a mod drawing from it stays blank
// instead of failing its hook. It is not itself a mod, and a mod cannot import it from outside its
// own folder: a mod carries a copy of `reader.ts` and `types.ts` in its `hooks/manager-home/`,
// kept byte-identical to these by `copies.test.ts`.

import {
  isProcessId,
  isReserveFraction,
  isTokenCount,
  reserveFraction,
  tokenCount,
  type ProcessId,
  type ReserveFraction,
  type TokenCount,
} from './types.ts'

/** The part of the engine's `$.fs` the reader uses. */
export interface HomeFs {
  read(path: string): Promise<string>
  list(path: string): Promise<readonly { name: string }[]>
}

/** The invocation the journal records as still open. */
export interface InFlightInvocation {
  openedAt: Date
  pid: ProcessId
  /**
   * Worked-today entries the state document names this invocation as having recorded. Most entries
   * come off the record when their iteration ends, so this is a lower bound on the iterations so far.
   */
  workedTodayEntries: number
}

/** The usage of the 5-hour window, and what the budget document allows of it. */
export interface FiveHourUsage {
  /** Tokens the manager's own runs recorded in the state document over the five hours up to `now`. */
  tokensUsed: TokenCount
  allowance: TokenCount
  reserveFraction: ReserveFraction
}

/** The manager's default 5-hour allowance and reserve, for a budget document that names neither. */
export const DEFAULT_FIVE_HOUR_ALLOWANCE = tokenCount(15_000_000)
export const DEFAULT_FIVE_HOUR_RESERVE_FRACTION = reserveFraction(0)

/** The fields the manager's budget document may name; it refuses any other. */
const BUDGET_FIELDS: readonly string[] = [
  'fiveHourAllowance',
  'weeklyAllowance',
  'reserveFraction',
  'fiveHourReserveFraction',
  'spendCeiling',
  'maxConcurrentIterations',
  'sizes',
  'kinds',
  'unsizedCountsAs',
  'observedResetAt',
]

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000

/** How many lines of the trigger log `recentTriggerLog` returns unless told otherwise. */
export const DEFAULT_TRIGGER_LOG_LINES = 20

export interface ManagerHomeReader {
  /** The newest journal record with no `closedAt`, or `undefined` when none is open or the journal is unreadable. */
  inFlightInvocation(): Promise<InFlightInvocation | undefined>
  /**
   * The 5-hour window's usage at `now`, with the budget's allowance and reserve fraction. A missing
   * state document is nothing known, not 0 tokens: the manager reads it as "worked nothing yet", but
   * a mod cannot tell that from a home it cannot see, and should stay blank.
   */
  fiveHourUsage(now: Date): Promise<FiveHourUsage | undefined>
  /** The last `limit` non-empty lines of the trigger log, oldest first; `undefined` when there is no log. */
  recentTriggerLog(limit?: number): Promise<string[] | undefined>
  /**
   * The discovery files of the runs with a discoveries directory open, as `<run directory>/<file>`,
   * sorted; `undefined` when the discoveries folder cannot be listed. The manager makes one directory
   * per run under it and removes it once the run's discoveries are read, so this is often empty.
   */
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
      if (openedAt === undefined || typeof pid !== 'number' || !isProcessId(pid)) return undefined

      const state = await readJson(fs, at('state.json'))
      return { openedAt, pid, workedTodayEntries: workedTodayEntriesRecordedBy(state, openedAt, pid) }
    },

    async fiveHourUsage(now) {
      const state = await readJson(fs, at('state.json'))
      const projects = isRecord(state) ? state.projects : undefined
      if (!isRecord(projects)) return undefined

      const budget = await readBudget(fs, at('budget.json'))
      if (budget === undefined) return undefined

      const since = now.getTime() - FIVE_HOURS_MS
      let used = 0
      for (const project of Object.values(projects)) {
        if (!isRecord(project)) return undefined
        // The manager reads a project with no `runs` as having none.
        const runs = project.runs ?? []
        if (!Array.isArray(runs)) return undefined
        for (const run of runs) {
          const when = isRecord(run) ? instant(run.at) : undefined
          const tokens = isRecord(run) ? run.tokensUsed : undefined
          if (when === undefined || typeof tokens !== 'number' || !isTokenCount(tokens)) return undefined
          if (when.getTime() > since && when.getTime() <= now.getTime()) used += tokens
        }
      }
      return { tokensUsed: tokenCount(used), ...budget }
    },

    async recentTriggerLog(limit = DEFAULT_TRIGGER_LOG_LINES) {
      const text = await attempt(() => fs.read(at('trigger.log')))
      if (text === undefined) return undefined
      const lines = text.split('\n').filter(line => line.trim() !== '')
      return limit > 0 ? lines.slice(-limit) : []
    },

    async discoveries() {
      const runs = await attempt(() => fs.list(at('discoveries')))
      if (runs === undefined) return undefined
      const files: string[] = []
      for (const run of runs) {
        const inRun = await attempt(() => fs.list(at(`discoveries/${run.name}`)))
        for (const file of inRun ?? []) files.push(`${run.name}/${file.name}`)
      }
      return files.sort()
    },
  }
}

/** How many worked-today entries `state` records as recorded by the invocation opened at `openedAt` by `pid`. */
function workedTodayEntriesRecordedBy(state: unknown, openedAt: Date, pid: ProcessId): number {
  const tickets = isRecord(state) && isRecord(state.workedToday) ? state.workedToday.tickets : undefined
  if (!Array.isArray(tickets)) return 0
  return tickets.filter(ticket => {
    const by = isRecord(ticket) ? ticket.recordedBy : undefined
    return isRecord(by) && by.process === pid && instant(by.openedAt)?.getTime() === openedAt.getTime()
  }).length
}

/**
 * The 5-hour figures of the budget document at `file`, read as the manager reads it: a missing
 * document is the default budget; a garbled one, one naming a field the manager does not know, or one
 * with a figure the manager refuses is `undefined`.
 */
async function readBudget(
  fs: HomeFs,
  file: string,
): Promise<{ allowance: TokenCount; reserveFraction: ReserveFraction } | undefined> {
  const text = await attempt(() => fs.read(file))
  if (text === undefined) {
    return { allowance: DEFAULT_FIVE_HOUR_ALLOWANCE, reserveFraction: DEFAULT_FIVE_HOUR_RESERVE_FRACTION }
  }
  let budget: unknown
  try {
    budget = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(budget) || Object.keys(budget).some(field => !BUDGET_FIELDS.includes(field))) return undefined

  const allowance = budget.fiveHourAllowance ?? DEFAULT_FIVE_HOUR_ALLOWANCE
  const reserve = budget.fiveHourReserveFraction ?? DEFAULT_FIVE_HOUR_RESERVE_FRACTION
  if (typeof allowance !== 'number' || !isTokenCount(allowance) || allowance <= 0) return undefined
  if (typeof reserve !== 'number' || !isReserveFraction(reserve)) return undefined
  return { allowance, reserveFraction: reserve }
}

/** The parsed document at `file`; `undefined` when it is missing or garbled. */
async function readJson(fs: HomeFs, file: string): Promise<unknown> {
  const text = await attempt(() => fs.read(file))
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
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
