import type { Checkout } from "./checkout.ts";
import type { StandardsPreset } from "./standards-preset.ts";

/** Where a project's own rules go. Not uniform: written once, never synced. */
export const STANDARDS_FILE = "docs/project-standards.md";

/** A `--standards` name that has no preset file, naming the ones that do. */
export class UnknownPreset extends Error {
  constructor(preset: string, names: readonly string[]) {
    super(
      `No standards preset named ${JSON.stringify(preset)}; ${
        names.length === 0 ? "there are no presets." : `the presets are: ${names.join(", ")}.`
      }`,
    );
    this.name = "UnknownPreset";
  }
}

/**
 * The files every project gets, byte for byte, at the paths the agent
 * instructions point at. The instructions also name {@link STANDARDS_FILE},
 * which is not among them: written once, never synced.
 *
 * These are the manager's own copies: the manager is a registered project like
 * any other, so improving the conventions it works under improves the ones
 * every project it scaffolds works under, from one source rather than a
 * drifting copy in each project. Nothing listed here may name the manager, or a project would
 * arrive carrying a reference back to it.
 *
 * Declared here, beside the port, rather than only in the adapter that copies
 * them: the loop reads this same list to catch a run's diff touching one of
 * them before it becomes a project-local pull request (see `morning-run.ts`'s
 * `handOver`), and a second copy of the list would drift from this one
 * unnoticed.
 */
export const UNIFORM_FILES = [
  "docs/agents/coding-standards.md",
  "docs/agents/issue-tracker.md",
  "docs/agents/ticket-scope.md",
  "docs/agents/triage-labels.md",
  "docs/agents/domain.md",
  ".github/workflows/apply-review.yml",
  ".github/workflows/rebase.yml",
  ".github/workflows/scripts/rebase.sh",
] as const;

/**
 * The members of `UNIFORM_FILES` present in `changed`, in `UNIFORM_FILES`'s
 * own order rather than `changed`'s — empty when it holds none. Shared by
 * every uniform-file check (`morning-run.ts`'s `handOver`,
 * `container-sandbox.ts`'s apply-review and rebase push guard) so the one
 * rule — which paths count — cannot drift between them.
 */
export function uniformFilesAmong(changed: Iterable<string>): string[] {
  const set = changed instanceof Set ? changed : new Set(changed);
  return UNIFORM_FILES.filter((file) => set.has(file));
}

/**
 * How a project's copy of one uniform file reads against the harness's own:
 * byte for byte the current one, byte for byte a version the harness held
 * before it last changed, or neither.
 */
export type UniformComparison = "current" | "earlier" | "different";

/** What one scaffolding put into a checkout. */
export interface Scaffold {
  /** Every path written, relative to the checkout, in the order written. */
  paths: string[];
  /**
   * The paths that replaced a file the project already had.
   *
   * Only uniform files can appear here — the instructions file is never
   * overwritten. A project that predates the harness is adopted through a pull
   * request, and this is what that request has to say out loud: a diff shows
   * that a file changed, but not that the change was this command overwriting
   * something the project wrote for itself.
   */
  overwritten: string[];
}

/**
 * Scaffolds the harness into one project checkout.
 *
 * Two kinds of file go in, and the difference between them is the point. The
 * uniform files are copied verbatim, so every project reads the same
 * conventions and an improvement to them reaches every project the same way.
 * The agent instructions are generated for that one project and written
 * alongside them, so a project describes itself rather than inheriting a
 * description of whoever scaffolded it.
 */
export interface Harness {
  /**
   * Installs the uniform files into the checkout at `directory` and writes
   * `instructions` as the project's own agent instructions and `standards` as
   * its own standards file. Neither of those two is a uniform file: each is
   * written only when the checkout has none, and is the project's from then on.
   */
  install(directory: Checkout, instructions: string, standards: string): Promise<Scaffold>;

  /**
   * The text a new project's `docs/project-standards.md` starts as: the stub
   * when `preset` is undefined, otherwise the named preset's file. Throws,
   * naming the presets that exist, for a `preset` that has no file — asked
   * before anything is created, so a mistyped name costs nothing.
   */
  standards(preset?: StandardsPreset): Promise<string>;

  /**
   * Copies into `directory` every uniform file that does not already match
   * the harness's own copy byte for byte, and answers with the ones it
   * copied, in `UNIFORM_FILES`'s own order — empty when the checkout already
   * matched every one of them.
   *
   * What tells a uniform sync sweep (`uniform-sync-sweep.ts`) that a
   * registered project's copy has drifted from the manager's, once it is no
   * longer scaffolding day: unlike `install`, a file already identical is
   * left untouched rather than rewritten, so the answer names exactly the
   * files that changed rather than every uniform file there is.
   *
   * Only checks the current `UNIFORM_FILES`: a file dropped from that list
   * stays behind in every project that already has it, uncopied and
   * unmentioned, since this only ever adds a project's copy back in step with
   * an entry that still exists, never removes one that doesn't.
   */
  sync(directory: Checkout): Promise<string[]>;

  /**
   * Compares `content` — a project's copy of the uniform file `file` — with
   * the harness's own: `"current"` when it is byte for byte the harness's
   * copy now, `"earlier"` when it is byte for byte a version the harness
   * held before, and `"different"` otherwise, including for a `file` that is
   * not in `UNIFORM_FILES` at all.
   *
   * What tells a sweep that merges its own sync pull request apart a copy
   * the harness has since moved on from — worth proposing again — from one
   * somebody edited, which is not the sweep's to merge.
   */
  compareUniform(file: string, content: string): Promise<UniformComparison>;
}
