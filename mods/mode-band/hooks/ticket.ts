import type { IssueNumber, RepoSlug } from '../types'

const slugPattern = /^[\w.-]+\/[\w.-]+$/

/** Whether `value` is shaped like `owner/repo`. */
export function isRepoSlug(value: string): value is RepoSlug {
  return slugPattern.test(value)
}

/** Narrows `value` to a `RepoSlug`, throwing if it is not shaped like one. */
export function repoSlug(value: string): RepoSlug {
  if (!isRepoSlug(value)) throw new TypeError(`Not a repo slug, expected owner/repo: ${JSON.stringify(value)}`)
  return value
}

/** Whether `value` is shaped like an issue number: a positive integer. */
export function isIssueNumber(value: number): value is IssueNumber {
  return Number.isSafeInteger(value) && value > 0
}

/** Narrows `value` to an `IssueNumber`, throwing if it is not one. */
export function issueNumber(value: number): IssueNumber {
  if (!isIssueNumber(value)) throw new TypeError(`Not an issue number, expected a positive integer: ${value}`)
  return value
}
