// The sizing reminder: whether a shell call creates or sizes a ticket in this repo, whose tickets are
// sized one step larger than a project's. Pure over a current-repo reader, so a mod's hook only
// supplies the read; it imports nothing from the engine.

import { ghRepoPrefix, movesShell, targetRepo } from './target-repo/target.ts'

declare const foldedRepoSlugBrand: unique symbol

/** A repo as lower-case `owner/repo`; values enter through `foldedRepoSlug` or `isFoldedRepoSlug`. */
export type FoldedRepoSlug = string & { readonly [foldedRepoSlugBrand]: true }

const repoSlugPattern = /^[\w.-]+\/[\w.-]+$/

export function isFoldedRepoSlug(value: string): value is FoldedRepoSlug {
  return repoSlugPattern.test(value) && value === value.toLowerCase()
}

/** Narrows `value` to a `FoldedRepoSlug`, lower-casing it (GitHub names are case-insensitive); throws if it is not shaped like one. */
export function foldedRepoSlug(value: string): FoldedRepoSlug {
  const folded = value.toLowerCase()
  if (!isFoldedRepoSlug(folded)) throw new TypeError(`Not a repo slug, expected owner/repo: ${JSON.stringify(value)}`)
  return folded
}

/** The repo whose tickets are sized one step larger. */
export const THIS_REPO = foldedRepoSlug('nadav-alon/side-projects-manager')

export const REMINDER = `This repo's tickets are sized one step larger than a project's: size:M where a project's would be size:S. Check the size label on ${THIS_REPO}'s ticket against that.`

/** A shell call that creates or sizes a ticket; `repo` is null when it names none, `moved` true after a `cd`. */
interface SizingCall {
  repo: FoldedRepoSlug | null
  prefix: FoldedRepoSlug | null
  moved: boolean
}

/** The flags of `gh issue create` and `gh issue edit` that take a value, long and short. */
const VALUE_FLAGS = new Set([
  '--add-assignee',
  '--add-label',
  '--add-project',
  '--assignee',
  '--body',
  '--body-file',
  '--label',
  '--milestone',
  '--project',
  '--recover',
  '--remove-assignee',
  '--remove-label',
  '--remove-project',
  '--repo',
  '--template',
  '--title',
  '-R',
  '-F',
  '-a',
  '-b',
  '-l',
  '-m',
  '-p',
  '-T',
  '-t',
])

/**
 * The command's simple commands, each as its words; quotes group, `&&` `||` `;` `|` `&` `(` `)` and newlines
 * split, a backslash before a newline joins the lines, and a `#` opening a word comments out the line.
 */
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
      else if (char === '\\' && quote === '"' && command[i + 1] === '\n') i++
      else if (char === '\\' && quote === '"' && i + 1 < command.length) word += command[++i]!
      else word += char
    } else if (char === '"' || char === "'") {
      quote = char
      word ??= ''
    } else if (char === '\\' && command[i + 1] === '\n') {
      i++
    } else if (char === '\\' && i + 1 < command.length) {
      word = (word ?? '') + command[++i]!
    } else if (char === '#' && word === null) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i++
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

/** The repo a `--repo` value names: `OWNER/REPO` or `HOST/OWNER/REPO`; null when it is neither. */
function flagRepo(value: string): FoldedRepoSlug | null {
  const parts = value.split('/')
  const slug = (parts.length === 3 ? parts.slice(1).join('/') : value).toLowerCase()
  return isFoldedRepoSlug(slug) ? slug : null
}

/** The repo an issue URL names; null when the argument is not one. */
function urlRepo(arg: string): FoldedRepoSlug | null {
  const slug = /^https?:\/\/[^/]+\/([\w.-]+\/[\w.-]+)\/issues\/\d+(?:[/?#].*)?$/.exec(arg)?.[1]?.toLowerCase()
  return slug !== undefined && isFoldedRepoSlug(slug) ? slug : null
}

/**
 * The call a `gh issue create`, or a `gh issue edit` adding a `size:` label, makes; null when it is neither.
 * `gh` must be the command word, after any `VAR=value` prefixes, and its global flags may sit before `issue`.
 */
function sizingCallOf(words: readonly string[], moved: boolean): SizingCall | null {
  let at = 0
  while (at < words.length && /^\w+=/.test(words[at]!)) at++
  if (words[at++] !== 'gh') return null
  const assigned = ghRepoPrefix(words)
  const prefix = assigned === null ? null : flagRepo(assigned)

  let repo: FoldedRepoSlug | null = null
  let isSizing = false
  const takeFlag = (arg: string, next: () => string | undefined): boolean => {
    const long = /^(--[\w-]+)=(.*)$/s.exec(arg)
    const short = /^(-[A-Za-z])(.+)$/s.exec(arg)
    const name = long?.[1] ?? (short && VALUE_FLAGS.has(short[1]!) ? short[1]! : arg)
    if (!VALUE_FLAGS.has(name)) return false
    const value = long?.[2] ?? short?.[2] ?? next() ?? ''
    if (name === '--repo' || name === '-R') repo = flagRepo(value)
    else if (name === '--add-label') isSizing ||= value.split(',').some((label) => label.trim().toLowerCase().startsWith('size:'))
    return true
  }

  while (at < words.length && words[at]!.startsWith('-')) {
    const arg = words[at++]!
    takeFlag(arg, () => words[at++])
  }
  if (words[at++] !== 'issue') return null
  const verb = words[at++]
  if (verb !== 'create' && verb !== 'edit') return null

  isSizing = verb === 'create'
  let issueRepo: FoldedRepoSlug | null = null
  while (at < words.length) {
    const arg = words[at++]!
    if (!takeFlag(arg, () => words[at++]) && !arg.startsWith('-')) issueRepo ??= urlRepo(arg)
  }
  if (!isSizing) return null
  repo = issueRepo ?? repo
  return { repo, prefix, moved }
}

/** Every ticket creation or sizing the call makes; empty when it makes none. */
function sizingCalls(command: string): SizingCall[] {
  let moved = false
  const calls: SizingCall[] = []
  for (const words of simpleCommands(command)) {
    const call = sizingCallOf(words, moved)
    if (call !== null) calls.push(call)
    moved ||= movesShell(words)
  }
  return calls
}

/**
 * The reminder when `command` creates or sizes a ticket in this repo, else null. A call naming no repo
 * is in the repo `targetRepo` works out from its `GH_REPO=` prefix, `environmentRepo` and `currentRepo`;
 * one whose repo is unknown is taken as another repo.
 */
export async function sizingReminder(
  command: string,
  currentRepo: () => Promise<FoldedRepoSlug>,
  environmentRepo: () => Promise<FoldedRepoSlug | null>,
): Promise<string | null> {
  for (const call of sizingCalls(command)) {
    const repo =
      call.repo ??
      (await targetRepo({ prefix: call.prefix, moved: call.moved, environment: environmentRepo, session: currentRepo }).catch(() => null))
    if (repo === THIS_REPO) return REMINDER
  }
  return null
}
