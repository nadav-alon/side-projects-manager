import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Finished, IterationOutcome, Reviewed } from "./iteration-outcome.ts";
import {
  branch,
  commitSha,
  issueNumber,
  pullRequestUrl,
  repoSlug,
  tokenCount,
  type ReviewTicket,
  type Ticket,
} from "./ports/index.ts";
import { summaryBody, summaryLine, type SummaryFacts } from "./summary.ts";

const REPO = repoSlug("nadav-alon/pilot");
const PULL_REQUEST = pullRequestUrl("https://github.com/nadav-alon/pilot/pull/171");

function implementationTicket(number: number): Ticket {
  return { repo: REPO, number: issueNumber(number), title: `Ticket ${number}` };
}

function reviewTicket(number: number): ReviewTicket {
  return { repo: REPO, number: issueNumber(number), title: `Review ${number}`, pullRequest: { kind: "review", url: PULL_REQUEST } };
}

/** A finished run that opened a pull request and queued `reviewNumber` to review it. */
function finishedWithHandover(ticket: Ticket, reviewNumber: number): IterationOutcome {
  const finished: Finished = {
    kind: "finished",
    run: {
      kind: "finished",
      branch: branch("agent/171"),
      commits: [commitSha("a".repeat(40))],
      tokensUsed: tokenCount(1000),
      output: "done",
    },
    tokensUsed: tokenCount(1000),
    handover: {
      pullRequest: PULL_REQUEST,
      reviewTicket: reviewTicket(reviewNumber),
    },
  };
  return { repo: REPO, ticket, ...finished };
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

/** A review ticket's own run that gave up and was handed back. */
function reviewFailed(number: number): IterationOutcome {
  return {
    repo: REPO,
    ticket: reviewTicket(number),
    kind: "failed",
    failure: { kind: "gave-up", reason: "left the tests red", handedBack: true },
  };
}

/** A review ticket's own run that gave up and could not be handed back. */
function reviewFailedNotHandedBack(number: number): IterationOutcome {
  return {
    repo: REPO,
    ticket: reviewTicket(number),
    kind: "failed",
    failure: { kind: "gave-up", reason: "left the tests red", handedBack: false },
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
  };
}

function waitingLines(iterations: IterationOutcome[]): string[] {
  const body = summaryBody(facts(iterations), "line");
  const marker = "## Waiting on you";
  const index = body.indexOf(marker);
  if (index === -1) {
    return [];
  }
  return body
    .slice(index + marker.length)
    .split("\n")
    .filter((line) => line.startsWith("- "));
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

  it("renders the review's own still-open line, not a second line from its handover, when it ran but could not close its ticket", () => {
    const lines = waitingLines([
      finishedWithHandover(implementationTicket(181), 182),
      reviewedButNotClosed(182),
    ]);

    assert.deepEqual(lines, [
      `- ${REPO} #182: still ready-for-agent — its findings are on ${PULL_REQUEST}, but it could not be closed: the tracker was unreachable; close it yourself`,
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

describe("summaryLine", () => {
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

  it("does not double a closing period when the quoted reason already ends in one", () => {
    const iteration: IterationOutcome = {
      repo: REPO,
      ticket: implementationTicket(185),
      kind: "failed",
      failure: {
        kind: "gave-up",
        reason: "left the tests red at 2168fc2c.",
        handedBack: true,
      },
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
      failure: {
        kind: "gave-up",
        reason: "left the branch on finding-shape\n",
        handedBack: true,
      },
    };

    const line = summaryLine(facts([iteration]));

    assert.match(line, /left the branch on finding-shape\. Handed back for a human\./);
  });

  it("keeps a quoted reason's own ellipsis instead of eating it as trailing punctuation", () => {
    const iteration: IterationOutcome = {
      repo: REPO,
      ticket: implementationTicket(187),
      kind: "failed",
      failure: {
        kind: "gave-up",
        reason: "left the tests red at 2168fc2c...",
        handedBack: true,
      },
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
    });

    assert.match(line, /The invocation did not finish: the process crashed\./);
    assert.doesNotMatch(line, /\.\./);
  });

  it("trims a trailing newline from a hand-back failure before the em dash that follows it", () => {
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
      handbackFailure: "the tracker was unreachable\n",
    };

    const line = summaryLine(facts([finished]));

    assert.match(
      line,
      /could not be handed back: the tracker was unreachable — still ready-for-agent/,
    );
  });
});
