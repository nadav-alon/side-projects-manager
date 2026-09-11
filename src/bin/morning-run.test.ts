import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { promisify } from "node:util";

import {
  callWith,
  recordingGh,
  type RecordedGh,
} from "../testing/index.ts";

const execFileAsync = promisify(execFile);
const entryPoint = path.join(import.meta.dirname, "morning-run.ts");

/**
 * Stands in for `gh` for the length of one test: an empty backlog for
 * whatever repo is asked, and a summary issue "created" without leaving one
 * behind. `main()` now publishes a summary on every invocation, so every
 * scenario here writes — and this suite is checked against a real tracker
 * nowhere else, since a write that landed on the real manager repo on every
 * test run is not a cost this suite may pay.
 */
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

/**
 * The command against its own manager home, so the suite reads and writes
 * documents in a temporary directory rather than the developer's checkout.
 */
async function run(home: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [entryPoint], {
    env: { ...process.env, SIDE_PROJECTS_MANAGER_HOME: home },
  });
}

async function home(registry?: unknown): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "morning-run-bin-"));
  if (registry !== undefined) {
    await writeFile(
      path.join(directory, "registry.json"),
      JSON.stringify(registry),
    );
  }
  return directory;
}

describe("the morning-run command", () => {
  it("exits successfully and says there was nothing to do", async (t) => {
    await stubGh(t);

    const { stdout, stderr } = await run(await home());

    assert.equal(stderr, "");
    assert.match(stdout, /nothing to do/i);
  });

  it("reports the registered projects it skipped, and why", async (t) => {
    await stubGh(t);

    const directory = await home({
      projects: [
        { repo: "nadav-alon/pilot", paused: true },
        { repo: "octocat/Hello-World" },
      ],
    });

    const { stdout } = await run(directory);

    assert.match(stdout, /nadav-alon\/pilot \(paused\)/);
    assert.match(
      stdout,
      /octocat\/Hello-World \(no ready-for-agent tickets\)/,
    );
  });

  it("leaves a state document behind for the next morning", async (t) => {
    await stubGh(t);

    const directory = await home();

    await run(directory);

    const state = await readFile(path.join(directory, "state.json"), "utf8");
    assert.deepEqual(JSON.parse(state), { projects: {} });
  });

  it("reports a broken registry in one line, without a stack trace", async (t) => {
    // Never reaches `gh` at all — the registry fails to parse before the
    // first call — but stubbed anyway so this suite depends on the real
    // tracker nowhere, not even by the accident of an untaken code path.
    await stubGh(t);

    const directory = await home({ projects: [{ repo: "pilot" }] });

    const { stdout, stderr, code } = await run(directory).then(
      (result) => ({ ...result, code: 0 }),
      (error: { stdout: string; stderr: string; code: number }) => error,
    );

    assert.equal(stdout, "");
    assert.equal(code, 1);
    assert.match(stderr, /morning-run failed: .*registry\.json.*"pilot"/);
    assert.doesNotMatch(stderr, /\n\s+at /);
  });

  it("publishes exactly one summary issue in the manager repo", async (t) => {
    const gh = await stubGh(t);

    await run(await home());

    const calls = await gh.calls();
    const creates = calls.filter(
      (call) => call[0] === "issue" && call[1] === "create",
    );
    assert.equal(creates.length, 1, "exactly one summary issue is created");
    assert.ok(callWith(calls, "issue", "create", "--title"));
  });
});
