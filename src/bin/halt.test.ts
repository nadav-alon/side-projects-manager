import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { HALT_FILE } from "../adapters/file-halt.ts";
import { tempHome } from "../testing/index.ts";

const execFileAsync = promisify(execFile);
const entryPoint = path.join(import.meta.dirname, "halt.ts");

async function run(home: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [entryPoint], {
    env: { ...process.env, SIDE_PROJECTS_MANAGER_HOME: home },
  });
}

async function halted(home: string): Promise<boolean> {
  return access(path.join(home, HALT_FILE)).then(
    () => true,
    () => false,
  );
}

describe("the halt command", () => {
  it("engages the halt, and says so", async () => {
    const home = await tempHome("halt-bin");

    const { stdout, stderr } = await run(home);

    assert.equal(stderr, "");
    assert.match(stdout, /Halted/);
    assert.equal(await halted(home), true);
  });

  it("is idempotent, and says an already-engaged halt was already engaged", async () => {
    const home = await tempHome("halt-bin");
    await run(home);

    const { stdout, stderr } = await run(home);

    assert.equal(stderr, "");
    assert.match(stdout, /already halted/i);
    assert.equal(await halted(home), true);
  });
});
