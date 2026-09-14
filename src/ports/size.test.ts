import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isSize, SIZES } from "./size.ts";

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
