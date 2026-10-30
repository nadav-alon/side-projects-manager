import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { uniformFilesIn } from "../../mods/uniform-guard/hooks/uniform.ts";
import { UNIFORM_FILES } from "./harness.ts";

test("the uniform-guard mod reads exactly UNIFORM_FILES out of this very source", () => {
  const source = readFileSync(new URL("./harness.ts", import.meta.url), "utf8");
  assert.deepEqual(uniformFilesIn(source), [...UNIFORM_FILES]);
});
