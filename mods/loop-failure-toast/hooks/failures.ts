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

const INVOCATION_STARTED = 'Invocation started.'
const FAILED = /^Failed (\S+) #(\d+): (.+)\.$/

/** The failure a log line names, or `undefined` when it names none. */
export function parseFailure(line: string): LoopFailure | undefined {
  const match = FAILED.exec(line.trim())
  if (match === null) return undefined
  const [, repo, number, reason] = match
  if (!isRepoSlug(repo!) || !isIssueNumber(Number(number))) return undefined
  return { repo: repo, number: Number(number) as IssueNumber, reason: reason! }
}

/** What makes two failures the same: the same ticket failing for the same reason. */
export function failureKey(failure: LoopFailure): string {
  return JSON.stringify([failure.repo, failure.number, failure.reason])
}

/**
 * The failures of each invocation in `lines`, oldest first, as keys. Lines before the first
 * invocation marker belong to an invocation whose start the log no longer holds, and are left out.
 */
function failuresByInvocation(lines: readonly string[]): Set<string>[] {
  const invocations: Set<string>[] = []
  for (const line of lines) {
    if (line.trim() === INVOCATION_STARTED) {
      invocations.push(new Set())
      continue
    }
    const failure = parseFailure(line)
    if (failure !== undefined) invocations.at(-1)?.add(failureKey(failure))
  }
  return invocations
}

/**
 * The failures that repeat: those named by each of `threshold` consecutive invocations ending at
 * the latest, or ending just before it — the latest may still be running and not yet have failed,
 * which does not end a streak. They come in the order the log first names them.
 */
export function repeatingFailures(lines: readonly string[], threshold = REPEAT_THRESHOLD): LoopFailure[] {
  const invocations = failuresByInvocation(lines)
  const windows = [invocations.slice(-threshold), invocations.slice(-threshold - 1, -1)]
  const failures = new Map<string, LoopFailure>()
  for (const line of lines) {
    const failure = parseFailure(line)
    if (failure !== undefined) failures.set(failureKey(failure), failure)
  }
  return [...failures]
    .filter(([key]) => windows.some(window => window.length === threshold && window.every(names => names.has(key))))
    .map(([, failure]) => failure)
}
