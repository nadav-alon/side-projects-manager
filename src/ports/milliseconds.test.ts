import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isMilliseconds, milliseconds } from "./milliseconds.ts";

describe("isMilliseconds", () => {
  it("accepts zero, a window of no length", () => {
    assert.equal(isMilliseconds(0), true);
    assert.equal(isMilliseconds(5 * 60 * 60 * 1000), true);
  });

  it("rejects a negative duration", () => {
    assert.equal(isMilliseconds(-1), false);
  });

  it("rejects durations that are not whole, including what bad arithmetic returns", () => {
    assert.equal(isMilliseconds(1.5), false);
    assert.equal(isMilliseconds(Number.NaN), false);
    assert.equal(isMilliseconds(Number.POSITIVE_INFINITY), false);
  });
});

describe("milliseconds", () => {
  it("throws naming the offending value", () => {
    assert.throws(() => milliseconds(-1), { name: "TypeError", message: /-1/ });
  });
});
