import { errorMessage } from "./error-message.ts";
import type { Harness, Proposal, RepoHost, RepoSlug } from "./ports/index.ts";
import { branch, UNIFORM_FILES } from "./ports/index.ts";

/** The {@link RepoHost} verbs and the one {@link Harness} verb a sweep calls. */
export interface UniformSyncSweepPorts {
  repoHost: Pick<
    RepoHost,
    "clone" | "hasUncommittedChanges" | "commitAndPropose"
  >;
  harness: Pick<Harness, "sync">;
}

/** A clone or a push the repo host refused a sweep, or a checkout found dirty. */
export interface UniformSyncSweepRefusal {
  kind: "refused";
  error: string;
}

/** One project's own end of a sweep: a {@link Proposal}, or a refusal met along the way. */
export type UniformSyncSweepResult = Proposal | UniformSyncSweepRefusal;

/** One uniform sync sweep of one registered project, and what it came to. */
export interface UniformSyncSweepOutcome {
  repo: RepoSlug;
  result: UniformSyncSweepResult;
}

/** What the sync commit says, whichever project it lands in. */
const SYNC_MESSAGE = "Bring the uniform files back in step with the manager's";

/** Where a stale project's sync waits for the developer. */
const SYNC_BRANCH = branch("uniform-sync");

/**
 * What a sweep answers when the checkout already has an uncommitted change
 * to a uniform file: `harness.sync` writes straight into the working tree,
 * so running it over that checkout would silently discard the developer's
 * own edit.
 */
const DIRTY_CHECKOUT_ERROR =
  "the checkout has an uncommitted change to a uniform file; syncing would overwrite it, so this sweep left it alone";

/**
 * A uniform sync sweep of one registered project (`CONTEXT.md`'s "Uniform
 * sync sweep"): clones it, refuses if the checkout already has an
 * uncommitted change to a uniform file, and otherwise asks `harness.sync` to
 * bring its uniform files back in step with the manager's own, and — only
 * when something had actually drifted — proposes the result rather than
 * pushing it straight to the checkout's own branch, the same as scaffolding a
 * project that predates the manager does.
 *
 * The dirty-checkout check is scoped to `UNIFORM_FILES` alone, not the whole
 * working tree: a developer's uncommitted work on anything else is none of
 * this sweep's business, the same as `commitAndPush` and `commitAndPropose`
 * only ever touch the paths they are given.
 *
 * A project already in step is left exactly as `harness.sync` found it:
 * nothing is committed, and `commitAndPropose` is never even asked, so this
 * answers `{ kind: "unchanged" }` without a pull request nobody needed.
 *
 * Never throws: a clone or a push the repo host refuses, or a checkout found
 * dirty, is answered with `{ kind: "refused" }` rather than raised, the same
 * best-effort policy a conflict sweep's own refusals follow, so one
 * project's trouble never stops the sweep of the next.
 */
export async function uniformSyncSweep(
  ports: UniformSyncSweepPorts,
  repo: RepoSlug,
): Promise<UniformSyncSweepOutcome> {
  try {
    const checkout = await ports.repoHost.clone(repo);
    if (
      await ports.repoHost.hasUncommittedChanges(checkout, [...UNIFORM_FILES])
    ) {
      return { repo, result: { kind: "refused", error: DIRTY_CHECKOUT_ERROR } };
    }
    const changed = await ports.harness.sync(checkout);
    if (changed.length === 0) {
      return { repo, result: { kind: "unchanged" } };
    }
    const result = await ports.repoHost.commitAndPropose(
      checkout,
      SYNC_MESSAGE,
      syncBody(changed),
      changed,
      SYNC_BRANCH,
    );
    return { repo, result };
  } catch (error) {
    return { repo, result: { kind: "refused", error: errorMessage(error) } };
  }
}

/** What the pull request says drifted, named rather than left to the diff. */
function syncBody(changed: string[]): string {
  return [
    "This project's copy of the uniform files had drifted from the manager's own. Brought back in step:",
    ...changed.map((file) => `- \`${file}\``),
  ].join("\n") + "\n";
}
