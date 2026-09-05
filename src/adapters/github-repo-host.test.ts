import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
async function checkout(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "repo-host-"));
  const origin = path.join(root, "origin.git");
  const working = path.join(root, "pilot");

  await run("git", ["init", "--bare", "--initial-branch=main", origin]);
  await run("git", ["clone", origin, working]);
  await run("git", ["-C", working, "config", "user.email", "test@example.com"]);
  await run("git", ["-C", working, "config", "user.name", "Test"]);
  return working;
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

async function pushedFiles(directory: string): Promise<string[]> {
  return filesIn(directory, "origin/main");
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

describe("finding the checkout", () => {
  it("reuses a clone already in the managed location rather than replacing it", async () => {
    const directory = await checkout();
    await writeFile(path.join(directory, "mine.txt"), "kept\n");

    // The clone the test made is named after the repo half of the slug, which
    // is exactly where the adapter looks.
    const found = await githubRepoHost(path.dirname(directory)).clone(PILOT);

    assert.equal(found, directory);
    assert.equal(await readFile(path.join(found, "mine.txt"), "utf8"), "kept\n");
  });
});
