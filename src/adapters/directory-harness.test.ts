import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { Checkout } from "../ports/index.ts";
import { UNIFORM_FILES, checkout } from "../ports/index.ts";
import { directoryHarness } from "./directory-harness.ts";
import { MANAGER_HOME } from "./manager-home.ts";

const INSTRUCTIONS = "# pilot\n\nA flight log that files itself.\n";

/** An empty project checkout, as a fresh clone would be. */
async function emptyCheckout(): Promise<Checkout> {
  return checkout(await mkdtemp(path.join(tmpdir(), "new-project-")));
}

async function contentsOf(directory: string, file: string): Promise<string> {
  return readFile(path.join(directory, file), "utf8");
}

describe("scaffolding the harness into a project", () => {
  it("copies every uniform file verbatim", async () => {
    const directory = await emptyCheckout();

    await directoryHarness().install(directory, INSTRUCTIONS);

    for (const file of UNIFORM_FILES) {
      assert.equal(
        await contentsOf(directory, file),
        await contentsOf(MANAGER_HOME, file),
        `${file} was not copied verbatim`,
      );
    }
  });

  it("writes the project's own agent instructions alongside them", async () => {
    const directory = await emptyCheckout();

    await directoryHarness().install(directory, INSTRUCTIONS);

    assert.equal(await contentsOf(directory, "AGENTS.md"), INSTRUCTIONS);
  });

  it("reports every path it wrote, relative to the checkout", async () => {
    const directory = await emptyCheckout();

    const scaffold = await directoryHarness().install(directory, INSTRUCTIONS);

    assert.deepEqual(scaffold.paths, [...UNIFORM_FILES, "AGENTS.md"]);
  });

  it("reports nothing overwritten in a checkout that had none of it", async () => {
    const directory = await emptyCheckout();

    const scaffold = await directoryHarness().install(directory, INSTRUCTIONS);

    assert.deepEqual(scaffold.overwritten, []);
  });

  it("names the project's own files it replaced, so a review can see it", async () => {
    const directory = await emptyCheckout();
    const theirs = UNIFORM_FILES[0] ?? "";
    await mkdir(path.join(directory, "docs", "agents"), { recursive: true });
    await writeFile(path.join(directory, theirs), "# ours, from before\n");

    const scaffold = await directoryHarness().install(directory, INSTRUCTIONS);

    assert.deepEqual(scaffold.overwritten, [theirs]);
  });

  it("leaves instructions a project already wrote for itself alone", async () => {
    const directory = await emptyCheckout();
    await writeFile(path.join(directory, "AGENTS.md"), "# mine\n");

    const scaffold = await directoryHarness().install(directory, INSTRUCTIONS);

    assert.equal(await contentsOf(directory, "AGENTS.md"), "# mine\n");
    assert.deepEqual(scaffold.paths, [...UNIFORM_FILES]);
    assert.ok(!scaffold.overwritten.includes("AGENTS.md"));
  });

  it("replaces uniform files that have drifted, since uniform is the point", async () => {
    const directory = await emptyCheckout();
    await mkdir(path.join(directory, "docs", "agents"), { recursive: true });
    await writeFile(path.join(directory, UNIFORM_FILES[0] ?? ""), "stale\n");

    await directoryHarness().install(directory, INSTRUCTIONS);

    assert.notEqual(await contentsOf(directory, UNIFORM_FILES[0] ?? ""), "stale\n");
  });

  it("installs nothing that points back at the manager", async () => {
    const directory = await emptyCheckout();

    const { paths } = await directoryHarness().install(directory, INSTRUCTIONS);

    for (const file of paths) {
      assert.doesNotMatch(
        await contentsOf(directory, file),
        /side-projects-manager|morning loop|registry\.json|managed location/i,
        `${file} refers back to the manager`,
      );
    }
  });

  it("fails naming the file when the harness source is not there", async () => {
    const harness = directoryHarness(await emptyCheckout());

    await assert.rejects(
      harness.install(await emptyCheckout(), INSTRUCTIONS),
      new RegExp(UNIFORM_FILES[0]?.replaceAll(".", "\\.") ?? ""),
    );
  });
});

describe("syncing a project's uniform files with the manager's", () => {
  it("reports every uniform file as changed in a checkout that had none of it", async () => {
    const directory = await emptyCheckout();

    const changed = await directoryHarness().sync(directory);

    assert.deepEqual(changed, [...UNIFORM_FILES]);
    for (const file of UNIFORM_FILES) {
      assert.equal(
        await contentsOf(directory, file),
        await contentsOf(MANAGER_HOME, file),
        `${file} was not copied verbatim`,
      );
    }
  });

  it("reports nothing changed, and touches nothing, once a checkout already matches", async () => {
    const directory = await emptyCheckout();
    await directoryHarness().install(directory, INSTRUCTIONS);

    const changed = await directoryHarness().sync(directory);

    assert.deepEqual(changed, []);
  });

  it("replaces and reports only the uniform files that had drifted, leaving the rest untouched", async () => {
    const directory = await emptyCheckout();
    await directoryHarness().install(directory, INSTRUCTIONS);
    const stale = UNIFORM_FILES[0] ?? "";
    await writeFile(path.join(directory, stale), "stale\n");

    const changed = await directoryHarness().sync(directory);

    assert.deepEqual(changed, [stale]);
    assert.equal(await contentsOf(directory, stale), await contentsOf(MANAGER_HOME, stale));
  });

  it("never touches the agent instructions", async () => {
    const directory = await emptyCheckout();
    await writeFile(path.join(directory, "AGENTS.md"), "# mine\n");

    await directoryHarness().sync(directory);

    assert.equal(await contentsOf(directory, "AGENTS.md"), "# mine\n");
  });
});

describe("comparing a project's copy of a uniform file with the manager's", () => {
  const FILE = UNIFORM_FILES[0];

  /** A source checkout whose one uniform file went from `first` to `second`. */
  async function sourceWithHistory(first: string, second: string): Promise<string> {
    const source = await mkdtemp(path.join(tmpdir(), "harness-source-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", source, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    git("init", "--quiet", "--initial-branch", "master");
    await mkdir(path.join(source, path.dirname(FILE)), { recursive: true });
    await writeFile(path.join(source, FILE), first);
    git("add", "--all");
    git("commit", "--quiet", "--message", "first");
    await writeFile(path.join(source, FILE), second);
    git("commit", "--quiet", "--all", "--message", "second");
    return source;
  }

  it("reads the current copy as current", async () => {
    const harness = directoryHarness(await sourceWithHistory("old\n", "new\n"));

    assert.equal(await harness.compareUniform(FILE, "new\n"), "current");
  });

  it("reads a version the manager held before as earlier", async () => {
    const harness = directoryHarness(await sourceWithHistory("old\n", "new\n"));

    assert.equal(await harness.compareUniform(FILE, "old\n"), "earlier");
  });

  it("reads a copy only the working tree holds as different, not current", async () => {
    const source = await sourceWithHistory("old\n", "new\n");
    await writeFile(path.join(source, FILE), "uncommitted\n");
    const harness = directoryHarness(source);

    assert.equal(await harness.compareUniform(FILE, "uncommitted\n"), "different");
  });

  it("reads a copy only another branch holds as different, not current", async () => {
    const source = await sourceWithHistory("old\n", "new\n");
    execFileSync("git", ["-C", source, "checkout", "--quiet", "-b", "feature"]);
    await writeFile(path.join(source, FILE), "on a branch\n");
    execFileSync("git", ["-C", source, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--all", "--message", "third"]);
    const harness = directoryHarness(source);

    assert.equal(await harness.compareUniform(FILE, "on a branch\n"), "different");
    assert.equal(await harness.compareUniform(FILE, "new\n"), "current");
  });

  it("reads anything else as different", async () => {
    const harness = directoryHarness(await sourceWithHistory("old\n", "new\n"));

    assert.equal(await harness.compareUniform(FILE, "edited\n"), "different");
  });

  it("reads a file that is not a uniform file as different, whatever it holds", async () => {
    const harness = directoryHarness(await sourceWithHistory("old\n", "new\n"));

    assert.equal(await harness.compareUniform("README.md", "new\n"), "different");
  });
});
