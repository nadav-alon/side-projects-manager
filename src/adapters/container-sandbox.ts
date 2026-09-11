import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type {
  Branch,
  Checkout,
  ReviewRequest,
  ReviewRunResult,
  ReviewTicket,
  RunRequest,
  Sandbox,
  SandboxRunResult,
  Ticket,
  Usd,
} from "../ports/index.ts";
import {
  branch,
  checkout,
  tokenCount,
  type TokenCount,
} from "../ports/index.ts";
import { errorMessage } from "../error-message.ts";

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
}

/**
 * The container could not run the agent at all: docker is missing or not
 * running, the image is not built, or there is no credential for the agent to
 * sign in with.
 *
 * Thrown rather than reported, because nothing ran — there are no commits, no
 * output and no spend to keep — and because it is the setup that needs fixing,
 * not the ticket. Every other way a container ends badly is an agent that ran
 * and stopped short, and comes back as a result carrying `failure`.
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
 * the spend ceiling to enforce, and whether the clone is writable. Grouped
 * into one options object because the four travel together across every
 * boundary in this file — `Container`, `attempt`, `dockerContainer` and
 * `dockerCommand` all take exactly this and nothing else.
 */
export interface RunOptions {
  /** The clone mounted into the container. */
  directory: Checkout;
  prompt: string;
  spendCeiling: Usd;
  mount: Mount;
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
 * Runs are serialized within this process: a second call waits for the first
 * rather than starting a container beside it, whether the two are runs,
 * reviews, or one of each — a review budgeted while an implementation is
 * still spending would make the gate's accounting a race. Two separate
 * invocations of the manager are not covered by this — the once-per-day lock
 * in #15 is what stops those overlapping.
 */
export function containerSandbox(
  container: Container = dockerContainer,
): Sandbox {
  // The tail of the queue. Never rejecting, so a failed run delays the work
  // behind it rather than cancelling it.
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task);
    queue = result.catch(() => undefined);
    return result;
  }

  return {
    run: (request: RunRequest) => enqueue(() => runOnClone(container, request)),
    review: (request: ReviewRequest) =>
      enqueue(() => reviewOnClone(container, request)),
  };
}

async function runOnClone(
  container: Container,
  request: RunRequest,
): Promise<SandboxRunResult> {
  const { ticket, checkout: project, spendCeiling } = request;
  const onto = await freeBranch(project, branchFor(ticket));
  const clone = checkout(
    await mkdtemp(path.join(tmpdir(), "side-projects-run-")),
  );

  try {
    // `--no-hardlinks`: the clone is handed to a container running as root
    // (TODO[#27]), and nothing it does should be able to reach an object file
    // the developer's own checkout is still using.
    await run("git", ["clone", "--no-hardlinks", "--quiet", project, clone]);
    const base = await revision(clone, "HEAD");
    await run("git", ["-C", clone, "switch", "--create", onto]);

    const agent = await attempt(container, {
      directory: clone,
      prompt: promptFor(ticket),
      spendCeiling,
      mount: "rw",
    });
    const commits = await commitsSince(clone, base);

    // Only when the agent actually committed: a branch pointing at the commit
    // it started from is not work, and the checkout should not collect one
    // for every morning that came to nothing.
    if (commits.length > 0) {
      await run("git", [
        "-C",
        project,
        "fetch",
        "--no-tags",
        clone,
        `${onto}:${onto}`,
      ]);
    }

    return {
      branch: onto,
      commits,
      output: agent.output,
      tokensUsed: agent.tokensUsed,
      ...(agent.failure !== undefined && { failure: agent.failure }),
    };
  } finally {
    // Whatever became of the run, the clone does not outlive it — and a clone
    // that will not delete never costs the caller its result. The agent runs
    // as root, so its files can be undeletable by the developer; that is worth
    // a warning, not the loss of a branch that was pushed successfully.
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
): Promise<ReviewRunResult> {
  const { ticket, checkout: project, spendCeiling } = request;
  const clone = checkout(
    await mkdtemp(path.join(tmpdir(), "side-projects-review-")),
  );

  try {
    await run("git", ["clone", "--no-hardlinks", "--quiet", project, clone]);
    const agent = await attempt(container, {
      directory: clone,
      prompt: reviewPromptFor(ticket),
      spendCeiling,
      mount: "ro",
    });

    return {
      output: agent.output,
      tokensUsed: agent.tokensUsed,
      ...(agent.failure !== undefined && { failure: agent.failure }),
    };
  } finally {
    await rm(clone, { recursive: true, force: true }).catch(
      (error: unknown) => {
        console.warn(`Left ${clone} behind: ${errorMessage(error)}`);
      },
    );
  }
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
 */
function reviewPromptFor(ticket: ReviewTicket): string {
  return [
    `Review ${ticket.pullRequest}, a draft pull request in this repository. Find the ticket it`,
    `closes from its own body (\`gh pr view ${ticket.pullRequest} --json body,files\`) and read that`,
    `ticket with \`gh issue view\`; name the repo explicitly wherever gh needs one, since this`,
    "clone's origin is a local path and gh cannot infer it. Run the two-axis review from the",
    "mattpocock-skills plugin explicitly as `/mattpocock-skills:code-review` — never the built-in",
    "`/code-review`, which is a different, single-axis review that does not check fidelity to the",
    "ticket — covering both conformance to this repo's own documented coding standards and whether",
    "the pull request does what the ticket asked for. The skill's own last step only aggregates the",
    "two reports; posting is yours to do, and not as that aggregate dropped in one comment. Post each",
    "finding inline, on the file and line it is actually about, by submitting a single review —",
    "`gh api repos/<owner>/<repo>/pulls/<number>/reviews --input -`, with `<owner>/<repo>` and",
    `\`<number>\` read off ${ticket.pullRequest} — piped a JSON object shaped`,
    '`{"event": "COMMENT", "comments": [{"path": <file>, "line": <line>, "body": <finding>}, ...]}`,',
    "one entry per finding. Leave the review's own top-level `body` for whatever has no single line to",
    "sit on — a one-line summary, or a finding that spans the whole change.",
    "You are reviewing, not implementing: do not commit or push anything — this checkout is",
    "read-only, so neither would work anyway.",
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
 * `wanted`, or the first free name after it.
 *
 * A ticket stays selectable until somebody closes it, so the same ticket comes
 * round again on a later morning. A second attempt gets its own branch rather
 * than failing the morning or writing over what the first one left.
 */
async function freeBranch(project: Checkout, wanted: Branch): Promise<Branch> {
  for (let attempt = 1; attempt <= BRANCH_ATTEMPTS; attempt++) {
    const candidate = attempt === 1 ? wanted : branch(`${wanted}-${attempt}`);
    if (!(await hasBranch(project, candidate))) {
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
async function commitsSince(clone: Checkout, base: string): Promise<string[]> {
  const { stdout } = await run(
    "git",
    ["-C", clone, "rev-list", "--reverse", `${base}..HEAD`],
    { maxBuffer: OUTPUT_LIMIT },
  );
  return stdout.split("\n").filter((line) => line !== "");
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
    // Any other non-zero exit is the agent's own, and it may have committed
    // first. `execFile` hangs the output it did capture off the error, so the
    // run still comes back with what it said and what it spent.
    const { stdout, stderr } = captured(error);
    return { ...readAgentRun(stdout, stderr), failure: errorMessage(error) };
  }
};

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
 * Exported so the argument list can be asserted without docker installed. The
 * spend ceiling in particular has to be visible to a test: it is the only
 * thing bounding a run once the run has started, and a flag that quietly stopped
 * being passed would not fail anything until a morning had spent the week.
 *
 * `GH_TOKEN` and `GITHUB_TOKEN` are named the same regardless of `mount` —
 * see `Mount` and `envFor` for which credential answers to that name.
 */
export function dockerCommand({
  directory,
  prompt,
  spendCeiling,
  mount,
}: RunOptions): string[] {
  return [
    "run",
    "--rm",
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
    // The spend ceiling, enforced by the agent CLI rather than by the manager:
    // nothing out here can stop a run that is already going, and a run that
    // overspends is exactly the one the gate cannot catch until the morning
    // after. The CLI accepts this only alongside `--print`, which is why it
    // sits with the flags above rather than anywhere else.
    "--max-budget-usd",
    String(spendCeiling),
  ];
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
 * there, and that is exactly the run whose output somebody has to read.
 */
export function readAgentRun(stdout: string, stderr = ""): AgentRun {
  const envelope: unknown = parse(stdout);
  if (typeof envelope !== "object" || envelope === null) {
    return {
      output: withDiagnostics(stdout, stderr),
      tokensUsed: tokenCount(0),
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
    ),
    tokensUsed: totalTokens(usage),
  };
}

function withDiagnostics(output: string, stderr: string): string {
  if (stderr.trim() === "") {
    return output;
  }
  return output === "" ? stderr : `${output}\n${stderr}`;
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
