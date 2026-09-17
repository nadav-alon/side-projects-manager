import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import { isProcessAlive } from "./process-alive.ts";

/** A pid guaranteed no longer alive: a child process that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  if (child.pid === undefined) {
    throw new Error("failed to spawn a child process for its pid");
  }
  return child.pid;
}

describe("isProcessAlive", () => {
  it("is true for this process's own pid", () => {
    assert.equal(isProcessAlive(process.pid), true);
  });

  it("is false for a pid that has already exited", () => {
    assert.equal(isProcessAlive(deadPid()), false);
  });
});
