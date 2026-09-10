import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isUsd, usd } from "./usd.ts";

describe("isUsd", () => {
  it("accepts a spend ceiling, whole or in cents", () => {
    assert.equal(isUsd(5), true);
    assert.equal(isUsd(0.25), true);
  });

  it("rejects 0, since a run that may spend nothing cannot start", () => {
    assert.equal(isUsd(0), false);
  });

  it("rejects negatives and non-numbers", () => {
    assert.equal(isUsd(-1), false);
    assert.equal(isUsd(Number.NaN), false);
    assert.equal(isUsd(Number.POSITIVE_INFINITY), false);
  });
});

describe("usd", () => {
  it("throws naming the offending value", () => {
    assert.throws(() => usd(0), { name: "TypeError", message: /0/ });
  });
});
