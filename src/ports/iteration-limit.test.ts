import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isIterationLimit, iterationLimit } from "./iteration-limit.ts";

describe("isIterationLimit", () => {
  it("accepts one iteration at a time, and more", () => {
    assert.equal(isIterationLimit(1), true);
    assert.equal(isIterationLimit(4), true);
  });

  it("rejects 0, since a limit of nothing starts no work", () => {
    assert.equal(isIterationLimit(0), false);
  });

  it("rejects negatives, fractions and non-numbers", () => {
    assert.equal(isIterationLimit(-1), false);
    assert.equal(isIterationLimit(1.5), false);
    assert.equal(isIterationLimit(Number.NaN), false);
    assert.equal(isIterationLimit(Number.POSITIVE_INFINITY), false);
  });
});

describe("iterationLimit", () => {
  it("throws naming the offending value", () => {
    assert.throws(() => iterationLimit(0), { name: "TypeError", message: /0/ });
  });
});
