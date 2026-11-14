// The numbers the reader hands back, branded as `src/ports` brands the same figures. A mod does not
// import `src/`, so each brand is declared here with its own guard and constructor.

declare const processIdBrand: unique symbol
declare const tokenCountBrand: unique symbol
declare const reserveFractionBrand: unique symbol
declare const repoSlugBrand: unique symbol
declare const issueNumberBrand: unique symbol
declare const issueUrlBrand: unique symbol

/** The OS process carrying out one invocation: a whole number above 0. */
export type ProcessId = number & { readonly [processIdBrand]: true }

/** A number of tokens: a whole number, 0 or greater. */
export type TokenCount = number & { readonly [tokenCountBrand]: true }

/** The share of a window held back for the developer: at least 0 and less than 1. */
export type ReserveFraction = number & { readonly [reserveFractionBrand]: true }

/** A GitHub repository, as `owner/repo`. */
export type RepoSlug = string & { readonly [repoSlugBrand]: true }

/** An issue's number: a whole number above 0. */
export type IssueNumber = number & { readonly [issueNumberBrand]: true }

/** An issue's web address: an `http(s)` URL whose path ends `/issues/<number>`. */
export type IssueUrl = string & { readonly [issueUrlBrand]: true }

/** The kinds of ticket the loop runs, as the manager's journal names them. */
export const TICKET_KINDS = ['implementation', 'review', 'apply-review', 'rebase', 'spec-review', 'ux-review'] as const

export type TicketKind = (typeof TICKET_KINDS)[number]

export function isProcessId(value: number): value is ProcessId {
  return Number.isSafeInteger(value) && value > 0
}

export function isTokenCount(value: number): value is TokenCount {
  return Number.isSafeInteger(value) && value >= 0
}

export function isReserveFraction(value: number): value is ReserveFraction {
  return Number.isFinite(value) && value >= 0 && value < 1
}

/** Narrows `value` to a `TokenCount`; only for a literal known to be one. */
export function tokenCount(value: number): TokenCount {
  if (!isTokenCount(value)) throw new TypeError(`Not a token count: ${value}`)
  return value
}

/** Narrows `value` to a `ReserveFraction`; only for a literal known to be one. */
export function reserveFraction(value: number): ReserveFraction {
  if (!isReserveFraction(value)) throw new TypeError(`Not a reserve fraction: ${value}`)
  return value
}

/** Whether `value` is shaped like `owner/repo`: two non-empty parts around one slash. */
export function isRepoSlug(value: string): value is RepoSlug {
  const parts = value.split('/')
  return parts.length === 2 && parts.every(part => /^[A-Za-z0-9._-]+$/.test(part))
}

export function isIssueNumber(value: number): value is IssueNumber {
  return Number.isSafeInteger(value) && value > 0
}

/** Whether `value` is an issue's address: an `http(s)` URL whose path ends `/issues/<number>`. */
export function isIssueUrl(value: string): value is IssueUrl {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (url.protocol === 'https:' || url.protocol === 'http:') && /\/issues\/\d+$/.test(url.pathname)
}

/** Narrows `value` to an `IssueUrl`, throwing if it is not one. */
export function issueUrl(value: string): IssueUrl {
  if (!isIssueUrl(value)) throw new TypeError(`Not an issue URL: ${value}`)
  return value
}

export function isTicketKind(value: string): value is TicketKind {
  return (TICKET_KINDS as readonly string[]).includes(value)
}

/** The kinds of discovery a run files, as the manager names them. */
export const DISCOVERY_KINDS = ['correction', 'prerequisite', 'clarification', 'suggestion'] as const

export type DiscoveryKind = (typeof DISCOVERY_KINDS)[number]

export function isDiscoveryKind(value: string): value is DiscoveryKind {
  return (DISCOVERY_KINDS as readonly string[]).includes(value)
}
