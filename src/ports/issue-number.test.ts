import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isIssueNumber, issueNumber } from "./issue-number.ts";

describe("isIssueNumber", () => {
  it("accepts a positive integer", () => {
    assert.equal(isIssueNumber(1), true);
    assert.equal(isIssueNumber(59), true);
  });

  it("rejects anything that is not a positive integer", () => {
    assert.equal(isIssueNumber(0), false);
    assert.equal(isIssueNumber(-1), false);
    assert.equal(isIssueNumber(1.5), false);
    assert.equal(isIssueNumber(Number.NaN), false);
  });
});

describe("issueNumber", () => {
  it("returns the value it was given", () => {
    assert.equal(issueNumber(59), 59);
  });

  it("throws naming the offending value", () => {
    assert.throws(() => issueNumber(0), { name: "TypeError", message: /0/ });
  });
});
