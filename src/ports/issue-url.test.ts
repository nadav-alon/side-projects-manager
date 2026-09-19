import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isIssueUrl, issueUrl } from "./issue-url.ts";

describe("isIssueUrl", () => {
  it("accepts what gh issue create answers with", () => {
    assert.ok(isIssueUrl("https://github.com/nadav-alon/pilot/issues/7"));
  });

  /** A self-hosted instance is as much a host as github.com is. */
  it("accepts an issue on a host of any name", () => {
    assert.ok(isIssueUrl("https://git.example.com/team/pilot/issues/7"));
    assert.ok(isIssueUrl("http://localhost:3000/team/pilot/issues/7"));
  });

  it("refuses what is not a URL at all", () => {
    assert.equal(isIssueUrl(""), false);
    assert.equal(isIssueUrl("nadav-alon/pilot"), false);
    assert.equal(isIssueUrl("issue-7-add-the-thing"), false);
  });

  /**
   * The path is the whole point: everything below lives on the same host as
   * the issue, and sending the developer to one of them instead is a record
   * that reads right and goes nowhere.
   */
  it("refuses another page on the same host", () => {
    assert.equal(isIssueUrl("https://github.com/nadav-alon/pilot"), false);
    assert.equal(
      isIssueUrl("https://github.com/nadav-alon/pilot/pull/7"),
      false,
    );
    assert.equal(
      isIssueUrl("https://github.com/nadav-alon/pilot/issues/7/comments"),
      false,
    );
    assert.equal(
      isIssueUrl("https://github.com/nadav-alon/pilot/issues/new"),
      false,
    );
  });

  it("refuses a scheme a browser would not open", () => {
    assert.equal(
      isIssueUrl("git@github.com:nadav-alon/pilot/issues/7"),
      false,
    );
  });
});

describe("issueUrl", () => {
  it("narrows an issue's address", () => {
    assert.equal(
      issueUrl("https://github.com/nadav-alon/pilot/issues/7"),
      "https://github.com/nadav-alon/pilot/issues/7",
    );
  });

  it("throws naming the value it refused", () => {
    assert.throws(
      () => issueUrl("https://github.com/nadav-alon/pilot/pull/7"),
      /pull\/7/,
    );
  });
});
