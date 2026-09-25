import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { fileHalt } from "../adapters/file-halt.ts";
import { tempHome } from "../testing/index.ts";

const execFileAsync = promisify(execFile);
const entryPoint = path.join(import.meta.dirname, "stop.ts");

async function run(
  home: string,
  args: string[] = [],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [entryPoint, ...args], {
    env: { ...process.env, SIDE_PROJECTS_MANAGER_HOME: home },
  });
}

describe("the stop command", () => {
  it("halts the loop, and says so, when nothing was in progress", async () => {
    const home = await tempHome("stop-bin");

    const { stdout, stderr } = await run(home);

    assert.equal(stderr, "");
    assert.match(stdout, /Halted/);
    assert.match(stdout, /No run was in progress/);
    assert.equal(await fileHalt(home).engaged(), true);
  });

  it("is idempotent about the halt, and still says no run was in progress", async () => {
    const home = await tempHome("stop-bin");
    await fileHalt(home).engage();

    const { stdout, stderr } = await run(home);

    assert.equal(stderr, "");
    assert.match(stdout, /already halted/i);
    assert.match(stdout, /No run was in progress/);
  });
});
