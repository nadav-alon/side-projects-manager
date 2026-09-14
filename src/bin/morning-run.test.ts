import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { localDay } from "../ports/index.ts";
import { callWith, emptyBacklogGh } from "../testing/index.ts";

const execFileAsync = promisify(execFile);
const entryPoint = path.join(import.meta.dirname, "morning-run.ts");

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
    await emptyBacklogGh(t);

    const { stdout, stderr } = await run(await home());

    assert.equal(stderr, "");
    assert.match(stdout, /nothing to do/i);
  });

  it("reports the registered projects it skipped, and why", async (t) => {
    await emptyBacklogGh(t);

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
    await emptyBacklogGh(t);

    const directory = await home();

    await run(directory);

    const state = await readFile(path.join(directory, "state.json"), "utf8");
    // A dry queue, and today not yet announced, so the summary published and
    // recorded today's local day.
    assert.deepEqual(JSON.parse(state), {
      projects: {},
      announcedOn: localDay(new Date()),
    });
  });

  it("reports a broken registry in one line, and still publishes a summary", async (t) => {
    const gh = await emptyBacklogGh(t);

    const directory = await home({ projects: [{ repo: "pilot" }] });

    const { stdout, stderr, code } = await run(directory).then(
      (result) => ({ ...result, code: 0 }),
      (error: { stdout: string; stderr: string; code: number }) => error,
    );

    assert.equal(stderr, "");
    assert.equal(code, 1);
    assert.match(stdout, /registry\.json.*"pilot"/);
    assert.doesNotMatch(stdout, /\n\s+at /);

    const calls = await gh.calls();
    assert.equal(
      calls.filter((call) => call[0] === "issue" && call[1] === "create")
        .length,
      1,
      "a summary issue is still published",
    );
  });

  it("publishes exactly one summary issue in the manager repo", async (t) => {
    const gh = await emptyBacklogGh(t);

    await run(await home());

    const calls = await gh.calls();
    const creates = calls.filter(
      (call) => call[0] === "issue" && call[1] === "create",
    );
    assert.equal(creates.length, 1, "exactly one summary issue is created");
    assert.ok(callWith(calls, "issue", "create", "--title"));
  });
});
