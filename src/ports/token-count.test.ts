import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isTokenCount,
  isWeightedTokens,
  tokenCount,
  weighTokenFields,
  weightedTokenCount,
  weightedTokens,
} from "./token-count.ts";

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

describe("weightedTokenCount", () => {
  it("weighs a fresh input token at 1", () => {
    assert.equal(
      weightedTokenCount({ input: 100, output: 0, cacheCreation: 0, cacheRead: 0 }),
      100,
    );
  });

  it("weighs an output token at 5", () => {
    assert.equal(
      weightedTokenCount({ input: 0, output: 100, cacheCreation: 0, cacheRead: 0 }),
      500,
    );
  });

  it("weighs a cache-creation token at 1.25", () => {
    assert.equal(
      weightedTokenCount({ input: 0, output: 0, cacheCreation: 100, cacheRead: 0 }),
      125,
    );
  });

  it("weighs a cache-read token at 0.1, far below a fresh one", () => {
    assert.equal(
      weightedTokenCount({ input: 0, output: 0, cacheCreation: 0, cacheRead: 100 }),
      10,
    );
  });

  it("rounds the weighted total to a whole number of tokens", () => {
    // 1 + 2*5 + 4*1.25 + 8*0.1 = 16.8
    assert.equal(
      weightedTokenCount({ input: 1, output: 2, cacheCreation: 4, cacheRead: 8 }),
      17,
    );
  });
});

describe("weighTokenFields", () => {
  it("leaves the weighted total unrounded, for a caller summing several before rounding once", () => {
    assert.equal(
      weighTokenFields({ input: 0, output: 0, cacheCreation: 0, cacheRead: 5 }),
      0.5,
    );
  });
});

describe("isWeightedTokens", () => {
  it("accepts a fractional, non-negative figure", () => {
    assert.equal(isWeightedTokens(16.8), true);
    assert.equal(isWeightedTokens(0), true);
  });

  it("rejects a negative figure", () => {
    assert.equal(isWeightedTokens(-1), false);
  });

  it("rejects non-finite arithmetic", () => {
    assert.equal(isWeightedTokens(Number.NaN), false);
    assert.equal(isWeightedTokens(Number.POSITIVE_INFINITY), false);
  });
});

describe("weightedTokens", () => {
  it("throws naming the offending value", () => {
    assert.throws(() => weightedTokens(-1), { name: "TypeError", message: /-1/ });
  });
});
