// A mod-side reader of the manager home: the journal, the state document, the budget document, the
// trigger log and the discoveries folder, read through the engine's file interface (`$.fs`).
//
// Every read answers `undefined` — "nothing known" — for a missing home, a missing file or a document
// that cannot be read as what it claims to be, and never throws, so a mod drawing from it stays blank
// instead of failing its hook. It is not itself a mod, and a mod cannot import it from outside its
// own folder: a mod carries a copy of `reader.ts` and `types.ts` in its `hooks/manager-home/`,
// kept byte-identical to these by `copies.test.ts`.

import {
  isIssueNumber,
  isProcessId,
  isRepoSlug,
  isReserveFraction,
  isTicketKind,
  isTokenCount,
  reserveFraction,
  tokenCount,
  type IssueNumber,
  type ProcessId,
  type RepoSlug,
  type ReserveFraction,
  type TicketKind,
  type TokenCount,
} from './types.ts'

/** The part of the engine's `$.fs` the reader uses. */
export interface HomeFs {
  read(path: string): Promise<string>
  list(path: string): Promise<readonly { name: string }[]>
}

/** A ticket, as the journal names one. */
export interface JournaledTicket {
  repo: RepoSlug
  number: IssueNumber
}

/** A run in progress, as the journal records one: its project, ticket and kind (`implementation`, `review`, …). */
export interface RunInProgress extends JournaledTicket {
  kind: TicketKind
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
  /** The runs in progress the open record names; empty when it names none or none can be read. */
  runs: RunInProgress[]
  /** The worked-today entries the open record names as freed from invocations that died; empty when none. */
  freed: JournaledTicket[]
}

/** The usage of the 5-hour window, and what the budget document allows of it. */
export interface FiveHourUsage {
  /**
   * What the manager's gate counts against the window: the session logs' usage since the block
   * opened, which includes the developer's interactive use, plus the manager's own runs recorded in
   * the state document since then. With no session logs to read, the own runs of the five hours up
   * to `now`.
   */
  tokensUsed: TokenCount
  allowance: TokenCount
  reserveFraction: ReserveFraction
  /** Whether `tokensUsed` already exceeds what the window may spend once its reserve is held back: the gate's own "reserve reached". */
  reserveReached: boolean
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

/** An ISO 8601 instant ends in a zone; the manager refuses an `observedResetAt` that does not. */
const HAS_ZONE = /(?:[Zz]|[+-]\d{2}:?\d{2})$/

/** The provider's price ratios to a fresh input token, as the manager weighs a session log line's usage. */
const INPUT_WEIGHT = 1
const CACHE_CREATION_WEIGHT = 1.25
const CACHE_READ_WEIGHT = 0.1
const OUTPUT_WEIGHT = 5

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

/**
 * Reads the manager home at `home` through `fs`. `sessionLogs` is the directory of Claude Code's
 * session logs, one folder per project holding `.jsonl` files; with it, `fiveHourUsage` counts the
 * developer's interactive use as the manager's gate does.
 */
export function managerHomeReader(fs: HomeFs, home: string, sessionLogs?: string): ManagerHomeReader {
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
      return {
        openedAt,
        pid,
        workedTodayEntries: workedTodayEntriesRecordedBy(state, openedAt, pid),
        runs: listOf(open.runs).flatMap(runInProgress),
        freed: listOf(open.freed).flatMap(journaledTicket),
      }
    },

    async fiveHourUsage(now) {
      const state = await readJson(fs, at('state.json'))
      const projects = isRecord(state) ? state.projects : undefined
      if (!isRecord(projects)) return undefined

      const budget = await readBudget(fs, at('budget.json'))
      if (budget === undefined) return undefined
      const { observedResetAt, ...figures } = budget

      const runs: OwnRun[] = []
      for (const project of Object.values(projects)) {
        if (!isRecord(project)) return undefined
        // The manager reads a project with no `runs` as having none.
        const projectRuns = project.runs ?? []
        if (!Array.isArray(projectRuns)) return undefined
        for (const run of projectRuns) {
          const when = isRecord(run) ? instant(run.at) : undefined
          const tokens = isRecord(run) ? run.tokensUsed : undefined
          if (when === undefined || typeof tokens !== 'number' || !isTokenCount(tokens)) return undefined
          runs.push({ at: when, tokensUsed: tokens })
        }
      }

      if (sessionLogs === undefined) {
        const since = now.getTime() - FIVE_HOURS_MS
        const own = runs.filter(run => run.at.getTime() > since && run.at.getTime() <= now.getTime())
        return withVerdict(tokenCount(sum(own)), figures)
      }

      const entries = await readLogEntries(fs, sessionLogs)
      if (entries === undefined) return undefined
      // A reset more than five hours ahead names a block that cannot be open yet; the manager refuses it.
      if (observedResetAt !== undefined && observedResetAt.getTime() - now.getTime() > FIVE_HOURS_MS) return undefined
      const openedAt = fiveHourBlockOpenedAt(entries, now, observedResetAt)
      const developer = openedAt === undefined ? 0 : roundedSum(entries.filter(entry => entry.at.getTime() >= openedAt.getTime()))
      const own = runs.filter(run => run.at.getTime() >= (openedAt ?? now).getTime())
      return withVerdict(tokenCount(developer + sum(own)), figures)
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

/** A run the state document records, reduced to what the window's spend needs. */
interface OwnRun {
  at: Date
  tokensUsed: number
}

/** One assistant line of a session log carrying usage; `weighted` is left unrounded so a window rounds once. */
interface LogEntry {
  at: Date
  weighted: number
}

/**
 * `tokensUsed` against `figures`, with the gate's verdict. The reserve is rounded up and held back
 * whole, as the gate's `spendableOf` does, so a fractional reserve never shrinks.
 */
function withVerdict(tokensUsed: TokenCount, figures: { allowance: TokenCount; reserveFraction: ReserveFraction }): FiveHourUsage {
  const spendable = figures.allowance - Math.ceil(figures.allowance * figures.reserveFraction)
  return { tokensUsed, ...figures, reserveReached: tokensUsed > spendable }
}

function sum(items: readonly { tokensUsed: number }[]): number {
  return items.reduce((total, item) => total + item.tokensUsed, 0)
}

function roundedSum(entries: readonly LogEntry[]): number {
  return Math.max(0, Math.round(entries.reduce((total, entry) => total + entry.weighted, 0)))
}

/**
 * Every usage-bearing line of every session log under `sessionLogs`, read as the manager's ledger
 * (`session-log-usage-ledger.ts`) reads them: lines that are not a well-formed assistant message with
 * usage are skipped. A folder or log that is missing is no entries; a failure of any other kind (a
 * permission error, say) leaves the usage `undefined` rather than a figure short of the gate's.
 */
async function readLogEntries(fs: HomeFs, sessionLogs: string): Promise<LogEntry[] | undefined> {
  const root = sessionLogs.replace(/\/+$/, '')
  try {
    const entries: LogEntry[] = []
    for (const project of await listIfPresent(fs, root)) {
      const files = await listIfPresent(fs, `${root}/${project.name}`)
      for (const file of files.filter(file => file.name.endsWith('.jsonl'))) {
        const text = await readIfPresent(fs, `${root}/${project.name}/${file.name}`)
        for (const line of (text ?? '').split('\n')) {
          const entry = logEntry(line)
          if (entry !== undefined) entries.push(entry)
        }
      }
    }
    return entries
  } catch {
    return undefined
  }
}

/** Whether `error` says the path is not there, as Node's `ENOENT` does. */
function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT' || String((error as Error | null)?.message ?? error).startsWith('ENOENT')
}

async function listIfPresent(fs: HomeFs, path: string): Promise<readonly { name: string }[]> {
  try {
    return await fs.list(path)
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

async function readIfPresent(fs: HomeFs, path: string): Promise<string | undefined> {
  try {
    return await fs.read(path)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

function logEntry(line: string): LogEntry | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line.trim())
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || parsed.type !== 'assistant') return undefined
  const at = instant(parsed.timestamp)
  const usage = isRecord(parsed.message) ? parsed.message.usage : undefined
  if (at === undefined || !isRecord(usage)) return undefined
  const { input_tokens: input, output_tokens: output } = usage
  if (typeof input !== 'number' || typeof output !== 'number') return undefined
  const field = (value: unknown) => (typeof value === 'number' ? value : 0)
  const weighted =
    input * INPUT_WEIGHT +
    output * OUTPUT_WEIGHT +
    field(usage.cache_creation_input_tokens) * CACHE_CREATION_WEIGHT +
    field(usage.cache_read_input_tokens) * CACHE_READ_WEIGHT
  return Number.isFinite(weighted) && weighted >= 0 ? { at, weighted } : undefined
}

/**
 * When the block open at `now` was opened: by the first message of a run of messages none of which
 * is 5 hours past the one that opened it. `undefined` when no block is open — none ever began, or
 * the last one has ended. `observedResetAt`, a boundary the developer read off the provider, is believed
 * ahead of the logs: one still to come states the open block outright; one already past drops the
 * messages before it from the inference.
 */
function fiveHourBlockOpenedAt(entries: readonly LogEntry[], now: Date, observedResetAt?: Date): Date | undefined {
  if (observedResetAt !== undefined && observedResetAt.getTime() > now.getTime()) {
    return new Date(observedResetAt.getTime() - FIVE_HOURS_MS)
  }
  const sorted = entries
    .filter(entry => observedResetAt === undefined || entry.at.getTime() >= observedResetAt.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime())
  let opened: Date | undefined
  for (const entry of sorted) {
    if (opened === undefined || entry.at.getTime() - opened.getTime() >= FIVE_HOURS_MS) opened = entry.at
  }
  return opened !== undefined && opened.getTime() + FIVE_HOURS_MS > now.getTime() ? opened : undefined
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function journaledTicket(value: unknown): JournaledTicket[] {
  if (!isRecord(value)) return []
  const { repo, number } = value
  if (typeof repo !== 'string' || !isRepoSlug(repo) || typeof number !== 'number' || !isIssueNumber(number)) return []
  return [{ repo, number }]
}

function runInProgress(value: unknown): RunInProgress[] {
  const ticket = journaledTicket(value)[0]
  const kind = isRecord(value) ? value.kind : undefined
  return ticket === undefined || typeof kind !== 'string' || !isTicketKind(kind) ? [] : [{ ...ticket, kind }]
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
/** The budget figures the 5-hour window is measured against, with the reset the developer observed, if any. */
interface BudgetFigures {
  allowance: TokenCount
  reserveFraction: ReserveFraction
  observedResetAt?: Date
}

async function readBudget(
  fs: HomeFs,
  file: string,
): Promise<BudgetFigures | undefined> {
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
  const observed = budget.observedResetAt
  if (observed === undefined) return { allowance, reserveFraction: reserve }
  if (typeof observed !== 'string' || !HAS_ZONE.test(observed)) return undefined
  const observedResetAt = instant(observed)
  return observedResetAt === undefined ? undefined : { allowance, reserveFraction: reserve, observedResetAt }
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
