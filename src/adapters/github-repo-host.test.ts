import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { githubRepoHost } from "./github-repo-host.ts";
import { repoSlug } from "../ports/index.ts";

const PILOT = repoSlug("nadav-alon/pilot");

const run = promisify(execFile);

/**
 * A checkout with a bare repo behind it, so pushing is a real push. Only the
 * git half of the adapter is exercised here; everything that reaches GitHub
 * needs a credential and a network, and is left to the developer's own run.
 */
async function checkout(remote = "nadav-alon/pilot"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "repo-host-"));
  // Named as the remote it stands for, so the bare repo's path is what the
  // adapter compares the slug against.
  const origin = path.join(root, "origin", `${remote}.git`);
  const working = path.join(root, "location", "nadav-alon", "pilot");

  await mkdir(path.dirname(origin), { recursive: true });
  await run("git", ["init", "--bare", "--initial-branch=main", origin]);
  await run("git", ["clone", origin, working]);
  await run("git", ["-C", working, "config", "user.email", "test@example.com"]);
  await run("git", ["-C", working, "config", "user.name", "Test"]);
  return working;
}

/** The managed location a `checkout()` sits in. */
function locationOf(directory: string): string {
  return path.resolve(directory, "..", "..");
}

/** What `revision` actually contains, as opposed to what is merely staged. */
async function filesIn(directory: string, revision: string): Promise<string[]> {
  const { stdout } = await run("git", [
    "-C",
    directory,
    "ls-tree",
    "-r",
    "--name-only",
    revision,
  ]);
  return stdout.split("\n").filter((line) => line !== "");
}

async function committedFiles(directory: string): Promise<string[]> {
  return filesIn(directory, "HEAD");
}

async function pushedFiles(
  directory: string,
  branch = "origin/main",
): Promise<string[]> {
  return filesIn(directory, branch);
}

describe("publishing a scaffold", () => {
  it("commits and pushes the paths it was given", async () => {
    const directory = await checkout();
    await writeFile(path.join(directory, "AGENTS.md"), "# pilot\n");

    await githubRepoHost().commitAndPush(directory, "Install", ["AGENTS.md"]);

    assert.deepEqual(await committedFiles(directory), ["AGENTS.md"]);
    assert.deepEqual(await pushedFiles(directory), ["AGENTS.md"]);
  });

  it("leaves work the developer already had in the checkout uncommitted", async () => {
    const directory = await checkout();
    await writeFile(path.join(directory, "AGENTS.md"), "# pilot\n");
    await writeFile(path.join(directory, "half-finished.ts"), "// mine\n");
    await run("git", ["-C", directory, "add", "half-finished.ts"]);

    await githubRepoHost().commitAndPush(directory, "Install", ["AGENTS.md"]);

    assert.deepEqual(await committedFiles(directory), ["AGENTS.md"]);
    const { stdout } = await run("git", [
      "-C",
      directory,
      "status",
      "--porcelain",
      "half-finished.ts",
    ]);
    assert.match(stdout, /half-finished\.ts/);
  });

  it("commits nothing when the scaffold is already what is there", async () => {
    const directory = await checkout();
    await writeFile(path.join(directory, "AGENTS.md"), "# pilot\n");
    await githubRepoHost().commitAndPush(directory, "Install", ["AGENTS.md"]);

    await githubRepoHost().commitAndPush(directory, "Install again", [
      "AGENTS.md",
    ]);

    const { stdout } = await run("git", [
      "-C",
      directory,
      "log",
      "--format=%s",
    ]);
    assert.deepEqual(stdout.trim().split("\n"), ["Install"]);
  });
});

describe("publishing to a checkout the developer already had", () => {
  it("pushes to the branch it is on without re-pointing its upstream", async () => {
    const directory = await checkout();
    await writeFile(path.join(directory, "seed.md"), "seed\n");
    await githubRepoHost().commitAndPush(directory, "Seed", ["seed.md"]);
    await run("git", ["-C", directory, "checkout", "-b", "feature/x"]);
    await run("git", ["-C", directory, "push", "--set-upstream", "origin", "feature/x"]);
    await writeFile(path.join(directory, "AGENTS.md"), "# pilot\n");

    await githubRepoHost().commitAndPush(directory, "Install", ["AGENTS.md"]);

    const { stdout } = await run("git", [
      "-C",
      directory,
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]);
    assert.equal(stdout.trim(), "origin/feature/x");
    assert.deepEqual(await pushedFiles(directory, "origin/feature/x"), [
      "AGENTS.md",
      "seed.md",
    ]);
  });

  it("refuses a detached HEAD before committing anything to it", async () => {
    const directory = await checkout();
    await writeFile(path.join(directory, "seed.md"), "seed\n");
    await githubRepoHost().commitAndPush(directory, "Seed", ["seed.md"]);
    await run("git", ["-C", directory, "checkout", "--detach"]);
    await writeFile(path.join(directory, "AGENTS.md"), "# pilot\n");

    await assert.rejects(
      githubRepoHost().commitAndPush(directory, "Install", ["AGENTS.md"]),
      /not on a branch/,
    );
    assert.deepEqual(await committedFiles(directory), ["seed.md"]);
  });
});

describe("finding the checkout", () => {
  it("reuses a clone of this project already in the managed location", async () => {
    const directory = await checkout();
    await writeFile(path.join(directory, "mine.txt"), "kept\n");

    const found = await githubRepoHost(locationOf(directory)).clone(PILOT);

    assert.equal(found, directory);
    assert.equal(await readFile(path.join(found, "mine.txt"), "utf8"), "kept\n");
  });

  it("refuses a checkout of somebody else's repo of the same name", async () => {
    const directory = await checkout("someone-else/pilot");

    await assert.rejects(
      githubRepoHost(locationOf(directory)).clone(PILOT),
      /is a checkout of .*someone-else\/pilot/,
    );
  });

  it("puts a checkout at owner/repo, so two owners' repos of a name are two directories", async () => {
    const directory = await checkout();
    const location = locationOf(directory);

    assert.equal(
      await githubRepoHost(location).clone(PILOT),
      path.join(location, "nadav-alon", "pilot"),
    );
  });

  it("does not mistake a plain directory inside a repo for a checkout", async () => {
    const directory = await checkout();
    const nested = path.join(directory, "nadav-alon", "pilot");
    await mkdir(nested, { recursive: true });

    // Cloning is what the adapter should decide to do here, and it needs a
    // network to do it; that it got that far is the assertion.
    await assert.rejects(
      githubRepoHost(directory).clone(PILOT),
      (error: Error) => !/is a checkout of/.test(error.message),
    );
  });
});
