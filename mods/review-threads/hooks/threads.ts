// The review-threads pane's data: draft pull requests and their unresolved review threads, read from
// the repo host's GraphQL answer, and the commands that act on one. Pure, so a mod's hook only
// supplies the process runs; it imports nothing from the engine.

declare const repoSlugBrand: unique symbol
declare const pullRequestNumberBrand: unique symbol

/** A GitHub repository as `owner/repo`; values enter through `repoSlug` or `isRepoSlug`. */
export type RepoSlug = string & { readonly [repoSlugBrand]: true }

/** The number a pull request is known by in its repo; values enter through `pullRequestNumber` or `isPullRequestNumber`. */
export type PullRequestNumber = number & { readonly [pullRequestNumberBrand]: true }

const repoSlugPattern = /^[\w.-]+\/[\w.-]+$/

export function isRepoSlug(value: string): value is RepoSlug {
  return repoSlugPattern.test(value)
}

/** Narrows `value` to a `RepoSlug`; throws if it is not shaped like `owner/repo`. */
export function repoSlug(value: string): RepoSlug {
  if (!isRepoSlug(value)) throw new TypeError(`Not a repo slug, expected owner/repo: ${JSON.stringify(value)}`)
  return value
}

export function isPullRequestNumber(value: number): value is PullRequestNumber {
  return Number.isSafeInteger(value) && value > 0
}

/** Narrows `value` to a `PullRequestNumber`; throws if it is not a whole number above 0. */
export function pullRequestNumber(value: number): PullRequestNumber {
  if (!isPullRequestNumber(value)) throw new TypeError(`Not a pull request number: ${value}`)
  return value
}

/** The label the rebase workflow puts on a pull request that conflicts with its base. */
export const NEEDS_REBASE_LABEL = 'needs-rebase'

/** An unresolved review thread: where it sits and the first line of its opening comment. */
export interface OpenThread {
  path: string
  summary: string
}

export interface DraftPullRequest {
  number: PullRequestNumber
  title: string
  needsRebase: boolean
  openThreads: OpenThread[]
}

/** The GraphQL query for the repo's open pull requests with their labels and review threads; takes `$owner` and `$name`. */
export const PULL_REQUESTS_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number
        title
        isDraft
        labels(first: 50) { nodes { name } }
        reviewThreads(first: 100) { nodes { isResolved path comments(first: 1) { nodes { body } } } }
      }
    }
  }
}`

/** The `gh` arguments that read the repo's open pull requests. */
export function readArgs(repo: RepoSlug): string[] {
  const [owner, name] = repo.split('/')
  return ['api', 'graphql', '-f', `query=${PULL_REQUESTS_QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`]
}

const SUMMARY_LENGTH = 80

function summaryOf(body: string): string {
  const line = body.split('\n').find(l => l.trim() !== '') ?? ''
  const text = line.trim()
  return text.length > SUMMARY_LENGTH ? `${text.slice(0, SUMMARY_LENGTH - 1)}…` : text
}

type Node = Record<string, unknown>

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null
const nodesOf = (value: unknown): Node[] => {
  const nodes = isNode(value) ? value.nodes : undefined
  return Array.isArray(nodes) ? nodes.filter(isNode) : []
}

/**
 * The draft pull requests in `gh api graphql`'s answer to `PULL_REQUESTS_QUERY`, newest first, ready
 * ones left out. Throws when the answer is not JSON or carries no pull requests.
 */
export function parseDraftPullRequests(output: string): DraftPullRequest[] {
  const root: unknown = JSON.parse(output)
  const data = isNode(root) ? root.data : undefined
  const repository = isNode(data) ? data.repository : undefined
  const pullRequests = isNode(repository) ? repository.pullRequests : undefined
  if (!isNode(pullRequests) || !Array.isArray(pullRequests.nodes)) {
    throw new Error(`No pull requests in the repo host's answer: ${output.slice(0, 200)}`)
  }
  return nodesOf(pullRequests).flatMap(pr => {
    if (pr.isDraft !== true || typeof pr.number !== 'number' || !isPullRequestNumber(pr.number)) return []
    const openThreads = nodesOf(pr.reviewThreads)
      .filter(thread => thread.isResolved === false)
      .map(thread => ({
        path: typeof thread.path === 'string' ? thread.path : '',
        summary: summaryOf(String(nodesOf(thread.comments)[0]?.body ?? '')),
      }))
    return [
      {
        number: pr.number,
        title: typeof pr.title === 'string' ? pr.title : '',
        needsRebase: nodesOf(pr.labels).some(label => label.name === NEEDS_REBASE_LABEL),
        openThreads,
      },
    ]
  })
}

/** What a button posts on a pull request: the comment that opens the matching ticket. */
export type PullRequestAction = 'apply-review' | 'rebase'

/** The question put to the developer before `action` is posted on `pr`. */
export function confirmationFor(action: PullRequestAction, pr: PullRequestNumber): string {
  return `Post /${action} on pull request #${pr}?`
}

/** The `gh` arguments that post `action`'s comment on pull request `pr` of `repo`. */
export function commentArgs(repo: RepoSlug, pr: PullRequestNumber, action: PullRequestAction): string[] {
  return ['pr', 'comment', String(pr), '--repo', repo, '--body', `/${action}`]
}

/** The lines a pull request is drawn as: its heading, then a line per open thread. */
export function pullRequestLines(pr: DraftPullRequest): string[] {
  const count = pr.openThreads.length
  const heading = `#${pr.number} ${pr.title} — ${count === 0 ? 'no open threads' : `${count} open thread${count === 1 ? '' : 's'}`}`
  return [
    pr.needsRebase ? `${heading} [${NEEDS_REBASE_LABEL}]` : heading,
    ...pr.openThreads.map(t => `  ${t.path === '' ? '' : `${t.path}: `}${t.summary}`),
  ]
}
