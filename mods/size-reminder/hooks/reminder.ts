// The sizing reminder: whether a shell call creates or sizes a ticket in this repo, whose tickets are
// sized one step larger than a project's. Pure over a current-repo reader, so a mod's hook only
// supplies the read; it imports nothing from the engine.

declare const repoSlugBrand: unique symbol

/** A repo as lower-case `owner/repo`; values enter through `repoSlug` or `isRepoSlug`. */
export type RepoSlug = string & { readonly [repoSlugBrand]: true }

const repoSlugPattern = /^[\w.-]+\/[\w.-]+$/

export function isRepoSlug(value: string): value is RepoSlug {
  return repoSlugPattern.test(value) && value === value.toLowerCase()
}

/** Narrows `value` to a `RepoSlug`, lower-casing it (GitHub names are case-insensitive); throws if it is not shaped like one. */
export function repoSlug(value: string): RepoSlug {
  const folded = value.toLowerCase()
  if (!isRepoSlug(folded)) throw new TypeError(`Not a repo slug, expected owner/repo: ${JSON.stringify(value)}`)
  return folded
}

/** The repo whose tickets are sized one step larger. */
export const THIS_REPO = repoSlug('nadav-alon/side-projects-manager')

export const REMINDER = `This repo's tickets are sized one step larger than a project's: size:M where a project's would be size:S. Check the size label on ${THIS_REPO}'s ticket against that.`

/** A shell call that creates or sizes a ticket; `repo` is null when the call names none. */
export interface SizingCall {
  repo: RepoSlug | null
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

/** The command's simple commands, each as its words; quotes group, `&&` `||` `;` `|` `&` and newlines split. */
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
    } else if (char === '\n' || char === ';' || char === '|' || char === '&') {
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
function flagRepo(value: string): RepoSlug | null {
  const parts = value.split('/')
  const slug = (parts.length === 3 ? parts.slice(1).join('/') : value).toLowerCase()
  return isRepoSlug(slug) ? slug : null
}

/** The call a `gh issue create`, or a `gh issue edit` adding a `size:` label, makes; null when it is neither. */
function sizingCallOf(words: readonly string[]): SizingCall | null {
  const start = words.findIndex((word, i) => word === 'gh' && words[i + 1] === 'issue')
  const verb = words[start + 2]
  if (start === -1 || (verb !== 'create' && verb !== 'edit')) return null
  const args = words.slice(start + 3)

  let repo: RepoSlug | null = null
  let isSizing = verb === 'create'
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const long = /^(--[\w-]+)=(.*)$/s.exec(arg)
    const short = /^(-[A-Za-z])(.+)$/s.exec(arg)
    const name = long?.[1] ?? (short && VALUE_FLAGS.has(short[1]!) ? short[1]! : arg)
    if (!VALUE_FLAGS.has(name)) continue
    const value = long?.[2] ?? short?.[2] ?? args[++i] ?? ''
    if (name === '--repo' || name === '-R') repo = flagRepo(value)
    else if (name === '--add-label') isSizing ||= value.split(',').some((label) => label.trim().startsWith('size:'))
  }
  return isSizing ? { repo } : null
}

/** Every ticket creation or sizing the call makes; empty when it makes none. */
export function sizingCalls(command: string): SizingCall[] {
  return simpleCommands(command).flatMap((words) => sizingCallOf(words) ?? [])
}

/**
 * The reminder when `command` creates or sizes a ticket in this repo, else null. A call naming no repo
 * is in whichever repo `currentRepo` reads; one that cannot be read is taken as another repo.
 */
export async function sizingReminder(command: string, currentRepo: () => Promise<RepoSlug>): Promise<string | null> {
  for (const call of sizingCalls(command)) {
    const repo = call.repo ?? (await currentRepo().catch(() => null))
    if (repo === THIS_REPO) return REMINDER
  }
  return null
}
