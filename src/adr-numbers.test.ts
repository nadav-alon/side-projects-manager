import assert from "node:assert/strict";
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
