import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  APPLIED_REVIEW_LABEL,
  isPullRequestLabel,
  pullRequestLabel,
  READY_FOR_HUMAN_PULL_REQUEST_LABEL,
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

  it("rejects a label carrying a comma, which gh pr edit --add-label would split into two", () => {
    assert.equal(isPullRequestLabel("a,b"), false);
  });

  it("rejects a label that is only whitespace", () => {
    assert.equal(isPullRequestLabel(" "), false);
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

describe("READY_FOR_HUMAN_PULL_REQUEST_LABEL", () => {
  it("is ready-for-human, the same text as the ticket label", () => {
    assert.equal(READY_FOR_HUMAN_PULL_REQUEST_LABEL, "ready-for-human");
  });
});
