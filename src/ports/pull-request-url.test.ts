import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isPullRequestUrl, pullRequestUrl } from "./pull-request-url.ts";

describe("isPullRequestUrl", () => {
  it("accepts what gh pr create answers with", () => {
    assert.ok(isPullRequestUrl("https://github.com/nadav-alon/pilot/pull/7"));
  });

  /** A self-hosted instance is as much a host as github.com is. */
  it("accepts a pull request on a host of any name", () => {
    assert.ok(isPullRequestUrl("https://git.example.com/team/pilot/pull/7"));
    assert.ok(isPullRequestUrl("http://localhost:3000/team/pilot/pull/7"));
  });

  it("refuses what is not a URL at all", () => {
    assert.equal(isPullRequestUrl(""), false);
    assert.equal(isPullRequestUrl("nadav-alon/pilot"), false);
    assert.equal(isPullRequestUrl("issue-7-add-the-thing"), false);
  });

  /**
   * The path is the whole point: everything below lives on the same host as
   * the pull request, and sending the developer to one of them instead is a
   * report that reads right and goes nowhere.
   */
  it("refuses another page on the same host", () => {
    assert.equal(
      isPullRequestUrl("https://github.com/nadav-alon/pilot"),
      false,
    );
    assert.equal(
      isPullRequestUrl("https://github.com/nadav-alon/pilot/issues/7"),
      false,
    );
    assert.equal(
      isPullRequestUrl("https://github.com/nadav-alon/pilot/pull/7/files"),
      false,
    );
    assert.equal(
      isPullRequestUrl("https://github.com/nadav-alon/pilot/pull/new"),
      false,
    );
  });

  it("refuses a scheme a browser would not open", () => {
    assert.equal(
      isPullRequestUrl("git@github.com:nadav-alon/pilot/pull/7"),
      false,
    );
  });
});

describe("pullRequestUrl", () => {
  it("narrows a pull request's address", () => {
    assert.equal(
      pullRequestUrl("https://github.com/nadav-alon/pilot/pull/7"),
      "https://github.com/nadav-alon/pilot/pull/7",
    );
  });

  it("throws naming the value it refused", () => {
    assert.throws(
      () => pullRequestUrl("https://github.com/nadav-alon/pilot/issues/7"),
      /issues\/7/,
    );
  });
});
