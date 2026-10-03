import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { Checkout } from "../ports/index.ts";
import { UNIFORM_FILES, checkout } from "../ports/index.ts";
import { directoryHarness } from "./directory-harness.ts";
import { MANAGER_HOME } from "./manager-home.ts";

const INSTRUCTIONS = "# pilot\n\nA flight log that files itself.\n";
const STANDARDS = "# Project standards\n\nMine.\n";

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

    await directoryHarness().install(directory, INSTRUCTIONS, STANDARDS);

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

    await directoryHarness().install(directory, INSTRUCTIONS, STANDARDS);

    assert.equal(await contentsOf(directory, "AGENTS.md"), INSTRUCTIONS);
  });

  it("reports every path it wrote, relative to the checkout", async () => {
    const directory = await emptyCheckout();

    const scaffold = await directoryHarness().install(directory, INSTRUCTIONS, STANDARDS);

    assert.deepEqual(scaffold.paths, [
      ...UNIFORM_FILES,
      "AGENTS.md",
      "docs/project-standards.md",
    ]);
  });

  it("reports nothing overwritten in a checkout that had none of it", async () => {
    const directory = await emptyCheckout();

    const scaffold = await directoryHarness().install(directory, INSTRUCTIONS, STANDARDS);

    assert.deepEqual(scaffold.overwritten, []);
  });

  it("names the project's own files it replaced, so a review can see it", async () => {
    const directory = await emptyCheckout();
    const theirs = UNIFORM_FILES[0] ?? "";
    await mkdir(path.join(directory, "docs", "agents"), { recursive: true });
    await writeFile(path.join(directory, theirs), "# ours, from before\n");

    const scaffold = await directoryHarness().install(directory, INSTRUCTIONS, STANDARDS);

    assert.deepEqual(scaffold.overwritten, [theirs]);
  });

  it("leaves instructions a project already wrote for itself alone", async () => {
    const directory = await emptyCheckout();
    await writeFile(path.join(directory, "AGENTS.md"), "# mine\n");

    const scaffold = await directoryHarness().install(directory, INSTRUCTIONS, STANDARDS);

    assert.equal(await contentsOf(directory, "AGENTS.md"), "# mine\n");
    assert.deepEqual(scaffold.paths, [...UNIFORM_FILES, "docs/project-standards.md"]);
    assert.ok(!scaffold.overwritten.includes("AGENTS.md"));
  });

  it("writes the standards it is given as docs/project-standards.md", async () => {
    const directory = await emptyCheckout();

    await directoryHarness().install(directory, INSTRUCTIONS, STANDARDS);

    assert.equal(await contentsOf(directory, "docs/project-standards.md"), STANDARDS);
  });

  it("leaves a standards file the project already has alone", async () => {
    const directory = await emptyCheckout();
    await mkdir(path.join(directory, "docs"), { recursive: true });
    await writeFile(path.join(directory, "docs/project-standards.md"), "# mine\n");

    const scaffold = await directoryHarness().install(directory, INSTRUCTIONS, STANDARDS);

    assert.equal(await contentsOf(directory, "docs/project-standards.md"), "# mine\n");
    assert.ok(!scaffold.paths.includes("docs/project-standards.md"));
    assert.ok(!scaffold.overwritten.includes("docs/project-standards.md"));
  });

  it("does not sync the standards file, nor count it uniform", async () => {
    const directory = await emptyCheckout();

    const changed = await directoryHarness().sync(directory);

    assert.ok(!changed.includes("docs/project-standards.md"));
    assert.ok(!(UNIFORM_FILES as readonly string[]).includes("docs/project-standards.md"));
  });

  it("replaces uniform files that have drifted, since uniform is the point", async () => {
    const directory = await emptyCheckout();
    await mkdir(path.join(directory, "docs", "agents"), { recursive: true });
    await writeFile(path.join(directory, UNIFORM_FILES[0] ?? ""), "stale\n");

    await directoryHarness().install(directory, INSTRUCTIONS, STANDARDS);

    assert.notEqual(await contentsOf(directory, UNIFORM_FILES[0] ?? ""), "stale\n");
  });

  it("installs nothing that points back at the manager", async () => {
    const directory = await emptyCheckout();

    const { paths } = await directoryHarness().install(directory, INSTRUCTIONS, STANDARDS);

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
      harness.install(await emptyCheckout(), INSTRUCTIONS, STANDARDS),
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
    await directoryHarness().install(directory, INSTRUCTIONS, STANDARDS);

    const changed = await directoryHarness().sync(directory);

    assert.deepEqual(changed, []);
  });

  it("replaces and reports only the uniform files that had drifted, leaving the rest untouched", async () => {
    const directory = await emptyCheckout();
    await directoryHarness().install(directory, INSTRUCTIONS, STANDARDS);
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

describe("the standards a new project starts with", () => {
  it("is a stub pointing at the uniform rules when no preset is asked for", async () => {
    const text = await directoryHarness().standards();

    assert.equal(text.split("\n")[0], "# Project standards");
    assert.match(text, /no rules beyond the uniform ones in `docs\/agents\/coding-standards\.md`/);
    assert.doesNotMatch(text, /^## /m);
  });

  it("is the typescript preset's text when asked for it", async () => {
    const text = await directoryHarness().standards("typescript");

    assert.equal(text, await contentsOf(MANAGER_HOME, "docs/project-standards-presets/typescript.md"));
    assert.match(text, /^# Project standards\n\n## Brand your primitives\n/);
  });

  it("carries the brand section exactly as the uniform file has it", async () => {
    const text = await directoryHarness().standards("typescript");
    const uniform = await contentsOf(MANAGER_HOME, "docs/agents/coding-standards.md");

    const section = text.slice(text.indexOf("## Brand your primitives"));
    assert.ok(uniform.includes(section.trimEnd()));
  });

  it("fails naming the presets that exist for a name with no file", async () => {
    await assert.rejects(directoryHarness().standards("cobol"), /"cobol".*typescript/);
  });

  it("names no manager in any preset", async () => {
    const presets = path.join(MANAGER_HOME, "docs/project-standards-presets");
    for (const file of await readdir(presets)) {
      assert.doesNotMatch(
        await readFile(path.join(presets, file), "utf8"),
        /side-projects-manager|morning loop|registry\.json|managed location/i,
        `${file} refers back to the manager`,
      );
    }
  });
});
