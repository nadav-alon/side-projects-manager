import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isPriority, priority } from "./priority.ts";

describe("isPriority", () => {
  it("accepts a whole number of 1 or more", () => {
    assert.equal(isPriority(1), true);
    assert.equal(isPriority(42), true);
  });

  it("rejects 0 and below, since 1 is the project with the mornings", () => {
    assert.equal(isPriority(0), false);
    assert.equal(isPriority(-1), false);
  });

  it("rejects numbers that are not whole", () => {
    assert.equal(isPriority(1.5), false);
    assert.equal(isPriority(Number.NaN), false);
    assert.equal(isPriority(Number.POSITIVE_INFINITY), false);
  });
});

describe("priority", () => {
  it("throws naming the offending value", () => {
    assert.throws(() => priority(0), { name: "TypeError", message: /0/ });
  });
});
