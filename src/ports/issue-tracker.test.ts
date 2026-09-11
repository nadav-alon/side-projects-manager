import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isReviewTitle, reviewTitle } from "./issue-tracker.ts";
import { repoSlug } from "./repo-slug.ts";
import type { Ticket } from "./issue-tracker.ts";

const PILOT = repoSlug("nadav-alon/pilot");
const TICKET: Ticket = { repo: PILOT, number: 7, title: "Add the thing" };

describe("isReviewTitle", () => {
  it("recognises whatever reviewTitle names", () => {
    assert.equal(isReviewTitle(reviewTitle(TICKET)), true);
  });

  it("rejects an implementation ticket's own title", () => {
    assert.equal(isReviewTitle(TICKET.title), false);
  });

  it("rejects a title that only resembles one", () => {
    assert.equal(isReviewTitle("Review the draft pull request"), false);
    assert.equal(isReviewTitle("Review the draft pull request for #"), false);
    assert.equal(
      isReviewTitle("please Review the draft pull request for #7"),
      false,
    );
  });
});
