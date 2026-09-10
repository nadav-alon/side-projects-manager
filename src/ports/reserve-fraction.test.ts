import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isReserveFraction, reserveFraction } from "./reserve-fraction.ts";

describe("isReserveFraction", () => {
  it("accepts a fraction of the weekly window", () => {
    assert.equal(isReserveFraction(0.4), true);
    assert.equal(isReserveFraction(0.999), true);
  });

  it("accepts 0, which holds nothing back", () => {
    assert.equal(isReserveFraction(0), true);
  });

  it("rejects 1 and above, which would stand the loop down forever", () => {
    assert.equal(isReserveFraction(1), false);
    assert.equal(isReserveFraction(1.5), false);
  });

  it("rejects negatives and non-numbers", () => {
    assert.equal(isReserveFraction(-0.1), false);
    assert.equal(isReserveFraction(Number.NaN), false);
    assert.equal(isReserveFraction(Number.POSITIVE_INFINITY), false);
  });
});

describe("reserveFraction", () => {
  it("throws naming the offending value", () => {
    assert.throws(() => reserveFraction(1), { name: "TypeError", message: /1/ });
  });
});
