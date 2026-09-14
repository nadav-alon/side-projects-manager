import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Finished, IterationOutcome, Reviewed } from "./iteration-outcome.ts";
import {
  branch,
  commitSha,
  pullRequestUrl,
  repoSlug,
  tokenCount,
  type RepoSlug,
  type Ticket,
} from "./ports/index.ts";
import { summaryBody, type SummaryFacts } from "./summary.ts";

const REPO = repoSlug("nadav-alon/pilot");
const PULL_REQUEST = pullRequestUrl("https://github.com/nadav-alon/pilot/pull/171");

function implementationTicket(number: number): Ticket {
  return { repo: REPO, number, title: `Ticket ${number}` };
}

function reviewTicket(number: number) {
  return { repo: REPO, number, title: `Review ${number}`, pullRequest: { kind: "review" as const, url: PULL_REQUEST } };
}

/** A finished run that opened a pull request and queued `reviewNumber` to review it. */
function finishedWithHandover(
  repo: RepoSlug,
  ticket: Ticket,
  reviewNumber: number,
): IterationOutcome {
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
  return { repo, ticket, ...finished };
}

/** A review ticket's own run that finished and closed its ticket cleanly. */
function reviewedCleanly(repo: RepoSlug, number: number): IterationOutcome {
  const reviewed: Reviewed = {
    kind: "reviewed",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "posted" },
    tokensUsed: tokenCount(500),
  };
  return { repo, ticket: reviewTicket(number), ...reviewed };
}

/** A review ticket's own run that gave up and was handed back. */
function reviewFailed(repo: RepoSlug, number: number): IterationOutcome {
  return {
    repo,
    ticket: reviewTicket(number),
    kind: "failed",
    failure: { kind: "gave-up", reason: "left the tests red", handedBack: true },
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
      finishedWithHandover(REPO, implementationTicket(171), 172),
      reviewedCleanly(REPO, 172),
    ]);

    assert.deepEqual(lines, [`- ${REPO}: ${PULL_REQUEST} — reviewed, findings posted`]);
  });

  it("renders one line when the review ticket failed this invocation, not a queue line and a hand-back line", () => {
    const lines = waitingLines([
      finishedWithHandover(REPO, implementationTicket(173), 174),
      reviewFailed(REPO, 174),
    ]);

    assert.deepEqual(lines, [`- ${REPO} #174: relabelled ready-for-human`]);
  });

  it("still renders the review as queued when it was not worked this invocation", () => {
    const lines = waitingLines([finishedWithHandover(REPO, implementationTicket(175), 176)]);

    assert.deepEqual(lines, [`- ${REPO}: ${PULL_REQUEST} — review queued as #176`]);
  });
});
