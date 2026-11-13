import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { MANAGER_HOME } from "./adapters/manager-home.ts";

const agents = readFileSync(path.join(MANAGER_HOME, "AGENTS.md"), "utf8");

describe("this repo's agent instructions", () => {
  it("name scripts/test-mods.sh in the checks a run makes before finishing", () => {
    const section = agents.split("\n### Checks before finishing\n")[1]?.split("\n### ")[0] ?? "";

    assert.match(section, /`scripts\/test-mods\.sh`/);
    assert.match(section, /not done until it passes/);
  });
});
