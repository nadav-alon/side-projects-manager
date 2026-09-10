import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  Proposal,
  RepoHost,
  RepoSlug,
  Ticket,
} from "../ports/index.ts";
import { MANAGED_LOCATION } from "./manager-home.ts";

const run = promisify(execFile);

/**
 * GitHub through `gh`, and the checkout through `git`, exactly as the harness
 * inside the sandbox reaches them (docs/agents/issue-tracker.md).
 *
 * Clones land under `location` at `owner/repo`, the same shape the project is
 * named by everywhere else. Derivable rather than remembered, which is what
 * makes a missing clone self-healing, and owner-qualified so that two people's
 * repos of the same name are two directories rather than one.
 */
export function githubRepoHost(location: string = MANAGED_LOCATION): RepoHost {
  return {
    async exists(repo: RepoSlug): Promise<boolean> {
      try {
        await run("gh", ["repo", "view", repo, "--json", "name"]);
        return true;
      } catch (error) {
        if (isUnresolvable(error)) {
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
      const directory = path.join(location, repo);
      await mkdir(path.dirname(directory), { recursive: true });

      const origin = await originOf(directory);
      if (origin === undefined) {
        await run("gh", ["repo", "clone", repo, directory]);
        return directory;
      }

      // A checkout already there is reused, but only once it has proved it is
      // this project. Scaffolding into somebody else's clone would push the
      // harness to their remote and register this project against a codebase
      // that is not it.
      if (!isCloneOf(origin, repo)) {
        throw new Error(
          `${directory} is a checkout of ${origin}, not of ${repo}. Move it aside, or clone ${repo} somewhere else yourself.`,
        );
      }
      return directory;
    },

    async commitAndPush(
      directory: string,
      message: string,
      paths: string[],
    ): Promise<void> {
      if (paths.length === 0) {
        return;
      }

      // Asked before anything is committed: a detached HEAD can be committed
      // to and then not pushed, which would leave the scaffold stranded in a
      // checkout with nowhere to go.
      const branch = await currentBranch(directory);
      if (branch === undefined) {
        throw new Error(
          `${directory} is not on a branch, so the harness has nowhere to land. Check out a branch and run this again.`,
        );
      }

      await run("git", ["-C", directory, "add", "--", ...paths]);

      // Nothing staged means the checkout already had these files as they
      // stand, which is what re-scaffolding an up-to-date project looks like.
      const { stdout } = await run("git", [
        "-C",
        directory,
        "diff",
        "--cached",
        "--name-only",
        "--",
        ...paths,
      ]);
      if (stdout.trim() === "") {
        return;
      }

      // `--only`: a checkout that already existed may have the developer's own
      // staged work in it, and this commit is not the place for it.
      await run("git", [
        "-C",
        directory,
        "commit",
        "--only",
        "--message",
        message,
        "--",
        ...paths,
      ]);

      // Upstream is set only when the branch has none, which is the case for a
      // repo created moments ago. A branch of the developer's that already
      // tracks something keeps tracking it.
      const upstream = (await hasUpstream(directory)) ? [] : ["--set-upstream"];
      await run("git", ["-C", directory, "push", ...upstream, "origin", branch]);
    },

    async commitAndPropose(
      directory: string,
      message: string,
      body: string,
      paths: string[],
      branch: string,
    ): Promise<Proposal> {
      if (paths.length === 0 || !(await hasChanges(directory, paths))) {
        return { kind: "unchanged" };
      }

      // Where to put the developer back. Asked before anything moves, because
      // afterwards the checkout is on the branch this command made.
      const found = await currentBranch(directory);

      await switchTo(directory, branch);
      try {
        // Staged first, because a path git has never seen cannot be named to
        // `commit --only`.
        await run("git", ["-C", directory, "add", "--", ...paths]);

        // `--only`: the checkout is the developer's, and work they had in
        // progress there is not this command's to commit.
        await run("git", [
          "-C",
          directory,
          "commit",
          "--only",
          "--message",
          message,
          "--",
          ...paths,
        ]);
        await run("git", [
          "-C",
          directory,
          "push",
          "--set-upstream",
          "origin",
          branch,
        ]);
      } finally {
        // Whatever happened, the developer gets their checkout back as they
        // left it. A branch switch carries their own uncommitted work across.
        await returnTo(directory, found);
      }

      try {
        const { stdout } = await run(
          "gh",
          [
            "pr",
            "create",
            "--draft",
            "--head",
            branch,
            "--title",
            message,
            "--body",
            body,
          ],
          { cwd: directory },
        );
        return { kind: "proposed", branch, url: stdout.trim() };
      } catch (error) {
        // The branch is on the host by now. A repo with pull requests turned
        // off, or a base branch nobody can open against, is a reason to say so
        // rather than to lose the push that already happened.
        return { kind: "pushed", branch, failure: errorMessage(error) };
      }
    },

    async openDraftPullRequest(
      directory: string,
      branch: string,
      ticket: Ticket,
    ): Promise<string> {
      // What the run branched from: the sandbox clones this checkout at its
      // HEAD, so the branch it is on is the base the commits actually sit on.
      // Asked rather than left to `gh`, which would open against the remote's
      // default branch and put every commit between the two in the diff.
      const base = await currentBranch(directory);

      // By name, not by checking it out: the branch came back from the sandbox
      // as a ref in this checkout, and the developer's own checkout is never
      // moved to push it.
      try {
        await run("git", [
          "-C",
          directory,
          "push",
          "--set-upstream",
          "origin",
          branch,
        ]);
      } catch (error) {
        // Most likely a branch of this name already on the host from an
        // earlier morning, which a checkout that has since been re-cloned
        // cannot see. Said plainly, because the raw push output does not.
        throw new Error(
          `Could not push ${branch} to ${ticket.repo}: ${errorMessage(error)}`,
        );
      }

      try {
        const { stdout } = await run(
          "gh",
          [
            "pr",
            "create",
            // Named rather than inferred: `gh` reads the base repo from the
            // remotes, preferring `upstream`, and only `origin` was ever
            // checked to be this project.
            "--repo",
            ticket.repo,
            "--draft",
            "--head",
            branch,
            ...(base === undefined ? [] : ["--base", base]),
            "--title",
            ticket.title,
            "--body",
            pullRequestBody(ticket),
          ],
          { cwd: directory },
        );
        return stdout.trim();
      } catch (error) {
        // The commits are on the host either way, so the branch is named here:
        // a morning whose pull request could not be opened still produced work,
        // and the developer needs to be able to find it.
        //
        // TODO[#13]: report this as a failed run rather than throwing, so the
        // morning still says what it did and what it cost.
        throw new Error(
          `Pushed ${branch} to ${ticket.repo}, but could not open a pull request for it: ${errorMessage(error)}`,
        );
      }
    },
  };
}

/**
 * What the pull request says. Short on purpose: the ticket says what was
 * wanted and the diff says what was done, and neither is worth restating.
 *
 * The closing reference is what links the two in GitHub's own UI. It closes
 * nothing by itself — the pull request is a draft, and only a merge the
 * developer makes acts on it.
 */
function pullRequestBody(ticket: Ticket): string {
  return [
    `Closes #${ticket.number}.`,
    "",
    "Implemented by the morning loop, in a sandbox, from the ticket above.",
    "It stays a draft: promoting and merging it are yours.",
  ].join("\n");
}

/** Whether any of `paths` differs from what the checkout has committed. */
async function hasChanges(
  directory: string,
  paths: string[],
): Promise<boolean> {
  const { stdout } = await run("git", [
    "-C",
    directory,
    "status",
    "--porcelain",
    "--",
    ...paths,
  ]);
  return stdout.trim() !== "";
}

/**
 * Puts the checkout on `branch`, creating it unless a previous run already
 * did.
 *
 * Re-running the command while a proposal is still open adds to that branch
 * rather than failing, which is what makes re-scaffolding after a convention
 * changes the same command as scaffolding the first time.
 */
async function switchTo(directory: string, branch: string): Promise<void> {
  try {
    await run("git", ["-C", directory, "checkout", "-b", branch]);
  } catch {
    await run("git", ["-C", directory, "checkout", branch]);
  }
}

/**
 * Returns the checkout to where it was found.
 *
 * `checkout` covers a branch with commits on it and, as `-`, a detached HEAD.
 * It cannot reach a branch that has none — an empty repo, whose HEAD points at
 * a branch that does not exist yet — so HEAD is pointed back by hand rather
 * than leaving the developer standing on the branch this command made.
 */
async function returnTo(
  directory: string,
  branch: string | undefined,
): Promise<void> {
  try {
    await run("git", ["-C", directory, "checkout", branch ?? "-"]);
  } catch (error) {
    if (branch === undefined) {
      throw error;
    }
    await run("git", [
      "-C",
      directory,
      "symbolic-ref",
      "HEAD",
      `refs/heads/${branch}`,
    ]);
  }
}

/** What `gh` or `git` said, preferring its stderr over the exit-code message. */
function errorMessage(error: unknown): string {
  const stderr =
    typeof error === "object" && error !== null && "stderr" in error
      ? String(error.stderr).trim()
      : "";
  if (stderr !== "") {
    return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The origin of the checkout whose root is exactly `directory`, or undefined
 * if there is no checkout there.
 *
 * The root has to match, because git answers questions about the nearest
 * enclosing repository: a plain directory inside one would otherwise look like
 * a checkout, and be committed and pushed into its parent.
 */
async function originOf(directory: string): Promise<string | undefined> {
  let toplevel: string;
  try {
    const { stdout } = await run("git", [
      "-C",
      directory,
      "rev-parse",
      "--show-toplevel",
    ]);
    toplevel = stdout.trim();
  } catch {
    return undefined;
  }

  if (!(await isSamePath(toplevel, directory))) {
    return undefined;
  }

  try {
    const { stdout } = await run("git", [
      "-C",
      directory,
      "remote",
      "get-url",
      "origin",
    ]);
    return stdout.trim();
  } catch {
    // A checkout with no origin is not this project's, whatever else it is.
    return "";
  }
}

async function isSamePath(one: string, other: string): Promise<boolean> {
  try {
    return (await realpath(one)) === (await realpath(other));
  } catch {
    return false;
  }
}

/**
 * Whether a remote URL names `repo`. Compares the `owner/repo` the URL ends
 * with, so the same project over HTTPS, SSH and the `git@` shorthand is the
 * same project.
 */
function isCloneOf(url: string, repo: RepoSlug): boolean {
  const segments = url
    .replace(/\.git$/, "")
    .split(/[/:]/)
    .filter((segment) => segment !== "");

  return segments.slice(-2).join("/").toLowerCase() === repo.toLowerCase();
}

/** The branch the checkout is on, or undefined on a detached HEAD. */
async function currentBranch(directory: string): Promise<string | undefined> {
  const { stdout } = await run("git", [
    "-C",
    directory,
    "branch",
    "--show-current",
  ]);
  const branch = stdout.trim();
  return branch === "" ? undefined : branch;
}

async function hasUpstream(directory: string): Promise<boolean> {
  try {
    await run("git", [
      "-C",
      directory,
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `gh` failed because it could not resolve the repository.
 *
 * GitHub answers a repo that is not there and a private repo the credential
 * cannot see with the same message, deliberately, so this cannot tell them
 * apart. Callers say both in the one sentence rather than asserting the first.
 */
function isUnresolvable(error: unknown): boolean {
  const stderr =
    typeof error === "object" && error !== null && "stderr" in error
      ? String(error.stderr)
      : "";
  return /could not resolve to a repository|HTTP 404/i.test(stderr);
}
