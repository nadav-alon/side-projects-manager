import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isNits, nits } from "./nits.ts";

describe("isNits", () => {
  it("accepts a trimmed, non-empty list", () => {
    assert.equal(isNits("- the widget's name is misspelled two lines up"), true);
  });

  it("rejects an empty string", () => {
    assert.equal(isNits(""), false);
  });

  it("rejects a value with untrimmed surrounding whitespace", () => {
    assert.equal(isNits("  - one nit  "), false);
  });
});

describe("nits", () => {
  it("narrows a trimmed, non-empty list", () => {
    assert.equal(
      nits("- the widget's name is misspelled two lines up"),
      "- the widget's name is misspelled two lines up",
    );
  });

  it("throws naming the offending value", () => {
    assert.throws(() => nits(""), { name: "TypeError", message: /""/ });
  });
});
