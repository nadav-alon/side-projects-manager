import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  branch,
  checkout,
  modelName,
  pullRequestUrl,
  repoSlug,
  tokenCount,
  usd,
} from "../ports/index.ts";
import type { ReviewTicket, Ticket } from "../ports/index.ts";
import { FakeSandbox } from "./fake-sandbox.ts";

const TICKET: Ticket = {
  repo: repoSlug("nadav-alon/pilot"),
  number: 7,
  title: "Do the thing",
};

const REVIEW_TICKET: ReviewTicket = {
  ...TICKET,
  number: 8,
  pullRequest: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/9"),
};

const CHECKOUT = checkout("/tmp/pilot");
const CEILING = usd(5);

describe("FakeSandbox", () => {
  it("records the model each run and review was asked for", async () => {
    const sandbox = new FakeSandbox();

    await sandbox.run({ ticket: TICKET, checkout: CHECKOUT, spendCeiling: CEILING });
    await sandbox.run({
      ticket: TICKET,
      checkout: CHECKOUT,
      spendCeiling: CEILING,
      model: modelName("opus"),
    });
    await sandbox.review({
      ticket: REVIEW_TICKET,
      checkout: CHECKOUT,
      spendCeiling: CEILING,
      model: modelName("haiku"),
    });

    assert.deepEqual(
      sandbox.runs.map((run) => run.model),
      [undefined, "opus"],
    );
    assert.deepEqual(
      sandbox.reviews.map((review) => review.model),
      ["haiku"],
    );
  });

  it("returns a run's configured result verbatim, detecting nothing itself", async () => {
    const sandbox = new FakeSandbox();
    const bogus = modelName("bogus");
    const refused = branch("issue-7-do-the-thing");
    sandbox.result = () => ({
      kind: "model-refused",
      refusal: { model: bogus, words: "refused model bogus" },
      tokensUsed: tokenCount(0),
      branch: refused,
      commits: [],
    });

    const run = await sandbox.run({
      ticket: TICKET,
      checkout: CHECKOUT,
      spendCeiling: CEILING,
      model: bogus,
    });

    assert.deepEqual(run, {
      kind: "model-refused",
      refusal: { model: bogus, words: "refused model bogus" },
      tokensUsed: tokenCount(0),
      branch: refused,
      commits: [],
    });
  });

  it("returns a review's configured result verbatim, detecting nothing itself", async () => {
    const sandbox = new FakeSandbox();
    sandbox.reviewResult = () => ({
      kind: "gave-up",
      output: "could not review",
      reason: "no diff to review",
      tokensUsed: tokenCount(0),
    });

    const review = await sandbox.review({
      ticket: REVIEW_TICKET,
      checkout: CHECKOUT,
      spendCeiling: CEILING,
    });

    assert.deepEqual(review, {
      kind: "gave-up",
      output: "could not review",
      reason: "no diff to review",
      tokensUsed: tokenCount(0),
    });
  });
});
