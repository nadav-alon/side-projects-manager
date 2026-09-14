import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { commitSha, isCommitSha } from "./commit-sha.ts";

describe("isCommitSha", () => {
  it("accepts a full-length SHA-1 hash", () => {
    assert.equal(
      isCommitSha("c0ffee1234567890abcdef1234567890abcdef12"),
      true,
    );
  });

  it("accepts a 7-character abbreviation, the shortest git shows by default", () => {
    assert.equal(isCommitSha("c0ffee1"), true);
  });

  it("rejects anything shorter than an abbreviation", () => {
    assert.equal(isCommitSha("c0ffee"), false);
    assert.equal(isCommitSha(""), false);
  });

  it("accepts a full-length SHA-256 hash", () => {
    assert.equal(isCommitSha("c0ffee12".repeat(8)), true);
  });

  it("rejects anything between a full SHA-1 and a full SHA-256 hash", () => {
    assert.equal(isCommitSha(`${"a".repeat(41)}`), false);
    assert.equal(isCommitSha(`${"a".repeat(63)}`), false);
  });

  it("rejects anything longer than a full SHA-256 hash", () => {
    assert.equal(isCommitSha(`${"a".repeat(65)}`), false);
  });

  it("rejects characters outside git's hex alphabet", () => {
    assert.equal(isCommitSha("g0ffee1"), false);
    assert.equal(isCommitSha("c0ffee1\n"), false);
  });

  it("rejects a branch name or other non-hash text", () => {
    assert.equal(isCommitSha("main"), false);
    assert.equal(isCommitSha("HEAD"), false);
  });
});

describe("commitSha", () => {
  it("returns the value it was given", () => {
    assert.equal(commitSha("c0ffee1"), "c0ffee1");
  });

  it("throws naming the offending value", () => {
    assert.throws(() => commitSha("not-a-hash"), {
      name: "TypeError",
      message: /not-a-hash/,
    });
  });
});
