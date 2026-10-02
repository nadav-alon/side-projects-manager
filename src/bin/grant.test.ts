import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { tempHome } from "../testing/index.ts";

const execFileAsync = promisify(execFile);
const entryPoint = path.join(import.meta.dirname, "grant.ts");

async function run(home: string, ...args: string[]) {
  return execFileAsync(process.execPath, [entryPoint, ...args], {
    env: { ...process.env, SIDE_PROJECTS_MANAGER_HOME: home },
  });
}

describe("the grant command", () => {
  it("exits non-zero on a non-turbo project and writes no state", async () => {
    const home = await tempHome("grant-bin");
    await writeFile(
      path.join(home, "registry.json"),
      JSON.stringify({ projects: [{ repo: "nadav-alon/pilot", turbo: false }] }),
    );

    await assert.rejects(run(home, "nadav-alon/pilot#7"), (error: { code?: number; stderr?: string }) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr ?? "", /not a turbo project/);
      return true;
    });
    await assert.rejects(readFile(path.join(home, "state.json")), { code: "ENOENT" });
  });

  it("exits non-zero on an argument that is not a ticket reference", async () => {
    const home = await tempHome("grant-bin");

    await assert.rejects(run(home, "pilot"), (error: { stderr?: string }) => /Not a ticket reference/.test(error.stderr ?? ""));
  });
});
