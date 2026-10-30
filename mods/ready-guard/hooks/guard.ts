// The ready-for-agent guard: whether a shell call labelling a ticket ready-for-agent may run, given
// the ticket's body and the blockers linked to it. Pure over a tracker reader, so a mod's hook only
// supplies the reads; it imports nothing from the engine.

import { targetRepo, walkCommands, type CommandContext } from './target-repo/target.ts'

declare const repoSlugBrand: unique symbol
declare const issueNumberBrand: unique symbol
declare const issueRefBrand: unique symbol

/** A repo as `owner/repo`; values enter through `repoSlug` or `isRepoSlug`. */
export type RepoSlug = string & { readonly [repoSlugBrand]: true }
/** A ticket's number: a positive integer; values enter through `issueNumber` or `isIssueNumber`. */
export type IssueNumber = number & { readonly [issueNumberBrand]: true }
/** A ticket as lower-case `owner/repo#n`; values enter through `issueRef` or `isIssueRef`. */
export type IssueRef = string & { readonly [issueRefBrand]: true }

// The shapes every pattern below is built from.
const SLUG = '[\\w.-]+/[\\w.-]+'
const NUMBER = '[1-9]\\d*'

const repoSlugPattern = new RegExp(`^${SLUG}$`)
const issueRefPattern = new RegExp(`^${SLUG}#${NUMBER}$`)

export function isRepoSlug(value: string): value is RepoSlug {
  return repoSlugPattern.test(value)
}

/** Narrows `value` to a `RepoSlug`, throwing if it is not shaped like one. */
export function repoSlug(value: string): RepoSlug {
  if (!isRepoSlug(value)) throw new TypeError(`Not a repo slug, expected owner/repo: ${JSON.stringify(value)}`)
  return value
}

export function isIssueNumber(value: number): value is IssueNumber {
  return Number.isSafeInteger(value) && value > 0
}

/** Narrows `value` to an `IssueNumber`, throwing if it is not a positive integer. */
export function issueNumber(value: number): IssueNumber {
  if (!isIssueNumber(value)) throw new TypeError(`Not an issue number, expected a positive integer: ${value}`)
  return value
}

export function isIssueRef(value: string): value is IssueRef {
  return issueRefPattern.test(value) && value === value.toLowerCase()
}

/** Narrows `value` to an `IssueRef`, lower-casing it (GitHub names are case-insensitive); throws if it is not shaped like one. */
export function issueRef(value: string): IssueRef {
  const folded = value.toLowerCase()
  if (!isIssueRef(folded)) throw new TypeError(`Not an issue ref, expected owner/repo#n: ${JSON.stringify(value)}`)
  return folded
}

/** The repo and number an `IssueRef` stands for. */
export function issueParts(issue: IssueRef): { repo: RepoSlug; number: IssueNumber } {
  const [repo = '', number = ''] = issue.split('#')
  return { repo: repoSlug(repo), number: issueNumber(Number(number)) }
}

/** The tracker reads the guard needs, for one ticket. */
export interface Tracker {
  /** The repo of the session's working directory, which the shell may no longer be in. */
  currentRepo(): Promise<RepoSlug>
  /** `GH_REPO` in the shell's environment; null when it is unset or not a repo. */
  environmentRepo(): Promise<RepoSlug | null>
  body(issue: IssueRef): Promise<string>
  /** The tickets linked to `issue` as native blocked-by dependencies. */
  linkedBlockers(issue: IssueRef): Promise<readonly IssueRef[]>
}

/**
 * A ticket a `gh issue edit` adds `ready-for-agent` to; `repo` is null when the call names none by
 * `--repo` or an issue URL, and `context` is what settles the repo then: the command's own `GH_REPO=`,
 * and whether a `cd` or a change of `GH_REPO` came before it.
 */
export interface ReadyLabelEdit {
  repo: RepoSlug | null
  context: CommandContext<RepoSlug>
  number: IssueNumber
}

const LABEL = 'ready-for-agent'

/** The flags of `gh issue edit` and `gh issue create` that take a value, long and short. */
const VALUE_FLAGS = new Set([
  '--assignee',
  '--label',
  '--project',
  '--template',
  '-T',
  '-a',
  '-l',
  '-p',
  '--add-assignee',
  '--add-label',
  '--add-project',
  '--body',
  '--body-file',
  '--milestone',
  '--remove-assignee',
  '--remove-label',
  '--remove-project',
  '--repo',
  '--title',
  '-R',
  '-b',
  '-F',
  '-m',
  '-t',
])

/** The command's simple commands, each as its words; quotes group, `&&` `||` `;` `|` `&` `(` `)` and newlines split. */
function simpleCommands(command: string): string[][] {
  const commands: string[][] = [[]]
  let word: string | null = null
  let quote: '"' | "'" | null = null
  const endWord = () => {
    if (word !== null) commands[commands.length - 1]!.push(word)
    word = null
  }
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if (quote !== null) {
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && i + 1 < command.length) word += command[++i]!
      else word += char
    } else if (char === '"' || char === "'") {
      quote = char
      word ??= ''
    } else if (char === '\\' && i + 1 < command.length) {
      word = (word ?? '') + command[++i]!
    } else if (/\s/.test(char) && char !== '\n') {
      endWord()
    } else if (char === '\n' || char === ';' || char === '|' || char === '&' || char === '(' || char === ')') {
      endWord()
      if (commands[commands.length - 1]!.length > 0) commands.push([])
    } else {
      word = (word ?? '') + char
    }
  }
  endWord()
  return commands.filter((words) => words.length > 0)
}

/** The repo a `--repo` value names: `OWNER/REPO` or `HOST/OWNER/REPO`. */
function flagRepo(value: string): RepoSlug {
  const parts = value.split('/')
  return repoSlug(parts.length === 3 ? parts.slice(1).join('/') : value)
}

/** The repo a `GH_REPO` value names, host and all; null when it names none. */
export function optionalRepo(value: string): RepoSlug | null {
  const parts = value.split('/')
  const slug = parts.length === 3 ? parts.slice(1).join('/') : value
  return isRepoSlug(slug) ? slug : null
}

/** The ticket an issue argument names: `7`, `#7` or an issue URL, which also names its repo. */
function issueArgument(arg: string): { repo: RepoSlug | null; number: IssueNumber } | null {
  const bare = /^#?(\d+)$/.exec(arg)
  if (bare) return { repo: null, number: issueNumber(Number(bare[1])) }
  const url = new RegExp(`^https?://[^/]+/(${SLUG})/issues/(\\d+)(?:[/?#].*)?$`).exec(arg)
  return url ? { repo: repoSlug(url[1]!), number: issueNumber(Number(url[2])) } : null
}

/** Whether one `gh issue create` labels the new ticket `ready-for-agent`. */
function createsReady(words: readonly string[]): boolean {
  const start = words.findIndex((word, i) => word === 'gh' && words[i + 1] === 'issue' && words[i + 2] === 'create')
  if (start === -1) return false
  const args = words.slice(start + 3)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const long = /^(--[\w-]+)=(.*)$/s.exec(arg)
    const short = /^(-[A-Za-z])(.+)$/s.exec(arg)
    const name = long?.[1] ?? (short && VALUE_FLAGS.has(short[1]!) ? short[1]! : arg)
    if (!VALUE_FLAGS.has(name)) continue
    const value = long?.[2] ?? short?.[2] ?? args[++i] ?? ''
    if ((name === '--label' || name === '-l') && value.split(',').some((label) => label.trim() === LABEL)) return true
  }
  return false
}

/** Whether the call is a `gh issue create` that labels the new ticket `ready-for-agent`. */
export function createsReadyTicket(command: string): boolean {
  return simpleCommands(command).some(createsReady)
}

/** The tickets one `gh issue edit` adds `ready-for-agent` to; none when it does not add it. */
function editsOf(words: readonly string[], context: CommandContext<RepoSlug>): ReadyLabelEdit[] {
  const start = words.findIndex((word, i) => word === 'gh' && words[i + 1] === 'issue' && words[i + 2] === 'edit')
  if (start === -1) return []
  const args = words.slice(start + 3)

  let repo: RepoSlug | null = null
  const issues: { repo: RepoSlug | null; number: IssueNumber }[] = []
  let isAdding = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const long = /^(--[\w-]+)=(.*)$/s.exec(arg)
    const short = /^(-[A-Za-z])(.+)$/s.exec(arg)
    const name = long?.[1] ?? (short && VALUE_FLAGS.has(short[1]!) ? short[1]! : arg)
    if (VALUE_FLAGS.has(name)) {
      const value = long?.[2] ?? short?.[2] ?? args[++i] ?? ''
      if (name === '--repo' || name === '-R') repo = flagRepo(value)
      else if (name === '--add-label') isAdding ||= value.split(',').some((label) => label.trim() === LABEL)
    } else if (!arg.startsWith('-')) {
      const issue = issueArgument(arg)
      if (issue) issues.push(issue)
    }
  }
  return isAdding ? issues.map((issue) => ({ repo: issue.repo ?? repo, context, number: issue.number })) : []
}

/** Every ticket the call adds `ready-for-agent` to; empty when it is not such a `gh issue edit`. */
export function readyLabelEdits(command: string): ReadyLabelEdit[] {
  return walkCommands(simpleCommands(command), optionalRepo, editsOf).flat()
}

/** The tickets a body's Blocked by names, as written `#n`, `owner/repo#n` or an issue URL; `repo` qualifies a bare `#n`. */
export function namedBlockers(body: string, repo: RepoSlug): IssueRef[] {
  const section = /^#{1,6}\s*Blocked by\s*$([\s\S]*?)(?=^#{1,6}\s|(?![\s\S]))/im.exec(body)?.[1]
  const line = /^Blocked by:(.*)$/im.exec(body)?.[1]
  const ref = new RegExp(`https?://[^/\\s]+/(${SLUG})/issues/(${NUMBER})|(${SLUG})?#(${NUMBER})`, 'g')
  return [...(section ?? line ?? '').matchAll(ref)].map((found) =>
    issueRef(`${found[1] ?? found[3] ?? repo}#${found[2] ?? found[4]}`),
  )
}

/** `null` when the call may run; otherwise the text that denies it. */
async function denyReadyLabel(command: string, tracker: Tracker): Promise<string | null> {
  const denials: string[] = []
  if (createsReadyTicket(command)) {
    denials.push(
      `gh issue create must not add ${LABEL}: its blockers cannot be linked before the ticket exists. Create the ticket unlabelled, link its blockers, then add ${LABEL}.`,
    )
  }
  for (const edit of readyLabelEdits(command)) {
    const repo =
      edit.repo ??
      (await targetRepo({ ...edit.context, environment: () => tracker.environmentRepo(), session: () => tracker.currentRepo() }))
    if (repo === null) {
      denials.push(
        `#${edit.number} is in a repo this call does not name, and the shell may have moved or changed GH_REPO: add --repo OWNER/REPO, then add ${LABEL}.`,
      )
      continue
    }
    const issue = issueRef(`${repo}#${edit.number}`)
    const named = namedBlockers(await tracker.body(issue), repo)
    const linked = new Set((await tracker.linkedBlockers(issue)).map((ref) => issueRef(ref)))
    const missing = named.filter((ref) => !linked.has(ref))
    if (missing.length > 0) {
      denials.push(
        `${issue} names blockers that are not linked as blocked-by dependencies: ${missing.join(', ')}. Link them first, then add ${LABEL}.`,
      )
    }
  }
  return denials.length === 0 ? null : denials.join('\n')
}

/** What the guard says of a call: it runs, it is denied with a reason, or it runs with a warning. */
export type Verdict = { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'warn'; warning: string }

/** The verdict on `command`; a tracker that cannot be read warns instead of blocking. */
export async function checkReadyLabel(command: string, tracker: Tracker): Promise<Verdict> {
  try {
    const reason = await denyReadyLabel(command, tracker)
    return reason === null ? { kind: 'allow' } : { kind: 'deny', reason }
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error)
    return { kind: 'warn', warning: `ready-guard: could not read the tracker, so the blockers were not checked: ${cause}` }
  }
}
