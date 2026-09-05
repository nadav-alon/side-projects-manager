import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { IssueTracker, RepoSlug, Ticket } from "../ports/index.ts";
import { READY_FOR_AGENT_LABEL } from "../ports/index.ts";

const execFileAsync = promisify(execFile);

const MAX_BACKLOG_SIZE = 1000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/**
 * The tracker port backed by the `gh` CLI, per `docs/agents/issue-tracker.md`.
 * Talks to whichever repo it is asked about; the developer's own `gh` login
 * is what authorizes it.
 */
export function ghIssueTracker(): IssueTracker {
  return {
    async listEligibleTickets(repo: RepoSlug): Promise<Ticket[]> {
      const { stdout } = await execFileAsync(
        "gh",
        [
          "issue",
          "list",
          "--repo",
          repo,
          "--state",
          "open",
          "--label",
          READY_FOR_AGENT_LABEL,
          "--json",
          "number,title",
          // gh caps results at 30 by default; the backlog contract promises
          // every eligible ticket, not a page of them.
          "--limit",
          String(MAX_BACKLOG_SIZE),
        ],
        { maxBuffer: MAX_OUTPUT_BYTES },
      );

      return parseIssues(stdout, repo).map((issue) => ({ repo, ...issue }));
    },
  };
}

/** `gh --json number,title`: a JSON array of `{ number, title }`. */
function parseIssues(
  stdout: string,
  repo: RepoSlug,
): Omit<Ticket, "repo">[] {
  const where = `gh issue list --repo ${repo}`;

  let issues: unknown;
  try {
    issues = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${where}: did not return JSON: ${errorMessage(error)}`);
  }
  if (!Array.isArray(issues)) {
    throw new Error(`${where}: expected a JSON array of issues.`);
  }

  return issues.map((issue, index) => {
    const at = `${where}: issue ${index + 1}`;
    if (typeof issue !== "object" || issue === null) {
      throw new Error(`${at}: expected an object.`);
    }
    const { number, title } = issue as Record<string, unknown>;
    if (typeof number !== "number") {
      throw new Error(`${at}: "number" must be a number.`);
    }
    if (typeof title !== "string") {
      throw new Error(`${at}: "title" must be a string.`);
    }
    return { number, title };
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
