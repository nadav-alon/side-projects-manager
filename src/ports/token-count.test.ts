import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isTokenCount, tokenCount } from "./token-count.ts";

describe("isTokenCount", () => {
  it("accepts zero, which is a window nothing has been spent in", () => {
    assert.equal(isTokenCount(0), true);
    assert.equal(isTokenCount(120_000), true);
  });

  it("rejects a negative count", () => {
    assert.equal(isTokenCount(-1), false);
  });

  it("rejects counts that are not whole, including what bad arithmetic returns", () => {
    assert.equal(isTokenCount(1.5), false);
    assert.equal(isTokenCount(Number.NaN), false);
    assert.equal(isTokenCount(Number.POSITIVE_INFINITY), false);
  });
});

describe("tokenCount", () => {
  it("throws naming the offending value", () => {
    assert.throws(() => tokenCount(-1), { name: "TypeError", message: /-1/ });
  });
});
