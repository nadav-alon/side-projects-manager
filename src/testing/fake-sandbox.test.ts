import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  branch,
  checkout,
  commitSha,
  issueNumber,
  modelName,
  pullRequestUrl,
  repoSlug,
  ticketGist,
  tokenCount,
  usd,
} from "../ports/index.ts";
import type {
  ApplyReviewOutcome,
  ApplyReviewTicket,
  RebaseOutcome,
  RebaseTicket,
  ReviewTicket,
  Ticket,
} from "../ports/index.ts";
import { FakeSandbox } from "./fake-sandbox.ts";
import { HANGS } from "./gate.ts";

const TICKET: Ticket = {
  repo: repoSlug("nadav-alon/pilot"),
  number: issueNumber(7),
  title: "Do the thing",
};

const REVIEW_TICKET: ReviewTicket = {
  ...TICKET,
  number: issueNumber(8),
  pullRequest: {
    kind: "review",
    url: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/9"),
  },
};

const APPLY_REVIEW_TICKET: ApplyReviewTicket = {
  ...TICKET,
  number: issueNumber(10),
  pullRequest: {
    kind: "apply-review",
    url: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/9"),
  },
};

const REBASE_TICKET: RebaseTicket = {
  ...TICKET,
  number: issueNumber(11),
  pullRequest: {
    kind: "rebase",
    url: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/9"),
  },
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

  it("returns a finished run's configured gist verbatim", async () => {
    const sandbox = new FakeSandbox();
    const worked = branch("issue-7-do-the-thing");
    const gist = ticketGist("Add retries to the flaky upload step.");
    sandbox.result = () => ({
      kind: "finished",
      branch: worked,
      commits: [],
      output: "done",
      tokensUsed: tokenCount(0),
      gist,
    });

    const withGist = await sandbox.run({ ticket: TICKET, checkout: CHECKOUT, spendCeiling: CEILING });

    assert.deepEqual(withGist, {
      kind: "finished",
      branch: worked,
      commits: [],
      output: "done",
      tokensUsed: tokenCount(0),
      gist,
    });
  });

  it("returns a finished run with no gist when none was configured", async () => {
    const sandbox = new FakeSandbox();
    const worked = branch("issue-7-do-the-thing");
    sandbox.result = () => ({
      kind: "finished",
      branch: worked,
      commits: [],
      output: "done",
      tokensUsed: tokenCount(0),
    });

    const withoutGist = await sandbox.run({ ticket: TICKET, checkout: CHECKOUT, spendCeiling: CEILING });

    assert.deepEqual(withoutGist, {
      kind: "finished",
      branch: worked,
      commits: [],
      output: "done",
      tokensUsed: tokenCount(0),
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

  it("finishes an apply-review run costlessly unless told otherwise, recording what was asked", async () => {
    const sandbox = new FakeSandbox();

    const outcome = await sandbox.applyReview({
      ticket: APPLY_REVIEW_TICKET,
      checkout: CHECKOUT,
      spendCeiling: CEILING,
      model: modelName("sonnet"),
    });

    assert.deepEqual(outcome, {
      kind: "finished",
      output: "",
      tokensUsed: tokenCount(0),
    });
    assert.deepEqual(
      sandbox.applyReviews.map((request) => [request.ticket.number, request.model]),
      [[10, "sonnet"]],
    );
    assert.deepEqual(sandbox.runs, []);
    assert.deepEqual(sandbox.reviews, []);
  });

  const APPLY_REVIEW_OUTCOMES: ApplyReviewOutcome[] = [
    { kind: "finished", output: "answered 3 threads", tokensUsed: tokenCount(10) },
    {
      kind: "gave-up",
      output: "tests stayed red",
      reason: "exit 1",
      tokensUsed: tokenCount(20),
    },
    {
      kind: "gave-up",
      output: "Branch moved: 0123456789abcdef0123456789abcdef01234567",
      reason: "the branch moved",
      tokensUsed: tokenCount(30),
      movedHead: commitSha("0123456789abcdef0123456789abcdef01234567"),
    },
    { kind: "limit-refused", words: "You've hit your session limit", tokensUsed: tokenCount(0) },
    {
      kind: "model-refused",
      refusal: { model: modelName("bogus"), words: "refused model bogus" },
      tokensUsed: tokenCount(0),
    },
  ];

  for (const configured of APPLY_REVIEW_OUTCOMES) {
    const moved = configured.kind === "gave-up" && configured.movedHead !== undefined;
    it(`returns an apply-review run's configured ${configured.kind}${moved ? " (branch moved)" : ""} result verbatim`, async () => {
      const sandbox = new FakeSandbox();
      sandbox.applyReviewResult = () => configured;

      const outcome = await sandbox.applyReview({
        ticket: APPLY_REVIEW_TICKET,
        checkout: CHECKOUT,
        spendCeiling: CEILING,
        model: modelName("bogus"),
      });

      assert.deepEqual(outcome, configured);
    });
  }

  it("finishes a rebase run costlessly unless told otherwise, recording what was asked", async () => {
    const sandbox = new FakeSandbox();

    const outcome = await sandbox.rebase({
      ticket: REBASE_TICKET,
      checkout: CHECKOUT,
      spendCeiling: CEILING,
      model: modelName("opus"),
    });

    assert.deepEqual(outcome, {
      kind: "finished",
      output: "",
      tokensUsed: tokenCount(0),
    });
    assert.deepEqual(
      sandbox.rebases.map((request) => [request.ticket.number, request.model]),
      [[11, "opus"]],
    );
    assert.deepEqual(sandbox.runs, []);
    assert.deepEqual(sandbox.reviews, []);
    assert.deepEqual(sandbox.applyReviews, []);
  });

  const REBASE_OUTCOMES: RebaseOutcome[] = [
    { kind: "finished", output: "rebased onto main", tokensUsed: tokenCount(10) },
    {
      kind: "gave-up",
      output: "could not resolve the conflict",
      reason: "conflict in src/index.ts",
      tokensUsed: tokenCount(20),
    },
    {
      kind: "gave-up",
      output: "Branch moved: 0123456789abcdef0123456789abcdef01234567",
      reason: "the branch moved",
      tokensUsed: tokenCount(30),
      movedHead: commitSha("0123456789abcdef0123456789abcdef01234567"),
    },
    { kind: "limit-refused", words: "You've hit your session limit", tokensUsed: tokenCount(0) },
    {
      kind: "model-refused",
      refusal: { model: modelName("bogus"), words: "refused model bogus" },
      tokensUsed: tokenCount(0),
    },
  ];

  for (const configured of REBASE_OUTCOMES) {
    const moved = configured.kind === "gave-up" && configured.movedHead !== undefined;
    it(`returns a rebase run's configured ${configured.kind}${moved ? " (branch moved)" : ""} result verbatim`, async () => {
      const sandbox = new FakeSandbox();
      sandbox.rebaseResult = () => configured;

      const outcome = await sandbox.rebase({
        ticket: REBASE_TICKET,
        checkout: CHECKOUT,
        spendCeiling: CEILING,
        model: modelName("bogus"),
      });

      assert.deepEqual(outcome, configured);
    });
  }

  it("holds rebase runs until released, like any other", HANGS, async () => {
    const sandbox = new FakeSandbox();
    sandbox.hold();

    const rebasing = sandbox.rebase({
      ticket: REBASE_TICKET,
      checkout: CHECKOUT,
      spendCeiling: CEILING,
    });
    await sandbox.whenHeld(1);
    assert.deepEqual(sandbox.held().map((ticket) => ticket.number), [11]);
    sandbox.release(REBASE_TICKET);
    await rebasing;
  });

  it("holds apply-review runs until released, like any other", HANGS, async () => {
    const sandbox = new FakeSandbox();
    sandbox.hold();

    const applying = sandbox.applyReview({
      ticket: APPLY_REVIEW_TICKET,
      checkout: CHECKOUT,
      spendCeiling: CEILING,
    });
    await sandbox.whenHeld(1);
    assert.deepEqual(sandbox.held().map((ticket) => ticket.number), [10]);
    sandbox.release(APPLY_REVIEW_TICKET);
    await applying;
  });

  it("holds runs and reviews until released, in any order, counting how many were in progress", HANGS, async () => {
    const sandbox = new FakeSandbox();
    sandbox.hold();

    const run = sandbox.run({ ticket: TICKET, checkout: CHECKOUT, spendCeiling: CEILING });
    const review = sandbox.review({
      ticket: REVIEW_TICKET,
      checkout: CHECKOUT,
      spendCeiling: CEILING,
    });
    await sandbox.whenHeld(2);
    assert.deepEqual(sandbox.held().map((ticket) => ticket.number), [7, 8]);
    sandbox.release(REVIEW_TICKET);
    await review;
    assert.deepEqual(sandbox.held().map((ticket) => ticket.number), [7]);
    sandbox.release(TICKET);
    await run;

    assert.equal(sandbox.mostInProgress, 2);
    assert.deepEqual(sandbox.held(), []);
  });
});
