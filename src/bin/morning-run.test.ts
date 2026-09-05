import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

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
  it("exits successfully and says there was nothing to do", async () => {
    const { stdout, stderr } = await run(await home());

    assert.equal(stderr, "");
    assert.match(stdout, /nothing to do/i);
  });

  it("reports the registered projects it skipped, and why", async () => {
    const directory = await home({
      projects: [
        { repo: "nadav-alon/pilot", paused: true },
        { repo: "nadav-alon/side-projects-manager" },
      ],
    });

    const { stdout } = await run(directory);

    assert.match(stdout, /nadav-alon\/pilot \(paused\)/);
    assert.match(
      stdout,
      /nadav-alon\/side-projects-manager \(no ready-for-agent tickets\)/,
    );
  });

  it("leaves a state document behind for the next morning", async () => {
    const directory = await home();

    await run(directory);

    const state = await readFile(path.join(directory, "state.json"), "utf8");
    assert.deepEqual(JSON.parse(state), { projects: {} });
  });

  it("reports a broken registry in one line, without a stack trace", async () => {
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
});
