// The repo a `gh` call without `--repo` targets, as a mod works it out: the simple command's own
// `GH_REPO=` prefix, then `GH_REPO` in the shell's environment, then the repo of the session's working
// directory — unless an earlier `cd` in the same shell command, or in an earlier Bash call of the session
// (remembered in a `ShellTrail`), has moved the shell, or an earlier
// `export`/`unset` of `GH_REPO` has changed its environment, when the session's directory or the hook's
// environment is no longer what `gh` sees and the target is unknown (null). A `GH_REPO=` prefix that is
// empty or names no valid repo also makes the target unknown, since `gh` itself would fail on it. An
// explicit `--repo`, or an issue URL, names the repo outright and never reaches this.
//
// It is not itself a mod, and a mod cannot import it from outside its own folder: a mod carries a copy
// of `target.ts` in its `hooks/target-repo/`, kept byte-identical to this by `copies.test.ts`.

/** The index of the command word: the first word that is not a `VAR=value` assignment. */
export function commandWordIndex(words: readonly string[]): number {
  const at = words.findIndex((word) => !/^\w+=/.test(word))
  return at === -1 ? words.length : at
}

/**
 * The repo a simple command's own `GH_REPO=` prefix names, `parse` reading the value (host and all);
 * null when it has none, 'unknown' when it is empty or `parse` rejects it, or an `env` carries options.
 * An assignment after a leading `env` counts as a prefix.
 */
export function prefixRepo<Repo extends string>(words: readonly string[], parse: (value: string) => Repo | null): Repo | 'unknown' | null {
  let value: string | null = null
  let afterEnv = false
  for (const word of words) {
    const assignment = /^(\w+)=(.*)$/s.exec(word)
    if (assignment) {
      if (assignment[1] === 'GH_REPO') value = assignment[2]!
    } else if (word === 'env' && !afterEnv) {
      afterEnv = true
    } else if (afterEnv && word.startsWith('-')) {
      return 'unknown'
    } else {
      break
    }
  }
  return value === null ? null : (parse(value) ?? 'unknown')
}

/** Whether a simple command moves the shell, so that a later one runs somewhere unknown. */
export function movesShell(words: readonly string[]): boolean {
  const command = words[commandWordIndex(words)]
  return command === 'cd' || command === 'pushd' || command === 'popd'
}

/** Whether a simple command changes `GH_REPO` in the shell's environment, which the hook cannot read afterwards. */
export function changesEnvironment(words: readonly string[]): boolean {
  const at = commandWordIndex(words)
  const command = words[at]
  if (command === undefined) return words.some((word) => /^GH_REPO=/.test(word))
  return (
    ['export', 'unset', 'declare', 'typeset', 'readonly', 'local'].includes(command) &&
    words.slice(at + 1).some((word) => /^GH_REPO(=|$)/.test(word))
  )
}

/** What the commands before a simple command, and its own prefix, settle about where its `gh` call runs. */
export interface CommandContext<Repo extends string> {
  /** The command's own `GH_REPO=` prefix: null when it has none, 'unknown' when it has one that names no repo. */
  prefixRepo: Repo | 'unknown' | null
  /** Whether a `cd` (or `pushd`, `popd`) ran earlier in the same shell command, or in an earlier Bash call of the session. */
  moved: boolean
  /** Whether an earlier command in the same shell command changed `GH_REPO` in the environment. */
  environmentChanged: boolean
}

/**
 * What a session's Bash calls have done to the shell so far. The persisted shell keeps a `cd` into the
 * next call, so once `moved` is set the session's directory is no longer where `gh` runs. It records the
 * `cd`s that were seen, not ones that ran: a denied call, a failed `cd` or one in a subshell still count,
 * and nothing resets it. That errs toward "unknown".
 */
export interface ShellTrail {
  moved: boolean
}

/** Each simple command's `visit`, given its context; the results `visit` returns (not null), in order. `trail` carries the shell's moves from one call to the next, and is updated in place, once, after the last command. */
export function walkCommands<Repo extends string, T>(
  commands: readonly (readonly string[])[],
  parse: (value: string) => Repo | null,
  visit: (words: readonly string[], context: CommandContext<Repo>) => T | null,
  trail: ShellTrail = { moved: false },
): T[] {
  let moved = trail.moved
  let environmentChanged = false
  const results: T[] = []
  for (const words of commands) {
    const result = visit(words, { prefixRepo: prefixRepo(words, parse), moved, environmentChanged })
    if (result !== null) results.push(result)
    moved ||= movesShell(words)
    environmentChanged ||= changesEnvironment(words)
  }
  trail.moved = moved
  return results
}

/** `GH_REPO` in the environment `run` runs commands in, `parse` reading the value (host and all); null when unset or not a repo. */
export async function environmentRepo<Repo extends string>(
  run: (argv: string[]) => Promise<{ exitCode: number; stdout: string }>,
  parse: (value: string) => Repo | null,
): Promise<Repo | null> {
  // `printenv` exits 1 when GH_REPO is unset.
  const { exitCode, stdout } = await run(['printenv', 'GH_REPO'])
  return exitCode === 0 ? parse(stdout.trim()) : null
}

/** What a caller supplies to learn the target repo; `Repo` is the caller's own branded slug. */
export interface TargetSources<Repo extends string> extends CommandContext<Repo> {
  /** `GH_REPO` in the shell's environment; null when unset or not a repo. */
  environment: () => Promise<Repo | null>
  /** The repo of the session's working directory; its rejection reaches the caller of `targetRepo`. */
  session: () => Promise<Repo>
}

/** The repo the call targets; null when unknown. Rejects only when the session's repo is needed and cannot be read. */
export async function targetRepo<Repo extends string>(sources: TargetSources<Repo>): Promise<Repo | null> {
  if (sources.prefixRepo === 'unknown') return null
  if (sources.prefixRepo !== null) return sources.prefixRepo
  if (sources.environmentChanged) return null
  const environment = await sources.environment().catch(() => null)
  if (environment !== null) return environment
  return sources.moved ? null : await sources.session()
}
