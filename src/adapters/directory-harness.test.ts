import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { Checkout } from "../ports/index.ts";
import { checkout } from "../ports/index.ts";
import { UNIFORM_FILES, directoryHarness } from "./directory-harness.ts";
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
