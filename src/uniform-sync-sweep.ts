import { errorMessage } from "./error-message.ts";
import type {
  Checkout,
  Clock,
  Harness,
  Proposal,
  PullRequestUrl,
  RepoHost,
  RepoSlug,
  UniformComparison,
} from "./ports/index.ts";
import { branch, READY_FOR_HUMAN_PULL_REQUEST_LABEL, UNIFORM_FILES } from "./ports/index.ts";
import { settledChecks } from "./settled-checks.ts";

/** The {@link RepoHost} verbs and the one {@link Harness} verb a sweep calls. */
export interface UniformSyncSweepPorts {
  repoHost: Pick<
    RepoHost,
    | "clone"
    | "hasUncommittedChanges"
    | "commitAndPropose"
    | "openPullRequestOn"
    | "readPullRequestHead"
    | "readPullRequestFiles"
    | "readChecksStatus"
    | "labelPullRequest"
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

/**
 * A clone, a push or a read the repo host refused a sweep — including the
 * reads and label of the merge path — or a checkout found dirty.
 */
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
 * The sweep labelled its own sync pull request `ready-for-human` and left
 * it: `reason` says why the sweep would not merge it.
 */
export interface UniformSyncSweepLeftForHuman {
  kind: "left-for-human";
  url: PullRequestUrl;
  reason: string;
}

/**
 * The manager's own copy of a uniform file moved on after the sweep's pull
 * request was made: it holds an earlier version, so the sweep left it open
 * for the next sweep to propose again.
 */
export interface UniformSyncSweepOutdated {
  kind: "outdated";
  url: PullRequestUrl;
}

/**
 * One project's own end of a sweep: a {@link Proposal}, a merge of what it
 * proposed, or a refusal met along the way.
 */
export type UniformSyncSweepResult =
  | Proposal
  | UniformSyncSweepMerged
  | UniformSyncSweepLeftForHuman
  | UniformSyncSweepOutdated
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
 * Without `merge` the pull request is left open for the developer. One
 * already labelled `ready-for-human` is left alone entirely, turbo or not
 * — nothing pushed, nothing merged — and answered as `left-for-human` each
 * sweep, so the summary keeps naming it until the developer has dealt with it.
 *
 * Never throws: a clone, a push or a merge-path read the repo host refuses, or
 * a checkout found dirty, is answered with `{ kind: "refused" }` rather than raised, the same
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
    const waiting = await ports.repoHost.openPullRequestOn(repo, SYNC_BRANCH);
    if (waiting?.labels.includes(READY_FOR_HUMAN_PULL_REQUEST_LABEL)) {
      return {
        repo,
        result: { kind: "left-for-human", url: waiting.url, reason: "waiting on the developer" },
      };
    }
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
  const head = await ports.repoHost.readPullRequestHead(url);
  const verdict = await contentVerdict(ports, url, head);
  if (verdict.kind !== "current") {
    return verdict.kind === "earlier"
      ? { kind: "outdated", url }
      : leftForHuman(ports, url, verdict.reason);
  }
  const checks = await settledChecks(ports.repoHost, merge.clock, url);
  if (checks !== "green") {
    return leftForHuman(ports, url, checks === "pending" ? "checks still running" : "checks failing");
  }
  try {
    await ports.repoHost.markPullRequestReady(url);
    await ports.repoHost.mergePullRequest(url, head);
  } catch (error) {
    return leftForHuman(ports, url, errorMessage(error));
  }
  return { kind: "merged", url };
}

/** {@link contentVerdict}'s answer: a {@link UniformComparison} of the whole pull request. */
type ContentVerdict = { kind: Exclude<UniformComparison, "different"> } | { kind: "different"; reason: string };

/**
 * Whether `url`, as it stands at `head`, changes nothing but uniform files, each now exactly the
 * manager's own copy: `current`. One that is byte for byte an earlier
 * version of the manager's is `earlier` — the manager moved on since — and
 * anything else, a file outside `UNIFORM_FILES`, a deletion, or bytes the
 * manager never held, is `different`, naming the paths.
 */
async function contentVerdict(
  ports: UniformSyncSweepPorts,
  url: PullRequestUrl,
  head: string,
): Promise<ContentVerdict> {
  const files = await ports.repoHost.readPullRequestFiles(url, head);
  if (files.length === 0) {
    return { kind: "different", reason: "it changes no files" };
  }
  const different: string[] = [];
  let outdated = false;
  for (const file of files) {
    const comparison =
      file.content === undefined
        ? "different"
        : await ports.harness.compareUniform(file.path, file.content);
    if (comparison === "different") {
      different.push(file.path);
    } else if (comparison === "earlier") {
      outdated = true;
    }
  }
  if (different.length > 0) {
    return {
      kind: "different",
      reason: `it differs from the manager's uniform files in ${different.join(", ")}`,
    };
  }
  return { kind: outdated ? "earlier" : "current" };
}

/** `url` labelled `ready-for-human`, and the sweep's hands off it from here. */
async function leftForHuman(
  ports: UniformSyncSweepPorts,
  url: PullRequestUrl,
  reason: string,
): Promise<UniformSyncSweepLeftForHuman> {
  await ports.repoHost.labelPullRequest(url, READY_FOR_HUMAN_PULL_REQUEST_LABEL);
  return { kind: "left-for-human", url, reason };
}

/** What the pull request says drifted, named rather than left to the diff. */
function syncBody(changed: string[]): string {
  return [
    "This project's copy of the uniform files had drifted from the manager's own. Brought back in step:",
    ...changed.map((file) => `- \`${file}\``),
  ].join("\n") + "\n";
}
