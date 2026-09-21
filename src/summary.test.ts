import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ConflictSweepOutcome } from "./conflict-sweep.ts";
import type { Discard } from "./hand-back.ts";
import type {
  AppliedReview,
  Finished,
  IterationOutcome,
  PullRequestResolved,
  Reviewed,
} from "./iteration-outcome.ts";
import type { GateStandDown } from "./morning-run.ts";
import {
  branch,
  commitSha,
  issueNumber,
  pullRequestUrl,
  repoSlug,
  tokenCount,
  transcriptPath,
  type ApplyReviewTicket,
  type Branch,
  type ReviewTicket,
  type Size,
  type Ticket,
} from "./ports/index.ts";
import { summaryBody, summaryLine, type SummaryFacts } from "./summary.ts";
import { LIMIT_REFUSAL, SPENDABLE_THIS_WEEK } from "./testing/index.ts";

const REPO = repoSlug("nadav-alon/pilot");
const PULL_REQUEST = pullRequestUrl("https://github.com/nadav-alon/pilot/pull/171");

function implementationTicket(number: number): Ticket {
  return { repo: REPO, number: issueNumber(number), title: `Ticket ${number}` };
}

/** An implementation ticket's own run the provider limit refused, discarding or salvaging its branch as `discard` says. */
function limitRefused(number: number, discard: Discard): IterationOutcome {
  return {
    repo: REPO,
    ticket: implementationTicket(number),
    kind: "limit-refused",
    limitRefusal: LIMIT_REFUSAL,
    tokensUsed: tokenCount(500),
    discard,
  };
}

/** An implementation ticket's own run that failed post-start, salvaging its branch when `salvage` is given. */
function infrastructureFailure(
  number: number,
  salvage?: { branch: Branch; limitRefusals: number },
): IterationOutcome {
  return {
    repo: REPO,
    ticket: implementationTicket(number),
    kind: "failed",
    tokensUsed: tokenCount(42_000),
    failure: {
      kind: "infrastructure",
      reason: "git could not fetch the branch back into the checkout",
      tokensUsed: tokenCount(42_000),
      ...(salvage !== undefined && { salvage }),
    },
  };
}

function reviewTicket(number: number): ReviewTicket {
  return { repo: REPO, number: issueNumber(number), title: `Review ${number}`, pullRequest: { kind: "review", url: PULL_REQUEST } };
}

function applyReviewTicket(number: number): ApplyReviewTicket {
  return { repo: REPO, number: issueNumber(number), title: `Apply review ${number}`, pullRequest: { kind: "apply-review", url: PULL_REQUEST } };
}

/** A finished run's own outcome, spending `tokensUsed` on `branchName`, with `handover` if given one. */
function finishedRun(
  tokensUsed: number,
  branchName: string,
  handover?: Finished["handover"],
): Finished {
  return {
    kind: "finished",
    run: {
      kind: "finished",
      branch: branch(branchName),
      commits: [commitSha("a".repeat(40))],
      tokensUsed: tokenCount(tokensUsed),
      output: "done",
    },
    tokensUsed: tokenCount(tokensUsed),
    ...(handover === undefined ? {} : { handover }),
    handedBack: { outcome: "handed-back" },
  };
}

/** A finished run that opened a pull request and queued `reviewNumber` to review it. */
function finishedWithHandover(ticket: Ticket, reviewNumber: number): IterationOutcome {
  return {
    repo: REPO,
    ticket,
    ...finishedRun(1000, "agent/171", {
      pullRequest: PULL_REQUEST,
      reviewTicket: reviewTicket(reviewNumber),
    }),
  };
}

/** A finished run with no handover, spending `tokensUsed` against `estimateCharged`. */
function finishedSpending(
  ticket: Ticket,
  tokensUsed: number,
  estimateCharged: number,
): IterationOutcome {
  return {
    repo: REPO,
    ticket,
    estimateCharged: tokenCount(estimateCharged),
    ...finishedRun(tokensUsed, "agent/900"),
  };
}

/** `implementationTicket(number)`, declaring `size` as its size label. */
function sizedTicket(number: number, size: Size): Ticket {
  return { ...implementationTicket(number), sizeLabel: { kind: "declared", size } };
}

/** A review ticket's own run that finished and closed its ticket cleanly. */
function reviewedCleanly(number: number): IterationOutcome {
  const reviewed: Reviewed = {
    kind: "reviewed",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "posted" },
    tokensUsed: tokenCount(500),
  };
  return { repo: REPO, ticket: reviewTicket(number), ...reviewed };
}

/** A review ticket's own run that closed cleanly but the tracker could not close the ticket. */
function reviewedButNotClosed(number: number): IterationOutcome {
  const reviewed: Reviewed = {
    kind: "reviewed",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "posted" },
    tokensUsed: tokenCount(500),
    notClosed: { kind: "close-failed", error: "the tracker was unreachable" },
  };
  return { repo: REPO, ticket: reviewTicket(number), ...reviewed };
}

/** A review ticket's own run that closed its ticket cleanly but could not label its pull request. */
function reviewedButNotLabelled(number: number): IterationOutcome {
  const reviewed: Reviewed = {
    kind: "reviewed",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "posted" },
    tokensUsed: tokenCount(500),
    notLabelled: { error: "the label already existed with different case" },
  };
  return { repo: REPO, ticket: reviewTicket(number), ...reviewed };
}

/** A turbo project's review ticket that closed cleanly but whose apply-review comment was refused. */
function reviewedButNotCommented(number: number): IterationOutcome {
  const reviewed: Reviewed = {
    kind: "reviewed",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "posted" },
    tokensUsed: tokenCount(500),
    notCommented: { error: "the pull request is locked" },
  };
  return { repo: REPO, ticket: reviewTicket(number), ...reviewed };
}

/** An apply-review ticket's own run that finished and closed its ticket cleanly. */
function appliedReviewCleanly(number: number): IterationOutcome {
  const appliedReview: AppliedReview = {
    kind: "applied-review",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "answered" },
    tokensUsed: tokenCount(500),
    answers: { applied: 2, declined: 1 },
  };
  return { repo: REPO, ticket: applyReviewTicket(number), ...appliedReview };
}

/** An apply-review ticket's own run that closed its ticket cleanly but could not label its pull request. */
function appliedReviewButNotLabelled(number: number): IterationOutcome {
  const appliedReview: AppliedReview = {
    kind: "applied-review",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "answered" },
    tokensUsed: tokenCount(500),
    answers: { applied: 2, declined: 1 },
    notLabelled: { error: "the repo host refused the label" },
  };
  return { repo: REPO, ticket: applyReviewTicket(number), ...appliedReview };
}

/** A review ticket's own run that found its pull request already resolved, and closed it. */
function reviewResolved(number: number): IterationOutcome {
  const resolved: PullRequestResolved = {
    kind: "pull-request-resolved",
    resolution: "merged",
  };
  return { repo: REPO, ticket: reviewTicket(number), ...resolved };
}

/** A review ticket's own run that gave up and was handed back. */
function reviewFailed(number: number): IterationOutcome {
  return {
    repo: REPO,
    ticket: reviewTicket(number),
    kind: "failed",
    failure: { kind: "gave-up", reason: "left the tests red" },
    handedBack: { outcome: "handed-back" },
  };
}

/** A review ticket's own run that gave up and could not be handed back. */
function reviewFailedNotHandedBack(number: number): IterationOutcome {
  return {
    repo: REPO,
    ticket: reviewTicket(number),
    kind: "failed",
    failure: { kind: "gave-up", reason: "left the tests red" },
    handedBack: { outcome: "refused", reason: "the tracker was unreachable" },
  };
}

/** A review ticket's own run that gave up on a ticket an overlapping run had already closed. */
function reviewFailedAlreadyClosed(number: number): IterationOutcome {
  return {
    repo: REPO,
    ticket: reviewTicket(number),
    kind: "failed",
    failure: { kind: "gave-up", reason: "left the tests red" },
    handedBack: { outcome: "already-closed" },
  };
}

/** A review ticket's own run that never started: the sandbox or checkout failed. */
function reviewInfrastructureFailure(number: number): IterationOutcome {
  return {
    repo: REPO,
    ticket: reviewTicket(number),
    kind: "failed",
    failure: { kind: "infrastructure", reason: "docker died" },
  };
}

function facts(iterations: IterationOutcome[]): SummaryFacts {
  return {
    projects: [],
    iterations,
    standDown: undefined,
    invocationFailure: undefined,
    conflictSweeps: [],
  };
}

/** The bullet lines of the section starting at `marker`, cut off at `until` if given. */
function sectionLines(
  iterations: IterationOutcome[],
  marker: string,
  until?: string,
): string[] {
  const body = summaryBody(facts(iterations), "line");
  const index = body.indexOf(marker);
  if (index === -1) {
    return [];
  }
  const rest = body.slice(index + marker.length);
  const end = until === undefined ? -1 : rest.indexOf(until);
  return (end === -1 ? rest : rest.slice(0, end))
    .split("\n")
    .filter((line) => line.startsWith("- "));
}

function waitingLines(iterations: IterationOutcome[]): string[] {
  return sectionLines(iterations, "## Waiting on you");
}

function attemptsLines(iterations: IterationOutcome[]): string[] {
  return sectionLines(iterations, "## Attempts", "## Waiting on you");
}

describe("waitingSection", () => {
  it("renders one line naming the pull request as reviewed, when the review ticket was reviewed this invocation", () => {
    const lines = waitingLines([
      finishedWithHandover(implementationTicket(171), 172),
      reviewedCleanly(172),
    ]);

    assert.deepEqual(lines, [`- ${REPO}: ${PULL_REQUEST} — reviewed, findings posted`]);
  });

  it("renders one line when the review ticket failed this invocation, not a queue line and a hand-back line", () => {
    const lines = waitingLines([
      finishedWithHandover(implementationTicket(173), 174),
      reviewFailed(174),
    ]);

    assert.deepEqual(lines, [`- ${REPO} #174: relabelled ready-for-human`]);
  });

  it("still renders the review as queued when it was not worked this invocation", () => {
    const lines = waitingLines([finishedWithHandover(implementationTicket(175), 176)]);

    assert.deepEqual(lines, [`- ${REPO}: ${PULL_REQUEST} — review queued as #176`]);
  });

  it("still renders the review as queued when it never started this invocation: an infrastructure failure leaves it untouched", () => {
    const lines = waitingLines([
      finishedWithHandover(implementationTicket(177), 178),
      reviewInfrastructureFailure(178),
    ]);

    assert.deepEqual(lines, [
      `- ${REPO}: ${PULL_REQUEST} — review queued as #178`,
      `- ${REPO} #178: still ready-for-agent — the sandbox or checkout failed, so fix the setup: docker died`,
    ]);
  });

  it("drops the pull request when a worked review could not be handed back, keeping only its own still-eligible line", () => {
    const lines = waitingLines([
      finishedWithHandover(implementationTicket(179), 180),
      reviewFailedNotHandedBack(180),
    ]);

    assert.deepEqual(lines, [
      `- ${REPO} #180: still ready-for-agent — the hand-back itself failed, relabel it yourself`,
    ]);
  });

  it("still renders the pull request as queued for review when an overlapping run had already closed the review ticket", () => {
    const lines = waitingLines([
      finishedWithHandover(implementationTicket(190), 191),
      reviewFailedAlreadyClosed(191),
    ]);

    assert.deepEqual(lines, [`- ${REPO}: ${PULL_REQUEST} — review queued as #191`]);
  });

  it("renders nothing for a review ticket closed this invocation because its own pull request had already resolved", () => {
    const lines = waitingLines([
      finishedWithHandover(implementationTicket(192), 193),
      reviewResolved(193),
    ]);

    assert.deepEqual(lines, []);
  });

  it("renders the review's own still-open line, not a second line from its handover, when it ran but could not close its ticket", () => {
    const lines = waitingLines([
      finishedWithHandover(implementationTicket(181), 182),
      reviewedButNotClosed(182),
    ]);

    assert.deepEqual(lines, [
      `- ${REPO} #182: still ready-for-agent — its findings are on ${PULL_REQUEST}, but it could not be closed: the tracker was unreachable; close it yourself`,
    ]);
  });

  it("renders both the handover's reviewed line and its own waiting line, when a reviewed iteration worked from a handover this invocation could not be labelled", () => {
    const lines = waitingLines([
      finishedWithHandover(implementationTicket(182), 183),
      reviewedButNotLabelled(183),
    ]);

    assert.deepEqual(lines, [
      `- ${REPO}: ${PULL_REQUEST} — reviewed, findings posted`,
      `- ${REPO} #183: ${PULL_REQUEST} could not be labelled reviewed: the label already existed with different case; add the label yourself`,
    ]);
  });

  it("renders both the handover's reviewed line and its own waiting line, when a turbo review's comment was refused", () => {
    const lines = waitingLines([
      finishedWithHandover(implementationTicket(185), 186),
      reviewedButNotCommented(186),
    ]);

    assert.deepEqual(lines, [
      `- ${REPO}: ${PULL_REQUEST} — reviewed, findings posted`,
      `- ${REPO} #186: ${PULL_REQUEST} could not be posted /apply-review on: the pull request is locked; comment it yourself`,
    ]);
  });

  it("lists an applied-review iteration under waiting on you when its pull request could not be labelled, alongside its ready-for-review line", () => {
    const lines = waitingLines([appliedReviewButNotLabelled(184)]);

    assert.deepEqual(lines, [
      `- ${REPO}: ${PULL_REQUEST} — ready for review`,
      `- ${REPO} #184: ${PULL_REQUEST} could not be labelled applied-review: the repo host refused the label; add the label yourself`,
    ]);
  });

  it("does not split the list in two when an infrastructure failure's reason ends in a newline", () => {
    const first: IterationOutcome = {
      repo: REPO,
      ticket: implementationTicket(189),
      kind: "failed",
      failure: { kind: "infrastructure", reason: "docker died\n" },
    };
    const second: IterationOutcome = {
      repo: REPO,
      ticket: implementationTicket(190),
      kind: "failed",
      failure: { kind: "infrastructure", reason: "disk full" },
    };

    const body = summaryBody(facts([first, second]), "line");
    const section = body.slice(body.indexOf("## Waiting on you"));

    assert.doesNotMatch(section, /\n\n/);
    assert.deepEqual(
      section.split("\n").filter((line) => line !== ""),
      [
        "## Waiting on you",
        `- ${REPO} #189: still ready-for-agent — the sandbox or checkout failed, so fix the setup: docker died`,
        `- ${REPO} #190: still ready-for-agent — the sandbox or checkout failed, so fix the setup: disk full`,
      ],
    );
  });
});

describe("attemptsSection", () => {
  it("shows tokens spent beside the run estimate with no flag when under it", () => {
    const lines = attemptsLines([finishedSpending(implementationTicket(300), 1_400_000, 2_000_000)]);

    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /1,400,000 \/ 2,000,000 tokens/);
    assert.doesNotMatch(lines[0] ?? "", /over its/);
  });

  it("shows no flag when the run landed exactly on its estimate", () => {
    const lines = attemptsLines([finishedSpending(implementationTicket(301), 2_000_000, 2_000_000)]);

    assert.doesNotMatch(lines[0] ?? "", /over its/);
  });

  it("flags a run that spent past its estimate, naming its declared size", () => {
    const lines = attemptsLines([finishedSpending(sizedTicket(302, "S"), 600_000, 500_000)]);

    assert.match(lines[0] ?? "", /600,000 \/ 500,000 tokens, over its S estimate/);
  });

  it("names the flag unsized when the over-estimate ticket carries no size label", () => {
    const lines = attemptsLines([finishedSpending(implementationTicket(303), 2_500_000, 2_000_000)]);

    assert.match(lines[0] ?? "", /2,500,000 \/ 2,000,000 tokens, over its unsized estimate/);
  });

  it("flags a pull request ticket unsized even when it carries its own size label, since that is never counted", () => {
    const ticket: ReviewTicket = { ...reviewTicket(304), sizeLabel: { kind: "declared", size: "XL" } };
    const reviewed: Reviewed = {
      kind: "reviewed",
      review: { kind: "finished", tokensUsed: tokenCount(3_000_000), output: "posted" },
      tokensUsed: tokenCount(3_000_000),
    };
    const iteration: IterationOutcome = {
      repo: REPO,
      ticket,
      estimateCharged: tokenCount(2_000_000),
      ...reviewed,
    };

    const lines = attemptsLines([iteration]);

    assert.match(lines[0] ?? "", /over its unsized estimate/);
  });

  it("says cost unknown when nothing recorded what a failed run spent", () => {
    const iteration: IterationOutcome = {
      repo: REPO,
      ticket: implementationTicket(305),
      kind: "failed",
      failure: { kind: "gave-up", reason: "left the tests red" },
      handedBack: { outcome: "handed-back" },
    };

    const lines = attemptsLines([iteration]);

    assert.match(lines[0] ?? "", /cost unknown/);
  });

  it("says the estimate is unknown, rather than dropping it silently, should a worked run ever carry none", () => {
    const iteration: IterationOutcome = {
      repo: REPO,
      ticket: implementationTicket(306),
      ...finishedRun(750_000, "agent/306"),
    };

    const lines = attemptsLines([iteration]);

    assert.match(lines[0] ?? "", /750,000 tokens, estimate unknown/);
  });
});

describe("a ticket handed back for an unusable size label", () => {
  function unusableSizeLabel(number: number): IterationOutcome {
    return {
      repo: REPO,
      ticket: implementationTicket(number),
      kind: "failed",
      failure: {
        kind: "unusable-size-label",
        reason: "size:XXL names no size the budget document knows",
        labels: ["size:XXL"],
      },
      handedBack: { outcome: "handed-back" },
    };
  }

  it("says the ticket was not run and why, in the one-line summary", () => {
    const line = summaryLine(facts([unusableSizeLabel(306)]));

    assert.match(
      line,
      /#306 was not run, because size:XXL names no size the budget document knows\. Handed back for a human\./,
    );
  });

  it("lists it under waiting on you, quoting its size labels — like an unusable model label", () => {
    const lines = waitingLines([unusableSizeLabel(307)]);

    assert.deepEqual(lines, [
      `- ${REPO} #307: relabelled ready-for-human — fix its size label (size:XXL)`,
    ]);
  });
});

describe("summaryLine", () => {
  it("reads a reviewed iteration exactly as today when notLabelled is absent", () => {
    const line = summaryLine(facts([reviewedCleanly(210)]));

    assert.equal(line, `Reviewed ${REPO} #210: posted findings on ${PULL_REQUEST}.`);
  });

  it("names the pull request, the reviewed label and the error when a reviewed iteration could not be labelled", () => {
    const line = summaryLine(facts([reviewedButNotLabelled(211)]));

    assert.equal(
      line,
      `Reviewed ${REPO} #211: posted findings on ${PULL_REQUEST}. ${PULL_REQUEST} could not be labelled reviewed: the label already existed with different case; add the label yourself.`,
    );
  });

  it("names the pull request and the error when a turbo review's comment was refused", () => {
    const line = summaryLine(facts([reviewedButNotCommented(214)]));

    assert.equal(
      line,
      `Reviewed ${REPO} #214: posted findings on ${PULL_REQUEST}. ${PULL_REQUEST} could not be posted /apply-review on: the pull request is locked; comment it yourself.`,
    );
  });

  it("reads an applied-review iteration exactly as today when notLabelled is absent", () => {
    const line = summaryLine(facts([appliedReviewCleanly(212)]));

    assert.equal(
      line,
      `Applied review on ${REPO} #212: 2 applied, 1 declined on ${PULL_REQUEST}, now ready for review.`,
    );
  });

  it("names the pull request, the applied-review label and the error when an applied-review iteration could not be labelled", () => {
    const line = summaryLine(facts([appliedReviewButNotLabelled(213)]));

    assert.equal(
      line,
      `Applied review on ${REPO} #213: 2 applied, 1 declined on ${PULL_REQUEST}, now ready for review. ${PULL_REQUEST} could not be labelled applied-review: the repo host refused the label; add the label yourself.`,
    );
  });

  it("says the sandbox failed after the agent had already run when the infrastructure failure carries spend", () => {
    const iteration: IterationOutcome = {
      repo: REPO,
      ticket: implementationTicket(183),
      kind: "failed",
      tokensUsed: tokenCount(42_000),
      failure: {
        kind: "infrastructure",
        reason: "git could not fetch the branch back into the checkout",
        tokensUsed: tokenCount(42_000),
      },
    };

    const line = summaryLine(facts([iteration]));

    assert.match(line, /the sandbox failed on #183 after the agent had already run/);
  });

  it("says the run would not start when the infrastructure failure carries no spend", () => {
    const iteration: IterationOutcome = {
      repo: REPO,
      ticket: implementationTicket(184),
      kind: "failed",
      failure: { kind: "infrastructure", reason: "docker died" },
    };

    const line = summaryLine(facts([iteration]));

    assert.match(line, /the run would not start on #184/);
  });

  /**
   * What the gate's own arithmetic came to is proven in `budget-gate.test.ts`,
   * against the ledger and store fakes — this is only how the line reads once
   * that verdict is in hand, so it needs nothing more than the verdict itself.
   */
  describe("a gate refusal", () => {
    const RESETS_AT = new Date("2026-01-04T00:00:00.000Z");

    function gateStandDown(overrides: Partial<GateStandDown> = {}): GateStandDown {
      return {
        reason: "weekly-reserve",
        tokensUsed: tokenCount(SPENDABLE_THIS_WEEK + 1),
        spendable: tokenCount(SPENDABLE_THIS_WEEK),
        estimateCharged: tokenCount(2_000_000),
        resetsAt: RESETS_AT,
        refused: REPO,
        ...overrides,
      };
    }

    function standDownLine(standDown: GateStandDown): string {
      return summaryLine({
        projects: [],
        iterations: [],
        standDown,
        invocationFailure: undefined,
        conflictSweeps: [],
      });
    }

    it("says it stood down for the budget, not that there was nothing to do", () => {
      const line = standDownLine(gateStandDown());

      assert.match(line, /stood down/i);
      assert.match(line, /reserve/i);
      assert.doesNotMatch(line, /nothing to do/i);
    });

    it("says which project was ready and when the window resets", () => {
      const line = standDownLine(gateStandDown());

      assert.match(line, /nadav-alon\/pilot/);
      assert.match(line, new RegExp(RESETS_AT.toISOString()));
    });

    it("says the 5-hour window when that is what refused", () => {
      const line = standDownLine(
        gateStandDown({ reason: "five-hour-window" }),
      );

      assert.match(line, /5-hour/);
    });

    it("tells apart a window already spent from one only the estimate pushed over", () => {
      const spent = standDownLine(gateStandDown({ reason: "weekly-reserve" }));
      const estimate = standDownLine(
        gateStandDown({
          reason: "weekly-reserve-estimate",
          // Within spendable on its own, per the reason: only the estimate
          // charged (still 2,000,000, from the default) pushes it over.
          tokensUsed: tokenCount(SPENDABLE_THIS_WEEK - 1),
        }),
      );

      assert.match(spent, /reserve/i);
      assert.match(estimate, /estimate/i);
      assert.notEqual(spent, estimate);
    });

    it("says the estimate when the 5-hour window is only pushed over by it", () => {
      const line = standDownLine(
        gateStandDown({
          reason: "five-hour-window-estimate",
          tokensUsed: tokenCount(SPENDABLE_THIS_WEEK - 1),
        }),
      );

      assert.match(line, /5-hour/);
      assert.match(line, /estimate/i);
    });

    it("shows what was used, the estimate charged, what was spendable and when it resets, for a weekly-reserve estimate-caused stand-down", () => {
      const used = tokenCount(SPENDABLE_THIS_WEEK - 1);
      const line = standDownLine(
        gateStandDown({
          reason: "weekly-reserve-estimate",
          tokensUsed: used,
        }),
      );

      assert.match(line, new RegExp(used.toLocaleString("en-US")));
      assert.match(line, new RegExp(SPENDABLE_THIS_WEEK.toLocaleString("en-US")));
      assert.match(
        line,
        /2,000,000 tokens charged as the run estimate/,
      );
      assert.match(line, /run estimate \(plus any in-progress estimates\)/);
      assert.match(line, new RegExp(RESETS_AT.toISOString()));
    });

    it("shows what was used, the estimate charged, what was spendable and when it resets, for a 5-hour-window estimate-caused stand-down", () => {
      const used = tokenCount(SPENDABLE_THIS_WEEK - 1);
      const line = standDownLine(
        gateStandDown({
          reason: "five-hour-window-estimate",
          tokensUsed: used,
        }),
      );

      assert.match(line, new RegExp(used.toLocaleString("en-US")));
      assert.match(line, new RegExp(SPENDABLE_THIS_WEEK.toLocaleString("en-US")));
      assert.match(
        line,
        /2,000,000 tokens charged as the run estimate/,
      );
      assert.match(line, /run estimate \(plus any in-progress estimates\)/);
      assert.match(line, new RegExp(RESETS_AT.toISOString()));
    });
  });

  it("does not double a closing period when the quoted reason already ends in one", () => {
    const iteration: IterationOutcome = {
      repo: REPO,
      ticket: implementationTicket(185),
      kind: "failed",
      failure: { kind: "gave-up", reason: "left the tests red at 2168fc2c." },
      handedBack: { outcome: "handed-back" },
    };

    const line = summaryLine(facts([iteration]));

    assert.match(line, /left the tests red at 2168fc2c\. Handed back for a human\./);
    assert.doesNotMatch(line, /\.\./);
  });

  it("trims a trailing newline from a quoted reason before the closing period", () => {
    const iteration: IterationOutcome = {
      repo: REPO,
      ticket: implementationTicket(186),
      kind: "failed",
      failure: { kind: "gave-up", reason: "left the branch on finding-shape\n" },
      handedBack: { outcome: "handed-back" },
    };

    const line = summaryLine(facts([iteration]));

    assert.match(line, /left the branch on finding-shape\. Handed back for a human\./);
  });

  it("keeps a quoted reason's own ellipsis instead of eating it as trailing punctuation", () => {
    const iteration: IterationOutcome = {
      repo: REPO,
      ticket: implementationTicket(187),
      kind: "failed",
      failure: { kind: "gave-up", reason: "left the tests red at 2168fc2c..." },
      handedBack: { outcome: "handed-back" },
    };

    const line = summaryLine(facts([iteration]));

    assert.match(line, /left the tests red at 2168fc2c\.\.\.\s*Handed back for a human\./);
  });

  it("does not double a closing period on an invocation failure that already ends in one", () => {
    const line = summaryLine({
      projects: [],
      iterations: [],
      standDown: undefined,
      invocationFailure: "the process crashed.",
      conflictSweeps: [],
    });

    assert.match(line, /The invocation did not finish: the process crashed\./);
    assert.doesNotMatch(line, /\.\./);
  });

  it("trims a trailing newline from a hand-back failure before the semicolon that follows it", () => {
    const finished: IterationOutcome = {
      repo: REPO,
      ticket: implementationTicket(188),
      kind: "finished",
      run: {
        kind: "finished",
        branch: branch("agent/188"),
        commits: [commitSha("a".repeat(40))],
        tokensUsed: tokenCount(1000),
        output: "done",
      },
      tokensUsed: tokenCount(1000),
      handedBack: { outcome: "refused", reason: "the tracker was unreachable\n" },
    };

    const line = summaryLine(facts([finished]));

    assert.match(
      line,
      /still ready-for-agent and will come round again — the hand-back itself failed: the tracker was unreachable;/,
    );
  });

  it("says a ticket already closed by another run was left alone, not handed back or still eligible", () => {
    const iteration: IterationOutcome = {
      repo: REPO,
      ticket: implementationTicket(191),
      kind: "failed",
      failure: { kind: "gave-up", reason: "left the tests red" },
      handedBack: { outcome: "already-closed" },
    };

    const line = summaryLine(facts([iteration]));

    assert.match(line, /#191 was already closed by another run, so it was left alone/);
    assert.doesNotMatch(line, /Handed back for a human/);
    assert.doesNotMatch(line, /still ready-for-agent/);
  });

  it("names a missed supertask label even on a quiet morning nothing ran", () => {
    const flagged = implementationTicket(200);
    const line = summaryLine({
      projects: [
        {
          repo: REPO,
          verdict: "no-eligible-tickets",
          missingSupertaskLabel: [flagged],
        },
      ],
      iterations: [],
      standDown: undefined,
      invocationFailure: undefined,
      conflictSweeps: [],
    });

    assert.match(line, /Nothing to do: skipped/);
    assert.match(line, /Check for a missed supertask label: .*#200/);
  });
});

describe("transcript", () => {
  const TRANSCRIPT = transcriptPath("/home/node/.claude/projects/-repo/session.jsonl");

  it("names a finished run's transcript", () => {
    const iteration: IterationOutcome = {
      repo: REPO,
      ticket: implementationTicket(200),
      kind: "finished",
      run: {
        kind: "finished",
        branch: branch("agent/200"),
        commits: [commitSha("a".repeat(40))],
        tokensUsed: tokenCount(1000),
        output: "done",
        transcript: TRANSCRIPT,
      },
      tokensUsed: tokenCount(1000),
      handedBack: { outcome: "handed-back" },
    };

    const line = summaryLine(facts([iteration]));

    assert.match(line, new RegExp(`Transcript: ${TRANSCRIPT}\\.`));
  });

  it("names a failed run's transcript", () => {
    const iteration: IterationOutcome = {
      repo: REPO,
      ticket: implementationTicket(201),
      kind: "failed",
      failure: { kind: "gave-up", reason: "left the tests red" },
      handedBack: { outcome: "handed-back" },
      transcript: TRANSCRIPT,
    };

    const line = summaryLine(facts([iteration]));

    assert.match(line, new RegExp(`Transcript: ${TRANSCRIPT}\\.`));
  });

  it("names nothing when no transcript was ever found", () => {
    const iteration: IterationOutcome = {
      repo: REPO,
      ticket: implementationTicket(202),
      kind: "failed",
      failure: { kind: "gave-up", reason: "left the tests red" },
      handedBack: { outcome: "handed-back" },
    };

    const line = summaryLine(facts([iteration]));

    assert.doesNotMatch(line, /Transcript:/);
  });

  it("names a reviewed ticket's transcript", () => {
    const iteration: IterationOutcome = {
      repo: REPO,
      ticket: reviewTicket(203),
      kind: "reviewed",
      review: { kind: "finished", tokensUsed: tokenCount(500), output: "posted", transcript: TRANSCRIPT },
      tokensUsed: tokenCount(500),
    };

    const line = summaryLine(facts([iteration]));

    assert.match(line, new RegExp(`Transcript: ${TRANSCRIPT}\\.`));
  });
});

describe("salvage", () => {
  it("names a salvaged limit refusal's branch and says the next run will continue on it", () => {
    const line = summaryLine(
      facts([
        limitRefused(220, { kind: "salvaged", branch: branch("issue-220"), limitRefusals: 1 }),
      ]),
    );

    assert.match(
      line,
      /Its branch issue-220 was salvaged: the ticket's next run will continue on it\./,
    );
  });

  it("reads a limit refusal exactly as today when nothing was salvaged", () => {
    const line = summaryLine(facts([limitRefused(221, { kind: "none" })]));

    assert.equal(
      line,
      `The provider limit refused the run on ${REPO} #221.`,
    );
  });

  it("names a salvaged infrastructure failure's branch and says the next run will continue on it", () => {
    const line = summaryLine(
      facts([
        infrastructureFailure(222, { branch: branch("issue-222"), limitRefusals: 1 }),
      ]),
    );

    assert.match(
      line,
      /Its branch issue-222 was salvaged: the ticket's next run will continue on it\./,
    );
  });

  it("names nothing salvaged for an infrastructure failure whose branch never reached the checkout", () => {
    const line = summaryLine(facts([infrastructureFailure(223)]));

    assert.doesNotMatch(line, /salvaged/);
  });

  it("adds no repeated-refusal warning at one limit refusal in a row", () => {
    const line = summaryLine(
      facts([
        limitRefused(224, { kind: "salvaged", branch: branch("issue-224"), limitRefusals: 1 }),
      ]),
    );

    assert.doesNotMatch(line, /cut off/);
  });

  it("warns that a ticket has been cut off repeatedly at two or more limit refusals in a row", () => {
    const line = summaryLine(
      facts([
        limitRefused(225, { kind: "salvaged", branch: branch("issue-225"), limitRefusals: 3 }),
      ]),
    );

    assert.match(
      line,
      /This ticket has been cut off 3 times in a row: consider splitting it or giving it a larger size or model\./,
    );
  });

  it("adds no repeated-refusal warning on an infrastructure failure, whatever count its salvage carries over from an earlier limit refusal", () => {
    const line = summaryLine(
      facts([infrastructureFailure(226, { branch: branch("issue-226"), limitRefusals: 2 })]),
    );

    assert.doesNotMatch(line, /cut off/);
  });

  it("lists a limit-refused ticket under waiting on you once it has been cut off two or more times in a row", () => {
    const lines = waitingLines([
      limitRefused(227, { kind: "salvaged", branch: branch("issue-227"), limitRefusals: 2 }),
    ]);

    assert.deepEqual(lines, [
      `- ${REPO} #227: cut off 2 times in a row — consider splitting it or giving it a larger size or model`,
    ]);
  });

  it("does not list a limit-refused ticket under waiting on you at one refusal", () => {
    const lines = waitingLines([
      limitRefused(228, { kind: "salvaged", branch: branch("issue-228"), limitRefusals: 1 }),
    ]);

    assert.deepEqual(lines, []);
  });
});

describe("conflict sweeps", () => {
  const OTHER_REPO = repoSlug("nadav-alon/other");
  const OTHER_REPO_PULL_REQUEST = pullRequestUrl(
    "https://github.com/nadav-alon/other/pull/9",
  );

  /**
   * Facts naming a `no-eligible-tickets` project for every repo `conflictSweeps`
   * names, so the summary line takes the same "skipped" branch a real morning
   * would after sweeping a project with nothing else to work — the one branch
   * every non-empty-sweep test below needs to reach its own aside.
   */
  function factsWithSweeps(conflictSweeps: ConflictSweepOutcome[]): SummaryFacts {
    const repos = [...new Set(conflictSweeps.map((sweep) => sweep.repo))];
    return {
      ...facts([]),
      projects: repos.map((repo) => ({ repo, verdict: "no-eligible-tickets" as const })),
      conflictSweeps,
    };
  }

  it("renders nothing extra, byte for byte, when no sweep changed or refused anything", () => {
    const projects = [{ repo: REPO, verdict: "no-eligible-tickets" as const }];
    const withoutSweeps: SummaryFacts = { ...facts([]), projects };
    const withEmptySweeps: SummaryFacts = {
      ...facts([]),
      projects,
      conflictSweeps: [{ repo: REPO, changes: [], refusals: [] }],
    };

    const line = summaryLine(withoutSweeps);
    assert.equal(summaryLine(withEmptySweeps), line);
    assert.equal(
      summaryBody(withEmptySweeps, summaryLine(withEmptySweeps)),
      summaryBody(withoutSweeps, line),
    );
    assert.doesNotMatch(line, /Conflict sweep/);
  });

  it("names a labelled, an unlabelled and a commented pull request in the body, grouped by project", () => {
    const sweeps: ConflictSweepOutcome[] = [
      {
        repo: REPO,
        changes: [
          { pullRequest: PULL_REQUEST, action: "labelled" },
          { pullRequest: PULL_REQUEST, action: "unlabelled" },
          { pullRequest: PULL_REQUEST, action: "commented" },
        ],
        refusals: [],
      },
      {
        repo: OTHER_REPO,
        changes: [{ pullRequest: OTHER_REPO_PULL_REQUEST, action: "labelled" }],
        refusals: [],
      },
    ];

    const body = summaryBody(factsWithSweeps(sweeps), summaryLine(factsWithSweeps(sweeps)));
    const section = body.slice(body.indexOf("## Conflict sweeps"));

    assert.match(section, new RegExp(`- ${REPO}: labelled needs-rebase on ${PULL_REQUEST}`));
    assert.match(section, new RegExp(`- ${REPO}: removed needs-rebase from ${PULL_REQUEST}`));
    assert.match(section, new RegExp(`- ${REPO}: posted /rebase on ${PULL_REQUEST}`));
    assert.match(
      section,
      new RegExp(`- ${OTHER_REPO}: labelled needs-rebase on ${OTHER_REPO_PULL_REQUEST}`),
    );
    assert.doesNotMatch(section, new RegExp(`${OTHER_REPO}.*removed|${OTHER_REPO}.*posted`));
  });

  it("reports the same pull request and action once, however many sweeps met it", () => {
    const sweeps: ConflictSweepOutcome[] = [
      { repo: REPO, changes: [{ pullRequest: PULL_REQUEST, action: "labelled" }], refusals: [] },
      { repo: REPO, changes: [{ pullRequest: PULL_REQUEST, action: "labelled" }], refusals: [] },
    ];

    const body = summaryBody(factsWithSweeps(sweeps), summaryLine(factsWithSweeps(sweeps)));

    const matches = body.match(new RegExp(PULL_REQUEST, "g")) ?? [];
    assert.equal(matches.length, 1);
  });

  it("names what was refused and the error, and reports a repeated refusal once", () => {
    const sweeps: ConflictSweepOutcome[] = [
      {
        repo: REPO,
        changes: [],
        refusals: [
          { action: "label", pullRequest: PULL_REQUEST, error: "label does not exist" },
        ],
      },
      {
        repo: REPO,
        changes: [],
        refusals: [
          { action: "label", pullRequest: PULL_REQUEST, error: "label does not exist" },
        ],
      },
    ];

    const body = summaryBody(factsWithSweeps(sweeps), summaryLine(factsWithSweeps(sweeps)));

    const matches = body.match(/could not label/g) ?? [];
    assert.equal(matches.length, 1);
    assert.match(
      body,
      new RegExp(`- ${REPO}: could not label ${PULL_REQUEST} needs-rebase: label does not exist`),
    );
  });

  it("names the project, not a pull request, for a refused listing", () => {
    const sweeps: ConflictSweepOutcome[] = [
      { repo: REPO, changes: [], refusals: [{ action: "list", error: "listing refused" }] },
    ];

    const body = summaryBody(factsWithSweeps(sweeps), summaryLine(factsWithSweeps(sweeps)));

    assert.match(body, new RegExp(`- ${REPO}: could not list its open pull requests: listing refused`));
  });

  it("mentions sweeps in the summary line only when a comment was posted or something was refused, not for label changes alone", () => {
    const labelOnly = factsWithSweeps([
      {
        repo: REPO,
        changes: [
          { pullRequest: PULL_REQUEST, action: "labelled" },
          { pullRequest: OTHER_REPO_PULL_REQUEST, action: "unlabelled" },
        ],
        refusals: [],
      },
    ]);

    assert.doesNotMatch(summaryLine(labelOnly), /Conflict sweep/);
  });

  it("mentions the sweep in the summary line when it posted /rebase", () => {
    const commented = factsWithSweeps([
      { repo: REPO, changes: [{ pullRequest: PULL_REQUEST, action: "commented" }], refusals: [] },
    ]);

    assert.match(summaryLine(commented), /Conflict sweep: nadav-alon\/pilot \(posted \/rebase/);
  });

  it("mentions the sweep in the summary line when it was refused something", () => {
    const refused = factsWithSweeps([
      {
        repo: REPO,
        changes: [],
        refusals: [{ action: "read", pullRequest: PULL_REQUEST, error: "mergeability refused" }],
      },
    ]);

    assert.match(summaryLine(refused), /Conflict sweep: nadav-alon\/pilot \(refused once\)/);
  });
});
