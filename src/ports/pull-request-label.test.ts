import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  APPLIED_REVIEW_LABEL,
  isPullRequestLabel,
  pullRequestLabel,
  REVIEWED_LABEL,
} from "./pull-request-label.ts";

describe("isPullRequestLabel", () => {
  it("accepts the two labels the loop applies", () => {
    assert.equal(isPullRequestLabel("reviewed"), true);
    assert.equal(isPullRequestLabel("applied-review"), true);
  });

  it("rejects an empty label", () => {
    assert.equal(isPullRequestLabel(""), false);
  });

  it("rejects a label past GitHub's 50-character limit", () => {
    assert.equal(isPullRequestLabel("a".repeat(51)), false);
    assert.equal(isPullRequestLabel("a".repeat(50)), true);
  });
});

describe("pullRequestLabel", () => {
  it("returns the value it was given", () => {
    assert.equal(pullRequestLabel("reviewed"), "reviewed");
  });

  it("throws naming the offending value", () => {
    assert.throws(() => pullRequestLabel(""), {
      name: "TypeError",
      message: /""/,
    });
  });
});

describe("the two labels the loop applies", () => {
  it("are reviewed and applied-review", () => {
    assert.equal(REVIEWED_LABEL, "reviewed");
    assert.equal(APPLIED_REVIEW_LABEL, "applied-review");
  });
});
