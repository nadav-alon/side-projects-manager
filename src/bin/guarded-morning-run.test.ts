import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { fileInvocationLease } from "../adapters/file-invocation-lease.ts";
import { emptyBacklogGh, tempHome } from "../testing/index.ts";

const execFileAsync = promisify(execFile);
const entryPoint = path.join(import.meta.dirname, "guarded-morning-run.ts");

async function home(): Promise<string> {
  return tempHome("guarded-morning-run-bin");
}

async function run(
  directory: string,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [entryPoint], {
    env: { ...process.env, SIDE_PROJECTS_MANAGER_HOME: directory },
  });
}

describe("the guarded-morning-run command", () => {
  it("runs the loop when the lease is free", async (t) => {
    await emptyBacklogGh(t);

    const { stdout } = await run(await home());

    assert.match(stdout, /nothing to do/i);
  });

  it("is a no-op while a live process holds the lease", async (t) => {
    const gh = await emptyBacklogGh(t);
    const directory = await home();
    const held = fileInvocationLease(directory);
    await held.acquire();

    const { stdout } = await run(directory);

    assert.match(stdout, /already running/i);
    const creates = (await gh.calls()).filter(
      (call) => call[0] === "issue" && call[1] === "create",
    );
    assert.equal(creates.length, 0, "the held invocation never ran");
  });

  it("runs again once an earlier invocation has released the lease", async (t) => {
    await emptyBacklogGh(t);
    const directory = await home();

    await run(directory);
    const { stdout } = await run(directory);

    assert.doesNotMatch(stdout, /already running/i, "the lease was released");
    assert.match(stdout, /nothing to do/i);
  });

  it("still runs for a manager home it hasn't seen before", async (t) => {
    const gh = await emptyBacklogGh(t);

    await run(await home());
    await run(await home());

    const creates = (await gh.calls()).filter(
      (call) => call[0] === "issue" && call[1] === "create",
    );
    assert.equal(creates.length, 2, "each home has its own lease");
  });
});
