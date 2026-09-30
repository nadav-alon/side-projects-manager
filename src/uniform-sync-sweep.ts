import { errorMessage } from "./error-message.ts";
import type {
  Checkout,
  Clock,
  Harness,
  Proposal,
  PullRequestUrl,
  RepoHost,
  RepoSlug,
} from "./ports/index.ts";
import { branch, UNIFORM_FILES } from "./ports/index.ts";
import { settledChecks } from "./settled-checks.ts";

/** The {@link RepoHost} verbs and the one {@link Harness} verb a sweep calls. */
export interface UniformSyncSweepPorts {
  repoHost: Pick<
    RepoHost,
    | "clone"
    | "hasUncommittedChanges"
    | "commitAndPropose"
    | "openPullRequestOn"
    | "readPullRequestFiles"
    | "readChecksStatus"
    | "markPullRequestReady"
    | "mergePullRequest"
  >;
  harness: Pick<Harness, "sync" | "compareUniform">;
}

/**
 * What a project standing turbo hands a sweep so it can merge its own sync
 * pull request: the clock it waits out pending checks on.
 */
export interface UniformSyncMerge {
  clock: Clock;
}

/** A clone or a push the repo host refused a sweep, or a checkout found dirty. */
export interface UniformSyncSweepRefusal {
  kind: "refused";
  error: string;
}

/** The sweep merged its own sync pull request. */
export interface UniformSyncSweepMerged {
  kind: "merged";
  url: PullRequestUrl;
}

/**
 * One project's own end of a sweep: a {@link Proposal}, a merge of what it
 * proposed, or a refusal met along the way.
 */
export type UniformSyncSweepResult =
  | Proposal
  | UniformSyncSweepMerged
  | UniformSyncSweepRefusal;

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
 * What a sweep answers when `checkout` already has an uncommitted change to
 * a uniform file: `harness.sync` writes straight into the working tree, so
 * running it over that checkout would silently discard the developer's own
 * edit. Names `checkout` itself, not which of `UNIFORM_FILES` is dirty:
 * `hasUncommittedChanges` only answers a boolean, so this sweep has no path
 * to name.
 */
function dirtyCheckoutError(checkout: Checkout): string {
  return `${checkout} has an uncommitted change to a uniform file; syncing would overwrite it, so this sweep left it alone`;
}

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
 * The dirty-checkout check runs only once `clone` has returned, and `clone`
 * catches the checkout up with its remote first. An uncommitted edit to a
 * uniform file the remote has also changed since is still refused, and the
 * edit still untouched either way, but as `clone`'s own generic refusal
 * rather than {@link dirtyCheckoutError} — see
 * `github-repo-host.test.ts`'s "refuses to catch up when an uncommitted edit
 * conflicts with what landed upstream on the same file".
 *
 * A project standing turbo passes `merge`, and a pull request the sweep
 * proposed or pushed to is then merged right away — ADR 0011 — once its
 * checks read green, waiting out pending ones the way the merge gate does.
 * Without `merge` the pull request is left open for the developer.
 *
 * Never throws: a clone or a push the repo host refuses, or a checkout found
 * dirty, is answered with `{ kind: "refused" }` rather than raised, the same
 * best-effort policy a conflict sweep's own refusals follow, so one
 * project's trouble never stops the sweep of the next.
 */
export async function uniformSyncSweep(
  ports: UniformSyncSweepPorts,
  repo: RepoSlug,
  merge?: UniformSyncMerge,
): Promise<UniformSyncSweepOutcome> {
  try {
    const checkout = await ports.repoHost.clone(repo);
    if (
      await ports.repoHost.hasUncommittedChanges(checkout, UNIFORM_FILES)
    ) {
      return {
        repo,
        result: { kind: "refused", error: dirtyCheckoutError(checkout) },
      };
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
    if (merge === undefined) {
      return { repo, result };
    }
    return { repo, result: await mergeProposed(ports, repo, result, merge) };
  } catch (error) {
    return { repo, result: { kind: "refused", error: errorMessage(error) } };
  }
}

/**
 * Merges the sync pull request `proposal` left open, once its checks read
 * green. A proposal with no pull request known to be open is answered as it
 * was: there is nothing to merge.
 */
async function mergeProposed(
  ports: UniformSyncSweepPorts,
  repo: RepoSlug,
  proposal: Proposal,
  merge: UniformSyncMerge,
): Promise<UniformSyncSweepResult> {
  if (proposal.kind === "unchanged") {
    return proposal;
  }
  const url =
    proposal.kind === "proposed"
      ? proposal.url
      : (await ports.repoHost.openPullRequestOn(repo, SYNC_BRANCH))?.url;
  if (url === undefined) {
    return proposal;
  }
  await settledChecks(ports.repoHost, merge.clock, url);
  await ports.repoHost.markPullRequestReady(url);
  await ports.repoHost.mergePullRequest(url);
  return { kind: "merged", url };
}

/** What the pull request says drifted, named rather than left to the diff. */
function syncBody(changed: string[]): string {
  return [
    "This project's copy of the uniform files had drifted from the manager's own. Brought back in step:",
    ...changed.map((file) => `- \`${file}\``),
  ].join("\n") + "\n";
}
