import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { UNIFORM_FILES, directoryHarness } from "./directory-harness.ts";
import { MANAGER_HOME } from "./manager-home.ts";

const INSTRUCTIONS = "# pilot\n\nA flight log that files itself.\n";

/** An empty project checkout, as a fresh clone would be. */
async function checkout(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "new-project-"));
}

async function contentsOf(directory: string, file: string): Promise<string> {
  return readFile(path.join(directory, file), "utf8");
}

describe("scaffolding the harness into a project", () => {
  it("copies every uniform file verbatim", async () => {
    const directory = await checkout();

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
    const directory = await checkout();

    await directoryHarness().install(directory, INSTRUCTIONS);

    assert.equal(await contentsOf(directory, "AGENTS.md"), INSTRUCTIONS);
  });

  it("reports every path it wrote, relative to the checkout", async () => {
    const directory = await checkout();

    const written = await directoryHarness().install(directory, INSTRUCTIONS);

    assert.deepEqual(written, [...UNIFORM_FILES, "AGENTS.md"]);
  });

  it("leaves instructions a project already wrote for itself alone", async () => {
    const directory = await checkout();
    await writeFile(path.join(directory, "AGENTS.md"), "# mine\n");

    const written = await directoryHarness().install(directory, INSTRUCTIONS);

    assert.equal(await contentsOf(directory, "AGENTS.md"), "# mine\n");
    assert.deepEqual(written, [...UNIFORM_FILES]);
  });

  it("replaces uniform files that have drifted, since uniform is the point", async () => {
    const directory = await checkout();
    await mkdir(path.join(directory, "docs", "agents"), { recursive: true });
    await writeFile(path.join(directory, UNIFORM_FILES[0] ?? ""), "stale\n");

    await directoryHarness().install(directory, INSTRUCTIONS);

    assert.notEqual(await contentsOf(directory, UNIFORM_FILES[0] ?? ""), "stale\n");
  });

  it("installs nothing that points back at the manager", async () => {
    const directory = await checkout();

    const written = await directoryHarness().install(directory, INSTRUCTIONS);

    for (const file of written) {
      assert.doesNotMatch(
        await contentsOf(directory, file),
        /side-projects-manager|morning loop|registry\.json|managed location/i,
        `${file} refers back to the manager`,
      );
    }
  });

  it("fails naming the file when the harness source is not there", async () => {
    const harness = directoryHarness(await checkout());

    await assert.rejects(
      harness.install(await checkout(), INSTRUCTIONS),
      new RegExp(UNIFORM_FILES[0]?.replaceAll(".", "\\.") ?? ""),
    );
  });
});
