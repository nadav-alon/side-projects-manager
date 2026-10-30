// The repo a `gh` call without `--repo` targets, as a mod works it out: the simple command's own
// `GH_REPO=` prefix, then `GH_REPO` in the shell's environment, then the repo of the session's working
// directory — unless an earlier `cd` in the same shell command has moved the shell, when the session's
// directory is no longer where `gh` runs and the target is unknown (null). An explicit `--repo`, or an
// issue URL, names the repo outright and never reaches this.
//
// It is not itself a mod, and a mod cannot import it from outside its own folder: a mod carries a copy
// of `target.ts` in its `hooks/target-repo/`, kept byte-identical to this by `copies.test.ts`.

/** The value of a leading `GH_REPO=` assignment on a simple command's words; null when it has none. */
export function ghRepoPrefix(words: readonly string[]): string | null {
  let value: string | null = null
  for (const word of words) {
    const assignment = /^(\w+)=(.*)$/s.exec(word)
    if (!assignment) break
    if (assignment[1] === 'GH_REPO') value = assignment[2]!
  }
  return value
}

/** Whether a simple command moves the shell, so that a later one runs somewhere unknown. */
export function movesShell(words: readonly string[]): boolean {
  const command = words.find((word) => !/^\w+=/.test(word))
  return command === 'cd' || command === 'pushd' || command === 'popd'
}

/** What a caller supplies to learn the target repo; `Repo` is the caller's own branded slug. */
export interface TargetSources<Repo extends string> {
  /** The command's own `GH_REPO=` prefix, null when it has none or names no valid repo. */
  prefix: Repo | null
  /** Whether a `cd` (or `pushd`, `popd`) ran earlier in the same shell command. */
  moved: boolean
  /** `GH_REPO` in the shell's environment; null when unset or not a repo. */
  environment: () => Promise<Repo | null>
  /** The repo of the session's working directory; its rejection reaches the caller of `targetRepo`. */
  session: () => Promise<Repo>
}

/** The repo the call targets; null when unknown. Rejects only when the session's repo is needed and cannot be read. */
export async function targetRepo<Repo extends string>(sources: TargetSources<Repo>): Promise<Repo | null> {
  if (sources.prefix !== null) return sources.prefix
  const environment = await sources.environment().catch(() => null)
  if (environment !== null) return environment
  return sources.moved ? null : await sources.session()
}
