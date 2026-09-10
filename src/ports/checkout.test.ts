import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkout, isCheckout } from "./checkout.ts";

describe("isCheckout", () => {
  it("accepts a normalised absolute path", () => {
    assert.ok(isCheckout("/side-projects/nadav-alon/pilot"));
  });

  it("refuses a relative path, which no adapter could resolve twice", () => {
    assert.equal(isCheckout("side-projects/nadav-alon/pilot"), false);
    assert.equal(isCheckout("./pilot"), false);
    assert.equal(isCheckout(""), false);
  });

  /** Two spellings of one directory must not read as two checkouts. */
  it("refuses a path that is not already in join's shape", () => {
    assert.equal(isCheckout("/side-projects/../pilot"), false);
    assert.equal(isCheckout("/side-projects//pilot"), false);
    assert.equal(isCheckout("/side-projects/pilot/"), false);
  });
});

describe("checkout", () => {
  it("narrows an absolute path", () => {
    assert.equal(checkout("/side-projects/pilot"), "/side-projects/pilot");
  });

  it("throws naming the value it refused", () => {
    assert.throws(() => checkout("pilot"), /pilot/);
  });
});
