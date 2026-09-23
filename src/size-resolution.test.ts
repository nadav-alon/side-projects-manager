import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sizeProblem, unusableSizeLabel } from "./size-resolution.ts";
import { issueNumber, pullRequestUrl, sizeLabelOf, type Ticket } from "./ports/index.ts";
import { PILOT } from "./testing/index.ts";

const REVIEW_PULL_REQUEST = pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12");

function implementationTicket(labels: string[] = []): Ticket {
  const sizeLabel = sizeLabelOf(labels);
  return {
    repo: PILOT,
    number: issueNumber(7),
    title: "Add the thing",
    ...(sizeLabel !== undefined && { sizeLabel }),
  };
}

function reviewTicket(labels: string[] = []): Ticket {
  const sizeLabel = sizeLabelOf(labels);
  return {
    repo: PILOT,
    number: issueNumber(8),
    title: "Review #7",
    pullRequest: { kind: "review", url: REVIEW_PULL_REQUEST },
    ...(sizeLabel !== undefined && { sizeLabel }),
  };
}

describe("unusableSizeLabel", () => {
  it("is undefined for a ticket with no size label", () => {
    assert.equal(unusableSizeLabel(implementationTicket()), undefined);
  });

  it("is undefined for a ticket whose size label names a recognised size", () => {
    assert.equal(unusableSizeLabel(implementationTicket(["size:M"])), undefined);
  });

  it("names the offending labels for a size label naming no recognised size", () => {
    assert.deepEqual(unusableSizeLabel(implementationTicket(["size:XXL"])), {
      kind: "unusable-size-label",
      reason: "its size label names no size the budget document knows (size:XXL)",
      labels: ["size:XXL"],
    });
  });

  it("is undefined for a pull request ticket, whatever its own size label says", () => {
    assert.equal(unusableSizeLabel(reviewTicket(["size:XXL"])), undefined);
  });
});

describe("sizeProblem", () => {
  it("names the labels and says to fix or remove it, leaving the expected shape to the hand-back comment", () => {
    const { problem, fix } = sizeProblem({
      kind: "unusable-size-label",
      reason: "its size label names no size the budget document knows (size:XXL)",
      labels: ["size:XXL"],
    });

    assert.match(problem, /`size:XXL`/);
    assert.doesNotMatch(problem, /size:<size>/);
    assert.match(fix, /fix or remove it/);
  });
});
