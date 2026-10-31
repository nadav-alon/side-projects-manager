declare const repoSlugBrand: unique symbol
declare const issueNumberBrand: unique symbol
declare const issueRefBrand: unique symbol

/** A GitHub repository as `owner/repo`. */
export type RepoSlug = string & { readonly [repoSlugBrand]: true }

/** The number a ticket is known by in its tracker: a positive integer. */
export type IssueNumber = number & { readonly [issueNumberBrand]: true }

/** A ticket as `owner/repo#n`; values enter through `issueRef` or `isIssueRef`. */
export type IssueRef = string & { readonly [issueRefBrand]: true }

/** A ticket a prompt names; `repo` is null for a bare `#n`, which means the session's repo. */
export type Reference = { repo: RepoSlug | null; number: IssueNumber }

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

const issueRefPattern = /^[\w.-]+\/[\w.-]+#[1-9]\d*$/

/** Whether `value` is shaped like `owner/repo#n`. */
export function isIssueRef(value: string): value is IssueRef {
  return issueRefPattern.test(value)
}

/** The one way a ticket is written as `owner/repo#n`. */
export function issueRef(repo: RepoSlug, number: IssueNumber): IssueRef {
  return `${repo}#${number}` as IssueRef
}

// A reference is `owner/repo#n`; the lookbehind keeps a bare `#n` from matching inside a word or a path.
// The harness writes a pasted image into the prompt as `[Image #n]`; that `#n` numbers the image, not a ticket.
const imagePlaceholderPattern = /\[Image #\d+\]/g

const referencePattern = /(?<![\w/.-])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g

/** The tickets `text` names, each once, in the order they first appear. */
export function referencesIn(text: string): Reference[] {
  const seen = new Set<string>()
  const found: Reference[] = []
  for (const [, slug, digits] of text.replace(imagePlaceholderPattern, ' ').matchAll(referencePattern)) {
    const number = Number(digits)
    if (!isIssueNumber(number)) continue
    const repo = slug === undefined ? null : repoSlug(slug)
    const key = `${repo ?? ''}#${number}`
    if (seen.has(key)) continue
    seen.add(key)
    found.push({ repo, number })
  }
  return found
}

/** What the tracker holds about one ticket. */
export type Ticket = { title: string; body: string; labels: readonly string[]; blockers: readonly IssueRef[] | null }

/** What `gh issue view --json title,body,labels` printed, checked: a missing body or labels read as empty, a missing title throws. */
export function parseIssue(json: string): Pick<Ticket, 'title' | 'body' | 'labels'> {
  const issue: unknown = JSON.parse(json)
  if (typeof issue !== 'object' || issue === null) throw new TypeError('gh issue view did not answer with an object')
  const { title, body, labels } = issue as Record<string, unknown>
  if (typeof title !== 'string') throw new TypeError('gh issue view answered without a title')
  const names = Array.isArray(labels) ? labels.flatMap(label => (typeof label?.name === 'string' ? [label.name as string] : [])) : []
  return { title, body: typeof body === 'string' ? body : '', labels: names }
}

/** The blockers `gh api ...blocked_by --jq` printed, one `owner/repo#n` a line; lines of any other shape are dropped. */
export function parseBlockers(output: string): IssueRef[] {
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(isIssueRef)
}

/** The block the model reads for `ticket`, headed by `ref` as the prompt named it. */
export function describeTicket(ref: IssueRef, ticket: Ticket): string {
  return [
    `Ticket ${ref}: ${ticket.title}`,
    `Labels: ${ticket.labels.length === 0 ? 'none' : ticket.labels.join(', ')}`,
    `Blocked by: ${ticket.blockers === null ? 'unknown' : ticket.blockers.length === 0 ? 'none' : ticket.blockers.join(', ')}`,
    '',
    ticket.body.trim() === '' ? '(no body)' : ticket.body.trim(),
  ].join('\n')
}
