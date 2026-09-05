import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { RepoHost, RepoSlug } from "../ports/index.ts";
import { repoName } from "../ports/index.ts";
import { MANAGED_LOCATION } from "./manager-home.ts";

const run = promisify(execFile);

/**
 * GitHub through `gh`, and the checkout through `git`, exactly as the harness
 * inside the sandbox reaches them (docs/agents/issue-tracker.md).
 *
 * Clones land under `location`, one directory per repo name, which is what
 * makes a missing clone self-healing: the path is derivable rather than
 * remembered, so nothing has to record where a project went.
 */
export function githubRepoHost(location: string = MANAGED_LOCATION): RepoHost {
  return {
    async exists(repo: RepoSlug): Promise<boolean> {
      try {
        await run("gh", ["repo", "view", repo, "--json", "name"]);
        return true;
      } catch (error) {
        // `gh` fails the same way for a repo that isn't there and for a
        // credential that can't see it. Only the first is an answer; the
        // second has to reach the developer rather than become "create it".
        if (isNotFound(error)) {
          return false;
        }
        throw error;
      }
    },

    async create(repo: RepoSlug, description: string): Promise<void> {
      const options = description === "" ? [] : ["--description", description];
      await run("gh", ["repo", "create", repo, "--private", ...options]);
    },

    async clone(repo: RepoSlug): Promise<string> {
      const directory = path.join(location, repoName(repo));
      await mkdir(location, { recursive: true });

      // A clone already there is the developer's, and is left as it stands.
      if (await isCheckout(directory)) {
        return directory;
      }
      await run("gh", ["repo", "clone", repo, directory]);
      return directory;
    },

    async commitAndPush(directory: string, message: string): Promise<void> {
      await run("git", ["-C", directory, "add", "--all"]);

      const { stdout } = await run("git", [
        "-C",
        directory,
        "status",
        "--porcelain",
      ]);
      if (stdout.trim() === "") {
        return;
      }

      await run("git", ["-C", directory, "commit", "--message", message]);
      // `HEAD` rather than a branch name: a repo created moments ago has
      // whatever default branch the clone gave it, and this is the push that
      // decides it.
      await run("git", ["-C", directory, "push", "--set-upstream", "origin", "HEAD"]);
    },
  };
}

/** Whether `directory` is a git checkout rather than absent or a stray folder. */
async function isCheckout(directory: string): Promise<boolean> {
  try {
    await run("git", ["-C", directory, "rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

function isNotFound(error: unknown): boolean {
  const stderr =
    typeof error === "object" && error !== null && "stderr" in error
      ? String(error.stderr)
      : "";
  return /could not resolve to a repository|not found/i.test(stderr);
}
