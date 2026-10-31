// Reads the failures the manager's trigger log names, and finds the ones that repeat across
// consecutive invocations. The log's lines are `Invocation started.` and
// `Failed <owner/repo> #<n>: <reason>.` (`src/adapters/terminal-progress.ts`).

import { isIssueNumber, isRepoSlug, type IssueNumber, type RepoSlug } from './manager-home/types.ts'

/** How many consecutive invocations must show a failure before it counts as repeating. */
export const REPEAT_THRESHOLD = 3

/** A failed iteration, as the trigger log names it. */
export interface LoopFailure {
  repo: RepoSlug
  number: IssueNumber
  reason: string
}

declare const failureKeyBrand: unique symbol

/** What makes two failures the same, as `failureKey` writes it. */
export type FailureKey = string & { readonly [failureKeyBrand]: true }

const INVOCATION_STARTED = 'Invocation started.'
const FAILED = /^Failed (\S+) #(\d+): (.+)\.$/

/** The failure a log line names, or `undefined` when it names none. */
export function parseFailure(line: string): LoopFailure | undefined {
  const match = FAILED.exec(line.trim())
  if (match === null) return undefined
  const [, repo, number, reason] = match
  const issue = Number(number)
  if (!isRepoSlug(repo!) || !isIssueNumber(issue)) return undefined
  return { repo, number: issue, reason: reason! }
}

/** What makes two failures the same: the same ticket failing for the same reason. */
export function failureKey(failure: LoopFailure): FailureKey {
  return JSON.stringify([failure.repo, failure.number, failure.reason]) as FailureKey
}

/**
 * What `lines` hold of the failures: each invocation's failure keys, oldest first, and every
 * failure by its key. Lines before the first invocation marker belong to an invocation whose start
 * the log no longer holds, and are left out of the invocations.
 */
function readFailures(lines: readonly string[]) {
  const invocations: Set<FailureKey>[] = []
  const failures = new Map<FailureKey, LoopFailure>()
  for (const line of lines) {
    if (line.trim() === INVOCATION_STARTED) {
      invocations.push(new Set())
      continue
    }
    const failure = parseFailure(line)
    if (failure === undefined) continue
    const key = failureKey(failure)
    failures.set(key, failure)
    invocations.at(-1)?.add(key)
  }
  return { invocations, failures }
}

/** The failures that repeat, and which failures' streaks `lines` show ended. */
export interface Repeats {
  repeating: LoopFailure[]
  /** Whether the latest complete invocation, one a later one has followed, ran without `key`. */
  ended: (key: FailureKey) => boolean
}

/**
 * The failures that repeat: those named by each of `threshold` consecutive invocations ending at
 * the latest, or ending just before it — the latest may still be running, whatever it has logged
 * so far, which does not end a streak. They come in the order the log first names them.
 *
 * A streak is `ended` only by a complete invocation that ran without it. A log too short to show
 * the whole streak proves nothing, so it does not end one.
 */
export function repeatingFailures(lines: readonly string[], threshold = REPEAT_THRESHOLD): Repeats {
  const { invocations, failures } = readFailures(lines)
  const windows = [invocations.slice(-threshold), invocations.slice(-threshold - 1, -1)]
  const repeating = [...failures]
    .filter(([key]) => windows.some(window => window.length === threshold && window.every(names => names.has(key))))
    .map(([, failure]) => failure)
  const lastComplete = invocations.at(-2)
  return { repeating, ended: key => lastComplete !== undefined && !lastComplete.has(key) }
}
