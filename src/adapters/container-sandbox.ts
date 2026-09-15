import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type {
  ApplyReviewOutcome,
  ApplyReviewRequest,
  ApplyReviewTicket,
  Branch,
  Checkout,
  CommitSha,
  ModelName,
  ModelRefusal,
  PullRequestUrl,
  RemoteUrl,
  ReviewModelRefused,
  ReviewOutcome,
  ReviewRequest,
  ReviewTicket,
  RunModelRefused,
  RunOutcome,
  RunRequest,
  Sandbox,
  Ticket,
  Usd,
} from "../ports/index.ts";
import {
  branch,
  checkout,
  commitSha,
  isBranch,
  isCommitSha,
  isRemoteUrl,
  remoteUrl,
  tokenCount,
  type TokenCount,
} from "../ports/index.ts";
import { errorMessage } from "../error-message.ts";
import {
  isBranchReserved,
  reserveBranch,
  unreserveBranch,
} from "./branch-reservations.ts";
import { withCheckoutLock } from "./checkout-lock.ts";

const run = promisify(execFile);

/** The image the harness is baked into, as `npm run sandbox:build` tags it. */
const IMAGE = "side-projects-sandbox:latest";

/**
 * How much of the agent's output to hold in memory. A full implementation run
 * says far more than `execFile`'s 1 MB default allows, and overflowing it
 * kills the container mid-run.
 */
const OUTPUT_LIMIT = 64 * 1024 * 1024;

/**
 * How many branches of one name to try before giving up on a free one.
 *
 * A ticket that has come round this many mornings running is not a naming
 * problem; it is a ticket nobody is closing, and the developer should hear
 * about it rather than collect another branch.
 */
const BRANCH_ATTEMPTS = 10;

/** What one agent run in the container came back with. */
export interface AgentRun {
  /** Everything the agent said, kept for the ticket comment on failure. */
  output: string;
  tokensUsed: TokenCount;
  /**
   * Why the run did not finish cleanly, absent when it did. Reported rather
   * than thrown: an agent that fell over may have committed first, and its
   * spend is real either way.
   */
  failure?: string;
  /**
   * The CLI's own words refusing the model it was started on, absent unless
   * it flagged the model unrecognised — see `MODEL_REFUSAL`.
   */
  modelRefused?: string;
}

/**
 * The container could not run the agent at all: docker is missing or not
 * running, the image is not built, or there is no credential for the agent to
 * sign in with.
 *
 * Thrown rather than reported, because nothing ran — there are no commits, no
 * output and no spend to keep — and because it is the setup that needs fixing,
 * not the ticket. Every other way a container ends badly is an agent that ran
 * and stopped short, and comes back as the `"gave-up"` variant of a
 * `RunOutcome`/`ReviewOutcome`.
 */
export class AgentNeverRan extends Error {
  override name = "AgentNeverRan";
}

/**
 * Whether the clone mounted into the container may be written to.
 *
 * `"ro"` is half of what makes a reviewer's inability to push enforced rather
 * than merely asked for: a commit, or a push staged from *this* clone, fails
 * at the filesystem before it ever reaches a credential. The other half is
 * the credential itself — `envFor` forwards a separately scoped one for a
 * `"ro"` run, so a push staged from anywhere else in the container (a fresh
 * clone into `/tmp`, say) still cannot reach GitHub. Between the two, nothing
 * in this adapter's own doc comments needs to repeat that story; they refer
 * back to this one instead.
 */
export type Mount = "rw" | "ro";

/**
 * What one container invocation needs: the clone to mount, the prompt to run,
 * the spend ceiling to enforce, whether the clone is writable, and the model
 * to start the agent CLI on. Grouped into one options object because these
 * travel together across every boundary in this file — `Container`,
 * `attempt`, `dockerContainer` and `dockerCommand` all take exactly this and
 * nothing else.
 */
export interface RunOptions {
  /** The clone mounted into the container. */
  directory: Checkout;
  prompt: string;
  spendCeiling: Usd;
  mount: Mount;
  /** As `RunRequest.model`, absent to leave the image's own pin in force. */
  model?: ModelName;
}

/**
 * Runs the agent against `options.directory`, told to do `options.prompt`,
 * and allowed to spend at most `options.spendCeiling`.
 *
 * Throws `AgentNeverRan` when the agent could not be started. Anything else it
 * throws is an agent that ran and failed.
 *
 * A parameter rather than a hard-wired `docker run` so that the git half of
 * the sandbox — the clone, the branch, the commits — can be exercised without
 * docker, a credential, or a network.
 */
export type Container = (options: RunOptions) => Promise<AgentRun>;

/**
 * The sandbox: one agent, in a container, on a throwaway clone of the project.
 *
 * The clone is the whole safety story. The agent is handed a repository of its
 * own, so the developer's checkout is never committed to and never checked out
 * from under them; when the run ends, the branch is fetched back into the
 * checkout and the clone is deleted. The branch is the work — the clone was
 * only somewhere to do it.
 *
 * A clone rather than a `git worktree`, which is the obvious way to give an
 * agent its own branch and the wrong one here: a worktree's `.git` is a file
 * holding an absolute path into the parent repository, so a worktree bind-
 * mounted on its own is not a repository at all from inside the container.
 * A clone carries its objects with it and needs nothing else mounted.
 *
 * Calls run side by side, on one checkout or several: each works in a clone of
 * its own, so two containers never share anything but the checkout they came
 * from. The steps that do touch that checkout — choosing a branch name,
 * cloning, fetching a branch back — take its checkout lock, held for those git
 * steps and never while an agent works. Nothing here waits for a run to finish
 * before a review is budgeted: see docs/adr/0003 for why the gate accepts the
 * overshoot from runs in progress.
 */
export function containerSandbox(
  container: Container = dockerContainer,
  pullRequestHead: PullRequestHead = ghPullRequestHead,
): Sandbox {
  return new ContainerSandbox(container, pullRequestHead);
}

/**
 * `Sandbox`'s implementation, as a class rather than an object literal of
 * arrow functions: `run`, `review` and `applyReview` are each overloaded on
 * whether `request.model` is present, and only a method (or a standalone
 * function declaration) can carry more than one call signature — an arrow
 * assigned to an object property cannot.
 */
class ContainerSandbox implements Sandbox {
  private readonly container: Container;
  private readonly pullRequestHead: PullRequestHead;

  constructor(container: Container, pullRequestHead: PullRequestHead) {
    this.container = container;
    this.pullRequestHead = pullRequestHead;
  }

  applyReview(
    request: ApplyReviewRequest & { model: ModelName },
  ): Promise<ApplyReviewOutcome>;
  applyReview(
    request: ApplyReviewRequest & { model?: undefined },
  ): Promise<Exclude<ApplyReviewOutcome, ReviewModelRefused>>;
  applyReview(request: ApplyReviewRequest): Promise<ApplyReviewOutcome> {
    return applyReviewOnClone(this.container, this.pullRequestHead, request);
  }

  run(request: RunRequest & { model: ModelName }): Promise<RunOutcome>;
  run(
    request: RunRequest & { model?: undefined },
  ): Promise<Exclude<RunOutcome, RunModelRefused>>;
  run(request: RunRequest): Promise<RunOutcome> {
    return runOnClone(this.container, request);
  }

  review(request: ReviewRequest & { model: ModelName }): Promise<ReviewOutcome>;
  review(
    request: ReviewRequest & { model?: undefined },
  ): Promise<Exclude<ReviewOutcome, ReviewModelRefused>>;
  review(request: ReviewRequest): Promise<ReviewOutcome> {
    return reviewOnClone(this.container, request);
  }
}

async function runOnClone(
  container: Container,
  request: RunRequest,
): Promise<RunOutcome> {
  const { ticket, checkout: project, spendCeiling, model } = request;
  const clone = checkout(
    await mkdtemp(path.join(tmpdir(), "side-projects-run-")),
  );
  let onto: Branch | undefined;

  try {
    onto = await withCheckoutLock(project, async () => {
      const free = await freeBranch(project, branchFor(ticket));
      // `--no-hardlinks`: the clone is handed to an agent nobody is watching,
      // and nothing it does should be able to reach an object file the
      // developer's own checkout is still using. The container runs as the
      // developer's own uid (`dockerCommand`), so the filesystem would not
      // stop it — the copy is what does.
      await run("git", ["clone", "--no-hardlinks", "--quiet", project, clone]);
      reserveBranch(project, free);
      return free;
    });
    // Branded before the agent starts: a clone whose hashes this cannot read
    // fails the sandbox's set-up, not a run whose work is already done.
    const base = commitSha(await revision(clone, "HEAD"));
    await run("git", ["-C", clone, "switch", "--create", onto]);

    const agent = await attempt(container, {
      directory: clone,
      prompt: promptFor(ticket),
      spendCeiling,
      mount: "rw",
      ...(model === undefined ? {} : { model }),
    });
    const commits = await commitsSince(clone, base);

    // Only when the agent actually committed: a branch pointing at the commit
    // it started from is not work, and the checkout should not collect one
    // for every morning that came to nothing.
    if (commits.length > 0) {
      const branch = onto;
      await withCheckoutLock(project, () =>
        run("git", [
          "-C",
          project,
          "fetch",
          "--no-tags",
          clone,
          `${branch}:${branch}`,
        ]),
      );
    }

    return runOutcomeOf(agent, model, onto, commits);
  } finally {
    // If fetched back, the checkout now records the name; otherwise the name
    // is free again.
    if (onto !== undefined) {
      unreserveBranch(project, onto);
    }
    // Whatever became of the run, the clone does not outlive it — and a clone
    // that will not delete never costs the caller its result. A run this
    // process could not pin to a uid of its own (`hostUser`) can still leave
    // files it does not own behind; that is worth a warning, not the loss of a
    // branch that was pushed successfully.
    await rm(clone, { recursive: true, force: true }).catch(
      (error: unknown) => {
        console.warn(`Left ${clone} behind: ${errorMessage(error)}`);
      },
    );
  }
}

/**
 * One agent run, however it ends.
 *
 * A container that throws is a failed run, not a failed sandbox: the commits
 * it managed before it stopped are still work, its output is what says what
 * went wrong, and the tokens it spent were spent. Losing all three because the
 * process exited non-zero is the silent failure this adapter exists to avoid,
 * so the throw becomes a result the loop can record and report.
 *
 * Except a container that never started the agent. That has none of the three
 * to lose, and reporting it as a run would post "the agent gave up" on a ticket
 * nobody ever worked — so it goes to the caller as the sandbox failing.
 */
async function attempt(
  container: Container,
  options: RunOptions,
): Promise<AgentRun> {
  try {
    return await container(options);
  } catch (error: unknown) {
    if (error instanceof AgentNeverRan) {
      throw error;
    }
    return {
      output: errorMessage(error),
      tokensUsed: tokenCount(0),
      failure: errorMessage(error),
    };
  }
}

/**
 * How the provider words a limit refusal, as the agent CLI passes it on in
 * place of any answer: "You've hit your session limit · resets 1pm (UTC)", or
 * "You've hit your monthly spend limit · raise it at …" — a window's name can
 * be more than one word. Either apostrophe, since the wording is the
 * provider's to typeset.
 *
 * Anchored to the start of the output, which the refusal is the whole of, so
 * an agent that quotes the wording anywhere in what it says is not mistaken
 * for one refused. The only place that wording is known, so a CLI that
 * rewords it has one line here to change.
 */
const LIMIT_REFUSAL = /^\s*You['’]ve hit your [\w -]+? limit\b[^\n]*/;

/**
 * How the agent CLI flags a model it does not recognise, as captured from the
 * real CLI: `claude --print … --model <bogus> --output-format json` exits 1
 * and writes `[claude-code:unrecognized_model] {"model":"<bogus>",…}` to
 * stderr. Its envelope says only `"is_error": true`, with a `result` in prose
 * that could be reworded any morning, so the stderr tag is what is matched.
 *
 * Matched against stderr alone, never the agent's own words, so an agent that
 * quotes the tag is not mistaken for one refused. Anchored to the start of a
 * line (`m`), since other diagnostics can come before it. The only place this
 * line's shape is known, so a CLI that rewords it has one line here to change.
 */
const MODEL_REFUSAL = /^\[claude-code:unrecognized_model\][^\n]*/m;

/**
 * What `agent` carries once told apart from a finished agent: refused by the
 * model it was asked to run on, refused by the provider limit, or stopped for
 * a ticket reason. `RunOutcome` and `ReviewOutcome` differ only in whether a
 * branch and its commits ride alongside this, which `runOutcomeOf` and
 * `reviewOutcomeOf` each add for their own port.
 *
 * The model check comes first and only applies when `model` was actually
 * asked for and the CLI exited non-zero: a refused model is the ticket's
 * problem, not the agent's or the setup's, so it must not read as either, and
 * naming the model needs the request, not just the CLI's own words.
 */
function endingOf(
  agent: AgentRun,
  model: ModelName | undefined,
):
  | { kind: "finished"; output: string }
  | { kind: "gave-up"; output: string; reason: string }
  | { kind: "limit-refused"; words: string }
  | { kind: "model-refused"; refusal: ModelRefusal } {
  if (
    model !== undefined &&
    agent.failure !== undefined &&
    agent.modelRefused !== undefined
  ) {
    return { kind: "model-refused", refusal: { model, words: agent.modelRefused } };
  }
  const refusal = LIMIT_REFUSAL.exec(agent.output)?.[0];
  if (refusal !== undefined) {
    return { kind: "limit-refused", words: refusal.trim() };
  }
  return agent.failure === undefined
    ? { kind: "finished", output: agent.output }
    : { kind: "gave-up", output: agent.output, reason: agent.failure };
}

/** `endingOf`, with the branch an implementation run worked on and its commits. */
function runOutcomeOf(
  agent: AgentRun,
  model: ModelName | undefined,
  branch: Branch,
  commits: CommitSha[],
): RunOutcome {
  return { ...endingOf(agent, model), tokensUsed: agent.tokensUsed, branch, commits };
}

/** `endingOf`, as a review ends it: no branch or commits to carry. */
function reviewOutcomeOf(
  agent: AgentRun,
  model: ModelName | undefined,
): ReviewOutcome {
  return { ...endingOf(agent, model), tokensUsed: agent.tokensUsed };
}

/**
 * The reviewer's run: a throwaway clone of its own, exactly like an
 * implementation run, but mounted read-only and never fetched back — a
 * review leaves nothing on the checkout, because what it produces is a
 * comment on GitHub, not a branch.
 *
 * No branch is created either: a reviewer has nothing to commit, and asking
 * for one would suggest it might.
 */
async function reviewOnClone(
  container: Container,
  request: ReviewRequest,
): Promise<ReviewOutcome> {
  const { ticket, checkout: project, spendCeiling, model } = request;
  const clone = checkout(
    await mkdtemp(path.join(tmpdir(), "side-projects-review-")),
  );

  try {
    await withCheckoutLock(project, () =>
      run("git", ["clone", "--no-hardlinks", "--quiet", project, clone]),
    );
    const agent = await attempt(container, {
      directory: clone,
      prompt: reviewPromptFor(ticket),
      spendCeiling,
      mount: "ro",
      ...(model === undefined ? {} : { model }),
    });

    return reviewOutcomeOf(agent, model);
  } finally {
    await rm(clone, { recursive: true, force: true }).catch(
      (error: unknown) => {
        console.warn(`Left ${clone} behind: ${errorMessage(error)}`);
      },
    );
  }
}

/**
 * The apply-review run: a throwaway clone of its own, like any other, but
 * checked out on the pull request's head branch as the repo host has it now, and
 * mounted read-write — the agent commits there, pushes, and replies on the
 * pull request itself.
 *
 * Inside the container the checkout's path means nothing, so the clone's
 * `origin` is pointed at the checkout's own remote, and the branch tracks it:
 * a plain `git push` from the agent lands on the pull request. Nothing is
 * fetched back and no branch is created in the checkout — what the run did
 * lives on the repo host, and is read back from there.
 */
async function applyReviewOnClone(
  container: Container,
  pullRequestHead: PullRequestHead,
  request: ApplyReviewRequest,
): Promise<ApplyReviewOutcome> {
  const { ticket, checkout: project, spendCeiling, model } = request;
  const head = await pullRequestHead(ticket.pullRequest.url);
  const clone = checkout(
    await mkdtemp(path.join(tmpdir(), "side-projects-apply-review-")),
  );

  try {
    const remote = await withCheckoutLock(project, async () => {
      await run("git", ["clone", "--no-hardlinks", "--quiet", project, clone]);
      const { stdout } = await run("git", [
        "-C",
        project,
        "remote",
        "get-url",
        "origin",
      ]);
      const origin = stdout.trim();
      if (!isRemoteUrl(origin)) {
        throw new Error(
          `${project}'s origin is not an address a clone can push to: ${JSON.stringify(origin)}`,
        );
      }
      return origin;
    });
    await run("git", [
      "-C",
      clone,
      "remote",
      "set-url",
      "origin",
      pushableRemote(remote),
    ]);
    // `gh` answers git's credential requests from the `GH_TOKEN` the container
    // is handed, which is how the agent's push authenticates against GitHub.
    await run("git", [
      "-C",
      clone,
      "config",
      "credential.helper",
      "!gh auth git-credential",
    ]);
    await run("git", [
      "-C",
      clone,
      "fetch",
      "--quiet",
      "--no-tags",
      "origin",
      `+refs/heads/${head}:refs/remotes/origin/${head}`,
    ]);
    // `--force-create`: the clone already has a local branch of that name when
    // the checkout was on it, and that copy may be stale; the repo host's is the one.
    await run("git", [
      "-C",
      clone,
      "switch",
      "--quiet",
      "--track",
      "--force-create",
      head,
      `origin/${head}`,
    ]);

    const agent = await attempt(container, {
      directory: clone,
      prompt: applyReviewPromptFor(ticket),
      spendCeiling,
      mount: "rw",
      ...(model === undefined ? {} : { model }),
    });

    return applyReviewOutcomeOf(agent, model);
  } finally {
    await rm(clone, { recursive: true, force: true }).catch(
      (error: unknown) => {
        console.warn(`Left ${clone} behind: ${errorMessage(error)}`);
      },
    );
  }
}

/**
 * The line an apply-review agent ends its report with when the repo host rejected
 * its push because the branch moved, naming the head it moved to — as
 * `applyReviewPromptFor` asks for it. Anchored to the start of a line (`m`),
 * and matched only with a commit hash after it, so prose that merely mentions
 * a moved branch is not read as one; whatever the agent adds after the hash is
 * ignored, since a rejected push must not read as finished over a stray word.
 * The only place the line's shape is known.
 */
const BRANCH_MOVED = /^Branch moved: `?([0-9a-f]+)\b/m;

/** A full commit hash, SHA-1 or SHA-256, rather than an abbreviation of one. */
const FULL_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * `endingOf`, as an apply-review run ends it: no branch or commits to carry,
 * and an agent that reports the branch moved under its push has given up,
 * whatever its exit code — its commits never reached the pull request.
 */
function applyReviewOutcomeOf(
  agent: AgentRun,
  model: ModelName | undefined,
): ApplyReviewOutcome {
  const ending = endingOf(agent, model);
  const moved = BRANCH_MOVED.exec(agent.output)?.[1];
  if (
    (ending.kind === "finished" || ending.kind === "gave-up") &&
    moved !== undefined &&
    isCommitSha(moved)
  ) {
    // Only a full hash is carried: an abbreviation cannot be compared with
    // the head the repo host reports. The push was rejected all the same.
    return {
      kind: "gave-up",
      output: agent.output,
      reason: `The push was rejected: the pull request's branch had moved to ${moved}.`,
      ...(FULL_HASH.test(moved) ? { movedHead: moved } : {}),
      tokensUsed: agent.tokensUsed,
    };
  }
  return { ...ending, tokensUsed: agent.tokensUsed };
}

/**
 * `remote` as the container can push to it: an SSH GitHub remote becomes its
 * HTTPS address, since the container holds a token and no SSH key. Anything
 * else — HTTPS already, or a local path — is left as it is.
 *
 * Exported so the rewrite can be asserted without an SSH remote to push to.
 */
export function pushableRemote(remote: RemoteUrl): RemoteUrl {
  const ssh =
    /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/.exec(remote);
  return ssh === null ? remote : remoteUrl(`https://${ssh[1]}/${ssh[2]}.git`);
}

/**
 * Looks up the head branch of a pull request on the repo host.
 *
 * A parameter of the sandbox rather than a call made inline, so the git half
 * of an apply-review run can be exercised against a stand-in repo host without
 * `gh`, a credential, or a network.
 */
export type PullRequestHead = (pullRequest: PullRequestUrl) => Promise<Branch>;

/** The real lookup: `gh pr view`, read by `pullRequestHeadFrom`. */
const ghPullRequestHead: PullRequestHead = async (pullRequest) => {
  const { stdout } = await run("gh", [
    "pr",
    "view",
    pullRequest,
    "--json",
    "headRefName,isCrossRepository",
  ]);
  return pullRequestHeadFrom(stdout, pullRequest);
};

/**
 * The head branch in `gh pr view --json headRefName,isCrossRepository`'s
 * answer for `pullRequest`, checked before use.
 *
 * A pull request opened from a fork is refused, as is one `gh` does not say
 * is not: its head branch is not on the checkout's remote, which is where the
 * agent pushes, so the push would never reach the pull request.
 *
 * Exported so the answer's reading can be asserted without `gh`.
 */
export function pullRequestHeadFrom(
  stdout: string,
  pullRequest: PullRequestUrl,
): Branch {
  const { headRefName: name, isCrossRepository } = JSON.parse(stdout) as {
    headRefName?: unknown;
    isCrossRepository?: unknown;
  };
  if (isCrossRepository !== false) {
    throw new Error(
      `${pullRequest} is not known to come from a branch of its own repo, so its head cannot be pushed to from the checkout's remote.`,
    );
  }
  if (typeof name !== "string" || !isBranch(name)) {
    throw new Error(
      `gh named no usable head branch for ${pullRequest}: ${JSON.stringify(name)}`,
    );
  }
  return name;
}

/**
 * What the apply-review agent is asked to do: invoke the skill on the pull
 * request, named explicitly since nothing in the prompt otherwise says which.
 * The skill says how.
 *
 * The run is unattended, as a review's is, so a pass that stops to ask has
 * answered nothing. A rejected push is asked for as one fixed line naming the
 * moved head (`BRANCH_MOVED`), which is how the sandbox tells a run the repo host
 * refused from one that finished.
 */
function applyReviewPromptFor(ticket: ApplyReviewTicket): string {
  const url = ticket.pullRequest.url;
  return [
    `/apply-pr-review ${url}`,
    "",
    `This clone is already checked out on ${url}'s head branch, tracking it on GitHub, so a plain`,
    "`git push` lands on the pull request. Name the repo explicitly wherever gh needs one.",
    "This run is unattended: nobody is reading along, and nothing you ask will be answered, so",
    "work every thread, push and reply without asking for confirmation.",
    "If the push is rejected because the branch moved, stop, and end your report with the line",
    "`Branch moved: <full commit hash>`, naming the head the branch has on GitHub now",
    `(\`gh pr view ${url} --json headRefOid\`).`,
  ].join("\n");
}

/**
 * What the agent is asked to do. The repo's own instructions say how.
 *
 * `--repo` is spelled out because the clone's `origin` is a path on the host
 * filesystem: `gh` cannot work out which GitHub repo that is, and an agent
 * that cannot read its ticket implements the title and reports success.
 */
function promptFor(ticket: Ticket): string {
  return [
    `Implement issue #${ticket.number} in this repository: ${ticket.title}.`,
    `Read the issue with \`gh issue view ${ticket.number} --repo ${ticket.repo}\``,
    "first — this clone's origin is a local path, so gh cannot infer the repo",
    "— and follow this repo's own agent instructions and coding standards.",
    "Commit your work to the branch you are on; do not push, and do not open a",
    "pull request.",
  ].join(" ");
}

/**
 * What the reviewing agent is asked to do.
 *
 * The pull request is named explicitly for the same reason `promptFor` names
 * the issue: the clone's origin is a local path, so nothing GitHub-shaped can
 * be inferred from it. Everything else — the ticket the pull request closes,
 * and what it asked for — the agent works out for itself, from the pull
 * request's own body, because that is the one place the association still
 * exists once this process is the loop's next morning.
 *
 * Posting is spelled out as a single review with one inline comment per
 * finding — not the skill's own aggregated report dropped as one comment —
 * because a finding a reviewer would read in context of the line it is about
 * is exactly what a summary comment strips away. `RepoHost.hasNewComment`
 * checks for this same shape: an inline comment on the pull request, not an
 * issue-level one.
 *
 * The prompt also says the run is unattended. A `--print` run gets no reply,
 * so a reviewer that finishes and then asks whether to submit posts nothing;
 * the loop hands the ticket back and the findings survive only in its
 * hand-back comment.
 *
 * The reviewer posts with the developer's own `GH_TOKEN`, so an apply-review
 * workflow watching for that comment cannot tell the reviewer's from the
 * developer's by author. Acting on the review is the developer's call, never
 * the reviewer's.
 */
function reviewPromptFor(ticket: ReviewTicket): string {
  return [
    `Review ${ticket.pullRequest.url}, a draft pull request in this repository. Find the ticket it`,
    `closes from its own body (\`gh pr view ${ticket.pullRequest.url} --json body,files\`) and read that`,
    `ticket with \`gh issue view\`; name the repo explicitly wherever gh needs one, since this`,
    "clone's origin is a local path and gh cannot infer it. Run the two-axis review from the",
    "mattpocock-skills plugin explicitly as `/mattpocock-skills:code-review` — never the built-in",
    "`/code-review`, which is a different, single-axis review that does not check fidelity to the",
    "ticket — covering both conformance to this repo's own documented coding standards and whether",
    "the pull request does what the ticket asked for. The skill's own last step only aggregates the",
    "two reports; posting is yours to do, and not as that aggregate dropped in one comment. Post each",
    "finding inline, on the file and line it is actually about, by submitting a single review —",
    "`gh api repos/<owner>/<repo>/pulls/<number>/reviews --input -`, with `<owner>/<repo>` and",
    `\`<number>\` read off ${ticket.pullRequest.url} — piped a JSON object shaped`,
    '`{"event": "COMMENT", "comments": [{"path": <file>, "line": <line>, "body": <finding>}, ...]}`,',
    "one entry per finding. Leave the review's own top-level `body` for whatever has no single line to",
    "sit on — a one-line summary, or a finding that spans the whole change.",
    "This run is unattended: nobody is reading along, and nothing you ask will be answered. Posting",
    "the review is the job, so submit it without asking for confirmation — a review that stops at",
    "\"shall I submit?\" has posted nothing.",
    "You are reviewing, not implementing: do not commit or push anything — this checkout is",
    "read-only, so neither would work anyway.",
    "You post with the developer's own GitHub credential, so nothing marks a comment of yours",
    "apart from one the developer wrote. Never post a comment whose whole body is",
    "`/apply-review` — acting on this review is the developer's call, not yours.",
  ].join(" ");
}

/**
 * The branch a ticket's work lands on, in the `issue-<n>-<slug>` shape the
 * projects already use, so a branch reads the same whoever made it.
 */
function branchFor(ticket: Ticket): Branch {
  const slug = ticket.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return branch(
    slug === "" ? `issue-${ticket.number}` : `issue-${ticket.number}-${slug}`,
  );
}

/**
 * `wanted`, or the first free name after it: one the checkout has no branch
 * of, and no run in progress has reserved.
 *
 * A ticket stays selectable until somebody closes it, so the same ticket comes
 * round again on a later morning. A second attempt gets its own branch rather
 * than failing the morning or writing over what the first one left.
 *
 * Only under the checkout lock: a name found free here is free only until
 * another run looks.
 */
async function freeBranch(
  project: Checkout,
  wanted: Branch,
): Promise<Branch> {
  for (let attempt = 1; attempt <= BRANCH_ATTEMPTS; attempt++) {
    const candidate = attempt === 1 ? wanted : branch(`${wanted}-${attempt}`);
    if (
      !isBranchReserved(project, candidate) &&
      !(await hasBranch(project, candidate))
    ) {
      return candidate;
    }
  }
  throw new Error(
    `${project} already has ${BRANCH_ATTEMPTS} branches named after ${wanted}. Close the ticket, or clear the old ones out.`,
  );
}

async function hasBranch(project: Checkout, of: Branch): Promise<boolean> {
  try {
    await run("git", [
      "-C",
      project,
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${of}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function revision(directory: Checkout, of: string): Promise<string> {
  const { stdout } = await run("git", ["-C", directory, "rev-parse", of]);
  return stdout.trim();
}

/** The commits the agent made, oldest first. Empty when it committed none. */
async function commitsSince(
  clone: Checkout,
  base: CommitSha,
): Promise<CommitSha[]> {
  const { stdout } = await run(
    "git",
    ["-C", clone, "rev-list", "--reverse", `${base}..HEAD`],
    { maxBuffer: OUTPUT_LIMIT },
  );
  return stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => commitSha(line));
}

/**
 * The real container: the image from the Dockerfile, with the clone bound at
 * the workdir the image already declares.
 *
 * Credentials are passed through by name rather than by value, so no token
 * ever appears in an argument list: `--env GH_TOKEN` with no `=value` tells
 * docker to read it from *this process's own* environment, which `envFor` is
 * what varies per `Mount`.
 */
const dockerContainer: Container = async (options) => {
  // Asked here rather than left to the agent, which would start, fail to sign
  // in, and exit non-zero exactly as one that gave up on the ticket does.
  if (!process.env["CLAUDE_CODE_OAUTH_TOKEN"]) {
    throw new AgentNeverRan(
      "CLAUDE_CODE_OAUTH_TOKEN is not set, so the agent would have no way to sign in. Export it (see README) and run again.",
    );
  }

  const env = envFor(options.mount);
  const command = dockerCommand(options);

  try {
    const { stdout, stderr } = await run("docker", command, {
      maxBuffer: OUTPUT_LIMIT,
      env,
    });
    return readAgentRun(stdout, stderr);
  } catch (error: unknown) {
    if (dockerNeverRan(error)) {
      throw new AgentNeverRan(
        `docker could not start the agent: ${errorMessage(error)}`,
      );
    }
    return readExitedRun(error);
  }
};

/**
 * What an agent that exited non-zero came back with. Any exit `dockerNeverRan`
 * leaves alone is the agent's own, and it may have committed first. `execFile`
 * hangs the output it did capture off the error, so the run still comes back
 * with what it said and what it spent.
 *
 * Exported so a captured CLI exit can be read the way `dockerContainer` reads
 * it, without docker installed.
 */
export function readExitedRun(error: unknown): AgentRun {
  const { stdout, stderr } = captured(error);
  return { ...readAgentRun(stdout, stderr), failure: errorMessage(error) };
}

/**
 * The environment `docker` itself runs in, which is what `--env GH_TOKEN`
 * (named, not valued) forwards into the container.
 *
 * An `"rw"` run gets the developer's own `gh` credential, same as ever. A
 * `"ro"` run gets a distinct one, required rather than falling back: `Mount`
 * explains why a read-only mount alone does not stop a push staged from
 * somewhere else in the container, and forwarding the same push-capable
 * credential there regardless would leave that gap wide open. `GH_REVIEW_TOKEN`
 * closes it at GitHub's own authorization layer instead of the filesystem's —
 * scope it (see README) to Issues and Pull requests, without Contents access,
 * and a push or a merge attempted with it is refused by GitHub itself,
 * wherever in the container it was staged from.
 */
function envFor(mount: Mount): NodeJS.ProcessEnv {
  if (mount !== "ro") {
    return process.env;
  }

  const reviewToken = process.env["GH_REVIEW_TOKEN"];
  if (!reviewToken) {
    throw new AgentNeverRan(
      "GH_REVIEW_TOKEN is not set, so a reviewer would run with the same push-capable credential as an implementation. Create a token scoped to Issues and Pull requests only, no Contents access (see README), export it as GH_REVIEW_TOKEN, and run again.",
    );
  }
  return { ...process.env, GH_TOKEN: reviewToken, GITHUB_TOKEN: reviewToken };
}

/**
 * Whether `docker run` failed before the agent inside it ran.
 *
 * Docker keeps three exit codes for itself so that they can be told apart from
 * the container's: 125 when docker could not run the container (the daemon is
 * not running, the image is not there), 126 when the entrypoint could not be
 * invoked, and 127 when it could not be found. And `ENOENT` is docker not being
 * installed at all. Every other exit code is the agent's.
 *
 * Exported so the line can be asserted without docker installed: it is what
 * decides whether a ticket is told its agent gave up.
 */
export function dockerNeverRan(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const { code } = error;
  return code === "ENOENT" || code === 125 || code === 126 || code === 127;
}

/**
 * What the manager asks docker to run: the image, the clone bound at the
 * workdir it declares, and the agent invocation itself.
 *
 * Exported so the argument list can be asserted without docker installed.
 * Three of the flags in particular have to be visible to a test, because all
 * three fail quietly: the spend ceiling is the only thing bounding a run once
 * the run has started, and one that stopped being passed would cost a week
 * before anything said so; the permission mode is the only thing letting a run
 * touch the clone at all, and one that stopped being passed would report every
 * ticket as work the agent chose not to do; and the user pin is what makes the
 * agent's commits and files the developer's own — dropped, it fails on every
 * host whose developer is not the image's own uid, and looks like an agent
 * declining the work.
 *
 * `GH_TOKEN` and `GITHUB_TOKEN` are named the same regardless of `mount` —
 * see `Mount` and `envFor` for which credential answers to that name.
 *
 * Throws `AgentNeverRan` for a manager running as root, which is a setup no
 * unattended run can happen in — see `hostUser`.
 */
export function dockerCommand({
  directory,
  prompt,
  spendCeiling,
  mount,
  model,
}: RunOptions): string[] {
  const user = hostUser();

  return [
    "run",
    "--rm",
    // The clone is bind-mounted, so what the agent writes is written straight
    // into the developer's filesystem with whatever uid the container runs as.
    // Pinned to the invoking process's own, so the branch, the objects and any
    // stray file the run leaves behind belong to the developer and need no
    // sudo to delete. Which uid that is matters as well as whose: see
    // `hostUser` for root, the one it refuses to pin.
    ...(user ? ["--user", user] : []),
    "--volume",
    // Half the enforcement for a review — see `Mount`.
    `${directory}:/repo${mount === "ro" ? ":ro" : ""}`,
    "--env",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "--env",
    "GH_TOKEN",
    "--env",
    "GITHUB_TOKEN",
    IMAGE,
    "--print",
    prompt,
    "--output-format",
    "json",
    // Absent when the request named no model, leaving the image's own pin in
    // force. `model` is its own array element — `execFile` never runs through
    // a shell, so whatever the name contains reaches the CLI as one argument
    // rather than being interpreted.
    ...(model === undefined ? [] : ["--model", model]),
    // Without this the agent cannot act on the ticket at all. `--print`
    // defaults to `--permission-prompts host`, and there is no host here:
    // `execFile` is not one, and no `--permission-prompt-tool` is passed. So
    // every Bash, Write and Edit call is denied automatically, and the agent
    // reads its ticket, says it has no permission, and exits zero having
    // committed nothing — a morning that spends its tokens and reports "the
    // run left nothing behind" on every ticket it touches.
    //
    // Granted wholesale rather than as an allow-list of tool names. An
    // allow-list that included Bash — which it must, since a run's whole
    // product is commits and `git commit` is a shell call — grants the same
    // reach with more to keep in step, and one that omitted a tool the
    // harness reaches for would fail the same silent way this did.
    //
    // What bounds a run is the container, not this flag: the agent's whole
    // world is a throwaway clone of one project, and a review's is mounted
    // read-only with a credential that cannot push (see `Mount`).
    "--permission-mode",
    "bypassPermissions",
    // The spend ceiling, enforced by the agent CLI rather than by the manager:
    // nothing out here can stop a run that is already going, and a run that
    // overspends is exactly the one the gate cannot catch until the morning
    // after. The CLI accepts this only alongside `--print`, which is why it
    // sits with the flags above rather than anywhere else.
    "--max-budget-usd",
    String(spendCeiling),
  ];
}

/**
 * The `uid:gid` docker should run the container as: this process's own, so the
 * clone comes back owned by the developer who started the run.
 *
 * Undefined unless the host reports both. `process.getuid` and `process.getgid`
 * are POSIX-only — absent on Windows, and optional in the type definitions for
 * exactly that reason — and a run as the image's own default user is worth more
 * than a run that does not happen at all.
 *
 * Root is the exception, and it throws: pinning the container to uid 0 hands
 * the CLI a permission mode it refuses under root or sudo, so the run would
 * exit 1 having made no call — and exit 1 is the agent's own code as far as
 * `dockerNeverRan` is concerned, so a whole morning of tickets would be handed
 * back blaming an agent that never started. Falling back to the image's default
 * user instead would not save it either: the clone a root manager makes is
 * `mkdtemp`'s 0700 and owned by root, which uid 1000 cannot read. Nothing can
 * run as root here, and that is what `AgentNeverRan` says.
 */
function hostUser(): string | undefined {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    return undefined;
  }
  if (uid === 0) {
    throw new AgentNeverRan(
      "The manager is running as root, and an unattended agent cannot: the CLI refuses the permission mode a run needs under root or sudo. Run the loop as the developer who owns the checkout, without sudo, and run again.",
    );
  }
  return `${uid}:${gid}`;
}

/** What `execFile` captured before it rejected. Empty when it captured none. */
function captured(error: unknown): { stdout: string; stderr: string } {
  const output = error as { stdout?: unknown; stderr?: unknown };
  return {
    stdout: typeof output.stdout === "string" ? output.stdout : "",
    stderr: typeof output.stderr === "string" ? output.stderr : "",
  };
}

/**
 * What `claude --output-format json` said. Output the manager cannot parse is
 * still output worth keeping, so an unreadable envelope reports the raw text
 * and no spend rather than failing the run.
 *
 * `stderr` is appended rather than dropped: a run that went wrong says so
 * there, and that is exactly the run whose output somebody has to read. So are
 * the tools the CLI refused the agent — see `deniedTools`.
 *
 * A model refusal's words are the envelope's `result`, which is prose meant
 * for a reader, or the stderr tag itself when there is no `result` to quote.
 */
export function readAgentRun(stdout: string, stderr = ""): AgentRun {
  const refusalTag = MODEL_REFUSAL.exec(stderr)?.[0].trim();
  const envelope: unknown = parse(stdout);
  if (typeof envelope !== "object" || envelope === null) {
    return {
      output: withDiagnostics(stdout, stderr),
      tokensUsed: tokenCount(0),
      ...(refusalTag !== undefined && { modelRefused: refusalTag }),
    };
  }

  const { result, usage } = envelope as {
    result?: unknown;
    usage?: unknown;
  };
  return {
    output: withDiagnostics(
      typeof result === "string" ? result : stdout,
      stderr,
      deniedTools(envelope),
    ),
    tokensUsed: totalTokens(usage),
    ...(refusalTag !== undefined && {
      modelRefused: typeof result === "string" ? result.trim() : refusalTag,
    }),
  };
}

/**
 * The tools the CLI refused the agent, named once each in the order it first
 * refused them.
 *
 * A refusal is not an error to the CLI: it hands the agent a denial, the agent
 * says it cannot proceed, and the envelope comes back `"is_error": false` with
 * the denials listed in a field of their own. So a run refused everything it
 * needs is indistinguishable, from `result` and the exit code alone, from a run
 * that read the ticket and judged there was nothing to do — and that is exactly
 * how a whole invocation reported "the run left nothing behind" on eighteen
 * tickets while never being permitted to touch one of them.
 *
 * Read here, where the envelope already is, so the manager cannot go on
 * discarding the one field that says why a run came to nothing.
 */
function deniedTools(envelope: object): string[] {
  const { permission_denials: denials } = envelope as {
    permission_denials?: unknown;
  };
  if (!Array.isArray(denials)) {
    return [];
  }

  const names = denials
    .map((denial: unknown) =>
      typeof denial === "object" && denial !== null
        ? (denial as { tool_name?: unknown }).tool_name
        : undefined,
    )
    .filter((name): name is string => typeof name === "string");
  return [...new Set(names)];
}

/**
 * Everything worth keeping alongside what the agent said: what it wrote to
 * stderr, and what it was refused.
 */
function withDiagnostics(
  output: string,
  stderr: string,
  denied: readonly string[] = [],
): string {
  const notes = [
    output,
    stderr.trim() === "" ? "" : stderr,
    denied.length === 0
      ? ""
      : `The agent was refused these tools and could not use them: ${denied.join(", ")}.`,
  ].filter((note) => note !== "");
  return notes.join("\n");
}

function parse(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

/**
 * Every token the run was billed for: fresh input and output, and both cache
 * fields, which the ledger counts the same way.
 */
function totalTokens(usage: unknown): TokenCount {
  if (typeof usage !== "object" || usage === null) {
    return tokenCount(0);
  }
  const counts = usage as Record<string, unknown>;
  const total = [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ].reduce((sum, field) => {
    const value = counts[field];
    return sum + (typeof value === "number" ? value : 0);
  }, 0);
  return tokenCount(Math.max(0, Math.round(total)));
}
