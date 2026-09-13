import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkout,
  modelName,
  pullRequestUrl,
  repoSlug,
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

  it("refuses the model it was told to, for runs and reviews alike", async () => {
    const sandbox = new FakeSandbox();
    sandbox.refusedModel = modelName("bogus");

    const run = await sandbox.run({
      ticket: TICKET,
      checkout: CHECKOUT,
      spendCeiling: CEILING,
      model: modelName("bogus"),
    });
    const review = await sandbox.review({
      ticket: REVIEW_TICKET,
      checkout: CHECKOUT,
      spendCeiling: CEILING,
      model: modelName("bogus"),
    });

    assert.equal(run.modelRefusal?.model, "bogus");
    assert.equal(run.failure, undefined);
    assert.equal(review.modelRefusal?.model, "bogus");
    assert.equal(review.failure, undefined);
  });

  it("runs any other model, and a run naming none, as usual", async () => {
    const sandbox = new FakeSandbox();
    sandbox.refusedModel = modelName("bogus");

    const named = await sandbox.run({
      ticket: TICKET,
      checkout: CHECKOUT,
      spendCeiling: CEILING,
      model: modelName("opus"),
    });
    const unnamed = await sandbox.run({
      ticket: TICKET,
      checkout: CHECKOUT,
      spendCeiling: CEILING,
    });

    assert.equal(named.modelRefusal, undefined);
    assert.equal(unnamed.modelRefusal, undefined);
  });
});
