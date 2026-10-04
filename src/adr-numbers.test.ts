import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { adrCollisions, describeAdrCollisions } from "./adr-numbers.ts";

test("two files sharing a prefix collide, naming the number and both files", () => {
  const collisions = adrCollisions([
    "0012-a.md",
    "0013-b.md",
    "0013-c.md",
  ]);
  assert.deepEqual(describeAdrCollisions(collisions), [
    "ADR 0013 is claimed by 0013-b.md and 0013-c.md",
  ]);
});

test("distinct prefixes pass, gaps included", () => {
  assert.deepEqual(adrCollisions(["0001-a.md", "0003-b.md"]), []);
});

test("a name without a four-digit prefix claims no number", () => {
  assert.deepEqual(adrCollisions(["README.md", "template.md", "12-a.md", "00130-b.md"]), []);
});

test("the check script exits non-zero naming the collision, and zero without one", () => {
  const script = path.join(import.meta.dirname, "..", "scripts", "check-adr-numbers.ts");
  const dir = mkdtempSync(path.join(tmpdir(), "adr-"));
  try {
    writeFileSync(path.join(dir, "0001-a.md"), "");
    assert.equal(spawnSync("node", [script, dir]).status, 0);
    writeFileSync(path.join(dir, "0001-b.md"), "");
    const run = spawnSync("node", [script, dir], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /ADR 0001 is claimed by 0001-a\.md and 0001-b\.md/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
