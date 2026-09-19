import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { processId } from "../ports/index.ts";
import { deadPid } from "../testing/index.ts";
import { isProcessAlive } from "./process-alive.ts";

describe("isProcessAlive", () => {
  it("is true for this process's own pid", () => {
    assert.equal(isProcessAlive(processId(process.pid)), true);
  });

  it("is false for a pid that has already exited", () => {
    assert.equal(isProcessAlive(deadPid()), false);
  });
});
