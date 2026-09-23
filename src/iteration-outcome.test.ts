import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { countsAsWork, ranNothing, type Failed, type Iteration } from "./iteration-outcome.ts";
import { branch, commitSha, tokenCount } from "./ports/index.ts";

/** A failed iteration handed back ahead of the gate, for an unusable model label. */
const AHEAD_OF_GATE_FAILURE: Failed = {
  kind: "failed",
  failure: { kind: "unusable-model-label", labels: ["model: nonsense"] },
  handedBack: { outcome: "handed-back" },
};

describe("ranNothing", () => {
  it("says nothing ran for a pull request ticket resolved without a run", () => {
    const iteration: Iteration = { kind: "pull-request-resolved", resolution: "merged" };

    assert.equal(ranNothing(iteration), true);
  });

  it("says nothing ran for an applied-review iteration that found no thread open", () => {
    const iteration: Iteration = { kind: "applied-review" };

    assert.equal(ranNothing(iteration), true);
  });

  it("says something ran for an applied-review iteration that answered threads", () => {
    const iteration: Iteration = {
      kind: "applied-review",
      review: { kind: "finished", tokensUsed: tokenCount(500), output: "answered" },
    };

    assert.equal(ranNothing(iteration), false);
  });

  it("says nothing ran for a rebase iteration that found nothing to rebase", () => {
    const iteration: Iteration = { kind: "rebased" };

    assert.equal(ranNothing(iteration), true);
  });

  it("says something ran for a rebase iteration that rebased", () => {
    const iteration: Iteration = {
      kind: "rebased",
      rebase: { kind: "finished", tokensUsed: tokenCount(500), output: "rebased" },
    };

    assert.equal(ranNothing(iteration), false);
  });

  it("says nothing ran for a ticket handed back ahead of the gate", () => {
    assert.equal(ranNothing(AHEAD_OF_GATE_FAILURE), true);
  });

  it("says nothing ran for a ticket whose pull request's mergeability never settled", () => {
    const iteration: Iteration = {
      kind: "failed",
      failure: { kind: "unsettled-mergeability", reason: "the pull request is gone" },
      handedBack: { outcome: "handed-back" },
    };

    assert.equal(ranNothing(iteration), true);
  });

  it("says something ran for a ticket the agent gave up on mid-run", () => {
    const iteration: Iteration = {
      kind: "failed",
      failure: { kind: "gave-up", reason: "left the tests red" },
      handedBack: { outcome: "handed-back" },
    };

    assert.equal(ranNothing(iteration), false);
  });

  it("says something ran for a finished run", () => {
    const iteration: Iteration = {
      kind: "finished",
      run: {
        kind: "finished",
        branch: branch("agent/171"),
        commits: [commitSha("a".repeat(40))],
        tokensUsed: tokenCount(1_000),
        output: "done",
      },
      tokensUsed: tokenCount(1_000),
      handedBack: { outcome: "handed-back" },
    };

    assert.equal(ranNothing(iteration), false);
  });

  it("says something ran for a limit refusal, which spent tokens reaching it", () => {
    const iteration: Iteration = {
      kind: "limit-refused",
      limitRefusal: "the provider limit refused this run",
      tokensUsed: tokenCount(500),
      discard: { kind: "none" },
    };

    assert.equal(ranNothing(iteration), false);
  });
});

describe("countsAsWork", () => {
  it("does not count a limit refusal as work, since it never happened", () => {
    const iteration: Iteration = {
      kind: "limit-refused",
      limitRefusal: "the provider limit refused this run",
      tokensUsed: tokenCount(500),
      discard: { kind: "none" },
    };

    assert.equal(countsAsWork(iteration), false);
  });

  it("does not count a ticket handed back ahead of the gate as work", () => {
    assert.equal(countsAsWork(AHEAD_OF_GATE_FAILURE), false);
  });

  it("counts a ticket the agent gave up on mid-run as work", () => {
    const iteration: Iteration = {
      kind: "failed",
      failure: { kind: "gave-up", reason: "left the tests red" },
      handedBack: { outcome: "handed-back" },
    };

    assert.equal(countsAsWork(iteration), true);
  });

  it("counts a provider failure as work, since the provider was reached", () => {
    const iteration: Iteration = {
      kind: "provider-failed",
      providerFailure: "the provider is down",
      tokensUsed: tokenCount(0),
      discard: { kind: "none" },
    };

    assert.equal(countsAsWork(iteration), true);
  });

  it("counts a finished run as work", () => {
    const iteration: Iteration = {
      kind: "finished",
      run: {
        kind: "finished",
        branch: branch("agent/171"),
        commits: [commitSha("a".repeat(40))],
        tokensUsed: tokenCount(1_000),
        output: "done",
      },
      tokensUsed: tokenCount(1_000),
      handedBack: { outcome: "handed-back" },
    };

    assert.equal(countsAsWork(iteration), true);
  });
});
