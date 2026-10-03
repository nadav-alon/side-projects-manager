import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isStandardsPreset, standardsPreset } from "./standards-preset.ts";

describe("standardsPreset", () => {
  it("accepts a file stem", () => {
    assert.equal(standardsPreset("typescript"), "typescript");
    assert.equal(standardsPreset("type-script-2"), "type-script-2");
  });

  it("rejects anything that is not a stem", () => {
    for (const value of ["", "../typescript", "a/b", "Type", "-a", "a--b", "a.md"]) {
      assert.equal(isStandardsPreset(value), false, value);
      assert.throws(() => standardsPreset(value), TypeError);
    }
  });
});
