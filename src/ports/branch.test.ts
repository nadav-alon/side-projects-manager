import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { branch, isBranch } from "./branch.ts";

describe("isBranch", () => {
  it("accepts the shape the sandbox names branches in", () => {
    assert.ok(isBranch("issue-7-run-a-ticket-in-the-sandbox"));
    assert.ok(isBranch("issue-7-run-a-ticket-in-the-sandbox-2"));
    assert.ok(isBranch("feature/nested/name"));
  });

  it("refuses names git itself would refuse", () => {
    for (const value of [
      "",
      "@",
      "has a space",
      "has~tilde",
      "has^caret",
      "has:colon",
      "has?question",
      "has*star",
      "has[bracket",
      "has\\backslash",
      "has..dots",
      "has//slashes",
      "has@{brace",
      "/leading",
      "trailing/",
      "trailing.",
      ".hidden",
      "nested/.hidden",
      "name.lock",
    ]) {
      assert.equal(isBranch(value), false, `expected to refuse ${value}`);
    }
  });

  /** A branch that reads as an option is a branch no command can be handed. */
  it("refuses a name that starts with a dash", () => {
    assert.equal(isBranch("--force"), false);
  });
});

describe("branch", () => {
  it("narrows a name git would accept", () => {
    assert.equal(branch("issue-7-thing"), "issue-7-thing");
  });

  it("throws naming the value it refused", () => {
    assert.throws(() => branch("has a space"), /has a space/);
  });
});
