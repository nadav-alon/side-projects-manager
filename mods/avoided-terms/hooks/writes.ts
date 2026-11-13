import { optionalRepo, urlRepo, type RepoSlug } from './repo.ts'
import { simpleCommands } from './shell.ts'
import { walkCommands, type CommandContext, type ShellTrail } from './target-repo/target.ts'

/**
 * A `gh` call that writes issue or pull request text: its `--title` and `--body` values, the prose of the
 * ticket without its flags and arguments. `repo` is the repo the call names itself, with `--repo`/`-R` or an
 * issue or pull request URL; null when it names none, and `context` settles the repo then.
 * Out of scope: `gh api … -f body=`, and `--body-file`, whose prose lives in a file the command only names.
 */
export interface GhWrite {
  text: string
  repo: RepoSlug | null
  context: CommandContext<RepoSlug>
}

const TEXT_FLAGS = new Set(['--title', '--body', '-t', '-b'])
const VALUE_FLAGS = new Set([...TEXT_FLAGS, '--repo', '-R'])

interface Args {
  flags: { name: string; value: string }[]
  positionals: string[]
}

/** Splits `args` into the flags of `VALUE_FLAGS` with their values, and the words that are no such flag's. A quoted value is one word, so a flag inside it is no flag. */
function parseArgs(args: readonly string[]): Args {
  const flags: Args['flags'] = []
  const positionals: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const long = /^(--[\w-]+)=(.*)$/s.exec(arg)
    const short = /^(-[A-Za-z])=?(.+)$/s.exec(arg)
    if (long) {
      if (VALUE_FLAGS.has(long[1]!)) flags.push({ name: long[1]!, value: long[2]! })
    } else if (arg.startsWith('--') || arg === '-R' || arg === '-t' || arg === '-b') {
      if (VALUE_FLAGS.has(arg)) flags.push({ name: arg, value: args[++i] ?? '' })
    } else if (short && VALUE_FLAGS.has(short[1]!)) {
      flags.push({ name: short[1]!, value: short[2]! })
    } else if (!arg.startsWith('-')) {
      positionals.push(arg)
    }
  }
  return { flags, positionals }
}

/** The arguments of the `gh issue|pr create|edit|comment|review` call in `words`, the flags before its subcommand too; null when there is none. */
function writeArgs(words: readonly string[]): Args | null {
  const skipFlags = (from: number) => {
    let i = from
    while (words[i]?.startsWith('-')) i += words[i] === '--repo' || words[i] === '-R' ? 2 : 1
    return i
  }
  for (let gh = words.indexOf('gh'); gh !== -1; gh = words.indexOf('gh', gh + 1)) {
    const noun = skipFlags(gh + 1)
    if (words[noun] !== 'issue' && words[noun] !== 'pr') continue
    const sub = skipFlags(noun + 1)
    if (!['create', 'edit', 'comment', 'review'].includes(words[sub] ?? '')) continue
    const before = parseArgs(words.slice(gh + 1, sub))
    const after = parseArgs(words.slice(sub + 1))
    return { flags: [...before.flags, ...after.flags], positionals: after.positionals }
  }
  return null
}

function visit(words: readonly string[], context: CommandContext<RepoSlug>): GhWrite | null {
  const args = writeArgs(words)
  if (args === null) return null
  const flag = args.flags.findLast(({ name }) => name === '--repo' || name === '-R')
  const repo = (flag ? optionalRepo(flag.value) : null) ?? args.positionals.map(urlRepo).find(found => found !== null) ?? null
  const text = args.flags
    .filter(({ name }) => TEXT_FLAGS.has(name))
    .map(({ value }) => value)
    .join('\n')
    .replace(/`[^`\n]*`/g, '')
  return { text, repo, context }
}

/**
 * The text each `gh` call in `command` writes. Walks every simple command, writes or not, so `trail` sees
 * each `cd`; a call whose `--repo`/`-R` names no repo has no repo of its own, since `gh` would fail on it.
 */
export function ghWrites(command: string, trail?: ShellTrail): GhWrite[] {
  return walkCommands(simpleCommands(command), optionalRepo, visit, trail)
}
