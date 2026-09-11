import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { promisify } from "node:util";

import { recordingGh, type RecordedGh } from "../testing/index.ts";

const execFileAsync = promisify(execFile);
const entryPoint = path.join(import.meta.dirname, "guarded-morning-run.ts");

/** The same empty-backlog stub `morning-run.test.ts` uses. */
async function stubGh(t: TestContext): Promise<RecordedGh> {
  return recordingGh(
    t,
    [
      `case "$1 $2" in`,
      `  "issue list") echo "[]" ;;`,
      `  "issue create") echo "https://github.com/nadav-alon/side-projects-manager/issues/0" ;;`,
      `  *) : ;;`,
      `esac`,
    ].join("\n"),
  );
}

async function home(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "guarded-morning-run-bin-"));
}

async function run(
  directory: string,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [entryPoint], {
    env: { ...process.env, SIDE_PROJECTS_MANAGER_HOME: directory },
  });
}

describe("the guarded-morning-run command", () => {
  it("runs the loop the first time it's called for the day", async (t) => {
    await stubGh(t);

    const { stdout } = await run(await home());

    assert.match(stdout, /nothing to do/i);
  });

  it("is a no-op the second time it's called the same day", async (t) => {
    const gh = await stubGh(t);
    const directory = await home();

    await run(directory);
    const { stdout } = await run(directory);

    assert.match(stdout, /already ran today/i);

    const creates = (await gh.calls()).filter(
      (call) => call[0] === "issue" && call[1] === "create",
    );
    assert.equal(creates.length, 1, "the summary is published only once");
  });

  it("still runs for a manager home it hasn't seen before", async (t) => {
    const gh = await stubGh(t);

    await run(await home());
    await run(await home());

    const creates = (await gh.calls()).filter(
      (call) => call[0] === "issue" && call[1] === "create",
    );
    assert.equal(creates.length, 2, "each home has its own lock");
  });
});
