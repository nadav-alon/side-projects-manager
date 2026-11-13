import { avoidedTermsIn, avoidedUses, type AvoidedTerm } from './terms.ts'
import { sameRepo, type RepoSlug } from './repo.ts'
import { joinPath, type AbsolutePath } from './switcher.ts'
import { targetRepo } from './target-repo/target.ts'
import type { GhWrite } from './writes.ts'

/** What the avoided terms are read from. */
export interface VocabularySources {
  /** The session's working directory. */
  cwd(): Promise<string>
  /** Where the manager clones projects, as `<owner>/<repo>` folders. */
  managed(): Promise<AbsolutePath>
  /** The repo of the session's working directory; rejects when it cannot be read. */
  session(): Promise<RepoSlug>
  /** `GH_REPO` in the shell's environment; null when unset or not a repo. */
  environment(): Promise<RepoSlug | null>
  /** A file's text; null when it cannot be read. */
  read(path: string): Promise<string | null>
}

async function termsAt(path: string, from: VocabularySources): Promise<AvoidedTerm[]> {
  const context = await from.read(path).catch(() => null)
  return context === null ? [] : avoidedTermsIn(context)
}

/** The avoided terms of the session's own CONTEXT.md; none when it has none. */
export async function sessionTerms(from: VocabularySources): Promise<AvoidedTerm[]> {
  return termsAt(`${await from.cwd()}/CONTEXT.md`, from)
}

/**
 * The avoided terms a `gh` write is checked against: those of the repo it writes to. A write to another repo
 * is checked against that repo's CONTEXT.md in its clone under the managed location, and is unchecked (no
 * terms) when the clone or the file is not there, or when the repo it writes to cannot be told. A write to
 * the session's own repo is checked against the session's CONTEXT.md.
 */
async function termsFor(write: GhWrite, from: VocabularySources, session: () => Promise<RepoSlug>): Promise<AvoidedTerm[]> {
  const target = write.repo ?? (await targetRepo({ ...write.context, environment: from.environment, session }).catch(() => null))
  if (target === null) return []
  const own = await session().catch(() => null)
  if (own !== null && sameRepo(target, own)) return sessionTerms(from)
  return termsAt(`${joinPath(await from.managed(), target)}/CONTEXT.md`, from)
}

/** The avoided terms the `writes` use, each checked against the vocabulary of the repo it writes to; once each. */
export async function usesIn(writes: readonly GhWrite[], from: VocabularySources): Promise<AvoidedTerm[]> {
  let session: Promise<RepoSlug> | undefined
  const once = () => (session ??= from.session())
  const uses: AvoidedTerm[] = []
  for (const write of writes) {
    for (const use of avoidedUses(write.text, await termsFor(write, from, once))) {
      if (!uses.some(({ avoided, preferred }) => avoided === use.avoided && preferred === use.preferred)) uses.push(use)
    }
  }
  return uses
}
