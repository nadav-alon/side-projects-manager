import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ticketKind } from "./issue-tracker.ts";
import { pullRequestUrl } from "./pull-request-url.ts";
import { repoSlug } from "./repo-slug.ts";

const PILOT = repoSlug("nadav-alon/pilot");

describe("ticketKind", () => {
  it("reads a ticket naming a pull request as a review", () => {
    const ticket = {
      repo: PILOT,
      number: 13,
      title: "Review #12",
      pullRequest: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
    };

    assert.equal(ticketKind(ticket), "review");
  });

  it("reads a ticket naming no pull request as an implementation", () => {
    assert.equal(
      ticketKind({ repo: PILOT, number: 12, title: "Add a thing" }),
      "implementation",
    );
  });
});
