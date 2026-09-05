import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { Sandbox, SandboxRunResult, Ticket } from "../ports/index.ts";
import { tokenCount, type TokenCount } from "../ports/index.ts";

const run = promisify(execFile);

/** The image the harness is baked into, as `npm run sandbox:build` tags it. */
const IMAGE =
  process.env["SIDE_PROJECTS_SANDBOX_IMAGE"] || "side-projects-sandbox:latest";

/**
 * How much of the agent's output to hold in memory. A full implementation run
 * says far more than `execFile`'s 1 MB default allows, and overflowing it
 * kills the container mid-run.
 */
const OUTPUT_LIMIT = 64 * 1024 * 1024;

/** How many branches of one name to try before giving up on a free one. */
const BRANCH_ATTEMPTS = 100;

/** What one agent run in the container came back with. */
export interface AgentRun {
  /** Everything the agent said, kept for the ticket comment on failure. */
  output: string;
  tokensUsed: TokenCount;
}

/**
 * Runs the agent against the workspace mounted at `directory`, told to do
 * `prompt`.
 *
 * A parameter rather than a hard-wired `docker run` so that the git half of
 * the sandbox — the workspace, the branch, the commits — can be exercised
 * without docker, a credential, or a network.
 */
export type Container = (
  directory: string,
  prompt: string,
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
    async run(ticket: Ticket, checkout: string): Promise<SandboxRunResult> {
      const result = queue.then(() => runOnClone(container, ticket, checkout));
      queue = result.catch(() => undefined);
      return result;
    },
  };
}

async function runOnClone(
  container: Container,
  ticket: Ticket,
  checkout: string,
): Promise<SandboxRunResult> {
  const branch = await freeBranch(checkout, branchFor(ticket));
  const workspace = await mkdtemp(path.join(tmpdir(), "side-projects-run-"));

  try {
    // `--no-hardlinks`: the clone is handed to a container running as root
    // (TODO[#27]), and nothing it does should be able to reach an object file
    // the developer's own checkout is still using.
    await run("git", ["clone", "--no-hardlinks", "--quiet", checkout, workspace]);
    const base = await revision(workspace, "HEAD");
    await run("git", ["-C", workspace, "switch", "--create", branch]);

    const agent = await container(workspace, promptFor(ticket));
    const commits = await commitsSince(workspace, base);

    // Only when the agent actually committed: a branch pointing at the commit
    // it started from is not work, and the checkout should not collect one
    // for every morning that came to nothing.
    if (commits.length > 0) {
      await run("git", [
        "-C",
        checkout,
        "fetch",
        "--no-tags",
        workspace,
        `${branch}:${branch}`,
      ]);
    }

    return {
      branch,
      commits,
      output: agent.output,
      tokensUsed: agent.tokensUsed,
    };
  } finally {
    // Whatever became of the run, the clone does not outlive it — and a clone
    // that will not delete never costs the caller its result. The agent runs
    // as root, so its files can be undeletable by the developer; that is worth
    // a warning, not the loss of a branch that was pushed successfully.
    await rm(workspace, { recursive: true, force: true }).catch(
      (error: unknown) => {
        console.warn(`Left ${workspace} behind: ${describe(error)}`);
      },
    );
  }
}

/** What the agent is asked to do. The repo's own instructions say how. */
function promptFor(ticket: Ticket): string {
  return [
    `Implement issue #${ticket.number} in this repository: ${ticket.title}.`,
    "Read the issue with `gh issue view` first, and follow this repo's own",
    "agent instructions and coding standards. Commit your work to the branch",
    "you are on; do not push, and do not open a pull request.",
  ].join(" ");
}

/**
 * The branch a ticket's work lands on, in the `issue-<n>-<slug>` shape the
 * projects already use, so a branch reads the same whoever made it.
 */
function branchFor(ticket: Ticket): string {
  const slug = ticket.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug === ""
    ? `issue-${ticket.number}`
    : `issue-${ticket.number}-${slug}`;
}

/**
 * `wanted`, or the first free name after it.
 *
 * A ticket stays selectable until somebody closes it, so the same ticket comes
 * round again on a later morning. A second attempt gets its own branch rather
 * than failing the morning or writing over what the first one left.
 */
async function freeBranch(checkout: string, wanted: string): Promise<string> {
  for (let attempt = 1; attempt <= BRANCH_ATTEMPTS; attempt++) {
    const candidate = attempt === 1 ? wanted : `${wanted}-${attempt}`;
    if (!(await hasBranch(checkout, candidate))) {
      return candidate;
    }
  }
  throw new Error(
    `${checkout} already has ${BRANCH_ATTEMPTS} branches named after ${wanted}. Clear the old ones out.`,
  );
}

async function hasBranch(checkout: string, branch: string): Promise<boolean> {
  try {
    await run("git", [
      "-C",
      checkout,
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function revision(directory: string, of: string): Promise<string> {
  const { stdout } = await run("git", ["-C", directory, "rev-parse", of]);
  return stdout.trim();
}

/** The commits the agent made, oldest first. Empty when it committed none. */
async function commitsSince(
  workspace: string,
  base: string,
): Promise<string[]> {
  const { stdout } = await run(
    "git",
    ["-C", workspace, "rev-list", "--reverse", `${base}..HEAD`],
    { maxBuffer: OUTPUT_LIMIT },
  );
  return stdout.split("\n").filter((line) => line !== "");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The real container: the image from the Dockerfile, with the clone bound at
 * the workdir the image already declares.
 *
 * Credentials are passed through by name rather than by value, so no token
 * ever appears in an argument list. `gh` needs one of its own: the prompt asks
 * the agent to read the ticket, and projects are private.
 */
const dockerContainer: Container = async (directory, prompt) => {
  const { stdout } = await run(
    "docker",
    [
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
    ],
    { maxBuffer: OUTPUT_LIMIT },
  );
  return readAgentRun(stdout);
};

/**
 * What `claude --output-format json` said. Output the manager cannot parse is
 * still output worth keeping, so an unreadable envelope reports the raw text
 * and no spend rather than failing the run.
 */
export function readAgentRun(stdout: string): AgentRun {
  const envelope: unknown = parse(stdout);
  if (typeof envelope !== "object" || envelope === null) {
    return { output: stdout, tokensUsed: tokenCount(0) };
  }

  const { result, usage } = envelope as {
    result?: unknown;
    usage?: unknown;
  };
  return {
    output: typeof result === "string" ? result : stdout,
    tokensUsed: totalTokens(usage),
  };
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
