import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const entryPoint = path.join(import.meta.dirname, "morning-run.ts");

describe("the morning-run command", () => {
  it("exits successfully and says there was nothing to do", async () => {
    const { stdout, stderr } = await run(process.execPath, [entryPoint]);

    assert.equal(stderr, "");
    assert.match(stdout, /nothing to do/i);
  });
});
