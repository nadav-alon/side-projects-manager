import { avoidedTermsIn, repoFlagOf, type AvoidedTerm } from './terms.ts'

/** What `termsForCommand` reads from the session. */
export interface VocabularySources {
  /** The session's working directory. */
  cwd(): Promise<string>
  /** Where the manager clones projects, as `<owner>/<repo>` folders; null when it cannot be told. */
  managed(): Promise<string | null>
  /** The repo of the session's working directory, as lower-case `owner/repo`. */
  sessionRepo(): Promise<string>
  /** A file's text; null when it cannot be read. */
  read(path: string): Promise<string | null>
}

/**
 * The avoided terms a `gh` command's text is checked against: those of the repo it writes to. A command
 * naming another repo with `--repo`/`-R` is checked against that repo's CONTEXT.md in its clone under the
 * managed location, and is unchecked (no terms) when the clone or the file is not there. A command naming no
 * repo, or the session's own, is checked against the session's CONTEXT.md.
 */
export async function termsForCommand(command: string, from: VocabularySources): Promise<AvoidedTerm[]> {
  const named = repoFlagOf(command)
  const own = async () => read(`${await from.cwd()}/CONTEXT.md`, from)
  if (named === null) return own()
  if (named === (await from.sessionRepo().catch(() => null))) return own()
  const managed = await from.managed()
  return managed === null ? [] : read(`${managed}/${named}/CONTEXT.md`, from)
}

async function read(path: string, from: VocabularySources): Promise<AvoidedTerm[]> {
  const context = await from.read(path).catch(() => null)
  return context === null ? [] : avoidedTermsIn(context)
}
