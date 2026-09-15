import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isSize, largerSize, SIZES } from "./size.ts";

describe("isSize", () => {
  it("accepts each of the four sizes", () => {
    for (const size of SIZES) {
      assert.equal(isSize(size), true);
    }
  });

  it("rejects anything the four labels do not name", () => {
    assert.equal(isSize("XS"), false);
    assert.equal(isSize("s"), false);
    assert.equal(isSize(""), false);
  });
});

describe("largerSize", () => {
  it("picks the larger of two sizes, in either order", () => {
    assert.equal(largerSize("S", "L"), "L");
    assert.equal(largerSize("L", "S"), "L");
  });

  it("picks either when the two sizes are equal", () => {
    assert.equal(largerSize("M", "M"), "M");
  });
});
