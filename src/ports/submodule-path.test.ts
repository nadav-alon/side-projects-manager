import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isSubmodulePath, submodulePath } from "./submodule-path.ts";

describe("isSubmodulePath", () => {
  it("accepts a path relative to the checkout's root", () => {
    assert.ok(isSubmodulePath("latex"));
    assert.ok(isSubmodulePath("vendor/paper"));
  });

  it("refuses an absolute path, which is a checkout's place, not a submodule's", () => {
    assert.equal(isSubmodulePath("/repo/latex"), false);
    assert.equal(isSubmodulePath(""), false);
  });

  it("refuses a path that leaves the checkout or reads as an option", () => {
    assert.equal(isSubmodulePath("../latex"), false);
    assert.equal(isSubmodulePath("vendor/../../latex"), false);
    assert.equal(isSubmodulePath("--force"), false);
  });
});

describe("submodulePath", () => {
  it("narrows a relative path", () => {
    assert.equal(submodulePath("latex"), "latex");
  });

  it("throws on one that is not", () => {
    assert.throws(() => submodulePath("/repo/latex"), TypeError);
  });
});
