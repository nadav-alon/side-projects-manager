import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { fileHalt, HALT_FILE } from "../adapters/file-halt.ts";
import { tempHome } from "../testing/index.ts";

const execFileAsync = promisify(execFile);
const entryPoint = path.join(import.meta.dirname, "resume.ts");

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

describe("the resume command", () => {
  it("clears an engaged halt, and says so", async () => {
    const home = await tempHome("resume-bin");
    await fileHalt(home).engage();

    const { stdout, stderr } = await run(home);

    assert.equal(stderr, "");
    assert.match(stdout, /Resumed/);
    assert.equal(await halted(home), false);
  });

  it("is idempotent, and says a halt that was never engaged wasn't halted", async () => {
    const home = await tempHome("resume-bin");

    const { stdout, stderr } = await run(home);

    assert.equal(stderr, "");
    assert.match(stdout, /wasn't halted/i);
    assert.equal(await halted(home), false);
  });
});
