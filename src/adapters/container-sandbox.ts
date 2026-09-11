import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type {
  Branch,
  Checkout,
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
 * Runs the agent against the clone mounted at `directory`, told to do
 * `prompt`, and allowed to spend at most `spendCeiling`.
 *
 * Throws `AgentNeverRan` when the agent could not be started. Anything else it
 * throws is an agent that ran and failed.
 *
 * A parameter rather than a hard-wired `docker run` so that the git half of
 * the sandbox — the clone, the branch, the commits — can be exercised without
 * docker, a credential, or a network.
 */
export type Container = (
  directory: Checkout,
  prompt: string,
  spendCeiling: Usd,
) => Promise<AgentRun>;

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
 * rather than starting a container beside it. Two separate invocations of the
 * manager are not covered by this — the once-per-day lock in #15 is what stops
 * those overlapping.
 */
export function containerSandbox(
  container: Container = dockerContainer,
): Sandbox {
  // The tail of the queue. Never rejecting, so a failed run delays the runs
  // behind it rather than cancelling them.
  let queue: Promise<unknown> = Promise.resolve();

  return {
    async run(request: RunRequest): Promise<SandboxRunResult> {
      const result = queue.then(() => runOnClone(container, request));
      queue = result.catch(() => undefined);
      return result;
    },
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

    const agent = await attempt(
      container,
      clone,
      promptFor(ticket),
      spendCeiling,
    );
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
  clone: Checkout,
  prompt: string,
  spendCeiling: Usd,
): Promise<AgentRun> {
  try {
    return await container(clone, prompt, spendCeiling);
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
 * ever appears in an argument list. `gh` needs one of its own: the prompt asks
 * the agent to read the ticket, and projects are private. Both spellings are
 * forwarded because `gh` accepts either, and which one a developer has
 * exported is not this adapter's business.
 */
const dockerContainer: Container = async (directory, prompt, spendCeiling) => {
  // Asked here rather than left to the agent, which would start, fail to sign
  // in, and exit non-zero exactly as one that gave up on the ticket does.
  if (!process.env["CLAUDE_CODE_OAUTH_TOKEN"]) {
    throw new AgentNeverRan(
      "CLAUDE_CODE_OAUTH_TOKEN is not set, so the agent would have no way to sign in. Export it (see README) and run again.",
    );
  }

  const command = dockerCommand(directory, prompt, spendCeiling);

  try {
    const { stdout, stderr } = await run("docker", command, {
      maxBuffer: OUTPUT_LIMIT,
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
 */
export function dockerCommand(
  directory: Checkout,
  prompt: string,
  spendCeiling: Usd,
): string[] {
  return [
    "run",
    "--rm",
    "--volume",
    `${directory}:/repo`,
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
