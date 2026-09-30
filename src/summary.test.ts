import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ConflictSweepOutcome } from "./conflict-sweep.ts";
import type { DiscoveryReport, DiscoveryRouting } from "./discovery-routing.ts";
import type { Discard } from "./hand-back.ts";
import type { SpecReviewSweepOutcome } from "./spec-review-sweep.ts";
import type {
  AppliedReview,
  Finished,
  IterationOutcome,
  ModelRefused,
  PullRequestResolved,
  Reviewed,
  SpecReviewed,
  UniformFilesTouched,
  UnusableModelLabel,
  UnusableSizeLabel,
} from "./iteration-outcome.ts";
import { modelProblem } from "./model-resolution.ts";
import { sizeProblem } from "./size-resolution.ts";
import {
  branch,
  commitSha,
  issueNumber,
  issueUrl,
  localDay,
  localTimeOfMinute,
  modelName,
  processId,
  pullRequestUrl,
  repoSlug,
  tokenCount,
  transcriptPath,
  type ApplyReviewTicket,
  type Branch,
  type Discovery,
  type OpenInvocation,
  type ReviewTicket,
  type Size,
  type SpecReviewTicket,
  type Ticket,
} from "./ports/index.ts";
import {
  composeInvocationReport,
  summaryBody,
  summaryLine,
  type GateStandDown,
  type InvocationStandDown,
  type SummaryFacts,
  type SummaryTracker,
} from "./summary.ts";
import {
  BUDGET_EXHAUSTED_JSON_RESULT,
  LIMIT_REFUSAL,
  SPENDABLE_THIS_WEEK,
} from "./testing/index.ts";

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

/** A limit-refused run that filed `discoveryRouting` before the provider stopped it — never handed back for it, per CONTEXT.md's "Limit refusal". */
function limitRefusedWithDiscoveries(number: number, discoveryRouting: DiscoveryRouting): IterationOutcome {
  return {
    ...(limitRefused(number, { kind: "none" }) as Extract<IterationOutcome, { kind: "limit-refused" }>),
    discoveryReport: { routing: discoveryRouting },
  };
}

/** An implementation ticket's own run its spend ceiling stopped, discarding or salvaging its branch as `discard` says. */
function budgetExhausted(number: number, discard: Discard): IterationOutcome {
  return {
    repo: REPO,
    ticket: implementationTicket(number),
    kind: "budget-exhausted",
    words: BUDGET_EXHAUSTED_JSON_RESULT,
    tokensUsed: tokenCount(500),
    discard,
  };
}

/** An implementation ticket's own run that failed post-start, salvaging its branch when `salvage` is given. */
function infrastructureFailure(
  number: number,
  salvage?: { branch: Branch; stopShorts: number },
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

/** A review ticket's own run that found nothing to flag and marked its pull request ready. */
function cleanReview(number: number): IterationOutcome {
  const reviewed: Reviewed = {
    kind: "reviewed",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "posted" },
    tokensUsed: tokenCount(500),
    clean: true,
  };
  return { repo: REPO, ticket: reviewTicket(number), ...reviewed };
}

/** A clean review whose ticket closed but whose pull request could not be marked ready. */
function cleanReviewButNotReadied(number: number): IterationOutcome {
  const reviewed: Reviewed = {
    kind: "reviewed",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "posted" },
    tokensUsed: tokenCount(500),
    clean: true,
    notReadied: { error: "the pull request is locked" },
  };
  return { repo: REPO, ticket: reviewTicket(number), ...reviewed };
}

/** A turbo project's clean review the merge gate looked at but found not eligible to merge. */
function cleanReviewNotTurboable(number: number): IterationOutcome {
  const reviewed: Reviewed = {
    kind: "reviewed",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "posted" },
    tokensUsed: tokenCount(500),
    clean: true,
    merge: {
      kind: "not-turboable",
      reason: "not turboable before its own run started",
      declinedGrant: true,
    },
  };
  return { repo: REPO, ticket: reviewTicket(number), ...reviewed };
}

/** As `cleanReviewNotTurboable`, but declined for the run-span reason rather than the timeline. */
function cleanReviewNotTurboableInsideSpan(number: number): IterationOutcome {
  const reviewed: Reviewed = {
    kind: "reviewed",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "posted" },
    tokensUsed: tokenCount(500),
    clean: true,
    merge: {
      kind: "not-turboable",
      reason: "turboable granted inside a run span",
      declinedGrant: true,
    },
  };
  return { repo: REPO, ticket: reviewTicket(number), ...reviewed };
}

/**
 * A turbo project's clean review whose implementation ticket never carried
 * `turboable` at all: the merge gate still declines to merge, but there is
 * no grant to report, so the sentence carries no note of its own.
 */
function cleanReviewNeverLabelledTurboable(number: number): IterationOutcome {
  const reviewed: Reviewed = {
    kind: "reviewed",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "posted" },
    tokensUsed: tokenCount(500),
    clean: true,
    merge: { kind: "not-turboable", reason: "never labelled turboable", declinedGrant: false },
  };
  return { repo: REPO, ticket: reviewTicket(number), ...reviewed };
}

/** A turbo project's clean review the merge gate could not check the turboable timeline of. */
function cleanReviewTimelineUnreadable(number: number): IterationOutcome {
  const reviewed: Reviewed = {
    kind: "reviewed",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "posted" },
    tokensUsed: tokenCount(500),
    clean: true,
    merge: { kind: "timeline-unreadable", error: "tracker unavailable" },
  };
  return { repo: REPO, ticket: reviewTicket(number), ...reviewed };
}

/** A turboable ticket's clean review whose pull request the merge gate merged, closing `implementation`. */
function cleanReviewMerged(
  number: number,
  implementation: Ticket = implementationTicket(900),
): IterationOutcome {
  const reviewed: Reviewed = {
    kind: "reviewed",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "posted" },
    tokensUsed: tokenCount(500),
    clean: true,
    merge: { kind: "merged", implementationTicket: implementation },
  };
  return { repo: REPO, ticket: reviewTicket(number), ...reviewed };
}

/** A turboable ticket's clean review whose pull request the merge gate left for the developer to merge. */
function cleanReviewLeftForHuman(number: number): IterationOutcome {
  const reviewed: Reviewed = {
    kind: "reviewed",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "posted" },
    tokensUsed: tokenCount(500),
    clean: true,
    merge: { kind: "left-for-human", reason: "Pull Request is not mergeable" },
  };
  return { repo: REPO, ticket: reviewTicket(number), ...reviewed };
}

/** As `cleanReviewLeftForHuman`, but the ready-for-human label itself could not be applied. */
function cleanReviewLeftForHumanButNotLabelled(number: number): IterationOutcome {
  const reviewed: Reviewed = {
    kind: "reviewed",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "posted" },
    tokensUsed: tokenCount(500),
    clean: true,
    merge: {
      kind: "left-for-human",
      reason: "Pull Request is not mergeable",
      notLabelled: { error: "the repo host refused the label" },
    },
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

/** An apply-review ticket's own run that demoted a still-open Blocked on: off its pull request's closing reference before closing cleanly. */
function appliedReviewDemoted(
  number: number,
  implementation: Ticket = implementationTicket(900),
): IterationOutcome {
  const appliedReview: AppliedReview = {
    kind: "applied-review",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "answered" },
    tokensUsed: tokenCount(500),
    answers: { applied: 0, declined: 1 },
    demoted: implementation,
  };
  return { repo: REPO, ticket: applyReviewTicket(number), ...appliedReview };
}

/** An apply-review ticket's own run left ready-for-agent because a still-open Blocked on: could not be demoted off its pull request. */
function appliedReviewDemoteFailed(
  number: number,
  implementation: Ticket = implementationTicket(900),
): IterationOutcome {
  const appliedReview: AppliedReview = {
    kind: "applied-review",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "answered" },
    tokensUsed: tokenCount(500),
    answers: { applied: 0, declined: 1 },
    notClosed: { kind: "demote-failed", error: "pull request is locked", ticket: implementation },
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

/** A turbo project's apply-review run the merge gate looked at but found not eligible to merge. */
function appliedReviewNotTurboable(number: number): IterationOutcome {
  const appliedReview: AppliedReview = {
    kind: "applied-review",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "answered" },
    tokensUsed: tokenCount(500),
    answers: { applied: 2, declined: 1 },
    merge: {
      kind: "not-turboable",
      reason: "not turboable before its own run started",
      declinedGrant: true,
    },
  };
  return { repo: REPO, ticket: applyReviewTicket(number), ...appliedReview };
}

/** As `appliedReviewNotTurboable`, but declined for the run-span reason rather than the timeline. */
function appliedReviewNotTurboableInsideSpan(number: number): IterationOutcome {
  const appliedReview: AppliedReview = {
    kind: "applied-review",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "answered" },
    tokensUsed: tokenCount(500),
    answers: { applied: 2, declined: 1 },
    merge: {
      kind: "not-turboable",
      reason: "turboable granted inside a run span",
      declinedGrant: true,
    },
  };
  return { repo: REPO, ticket: applyReviewTicket(number), ...appliedReview };
}

/**
 * A turbo project's apply-review run whose implementation ticket never
 * carried `turboable` at all: no grant to report, so the sentence carries
 * no note of its own.
 */
function appliedReviewNeverLabelledTurboable(number: number): IterationOutcome {
  const appliedReview: AppliedReview = {
    kind: "applied-review",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "answered" },
    tokensUsed: tokenCount(500),
    answers: { applied: 2, declined: 1 },
    merge: { kind: "not-turboable", reason: "never labelled turboable", declinedGrant: false },
  };
  return { repo: REPO, ticket: applyReviewTicket(number), ...appliedReview };
}

/** A turbo project's apply-review run the merge gate could not check the turboable timeline of. */
function appliedReviewTimelineUnreadable(number: number): IterationOutcome {
  const appliedReview: AppliedReview = {
    kind: "applied-review",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "answered" },
    tokensUsed: tokenCount(500),
    answers: { applied: 2, declined: 0 },
    merge: { kind: "timeline-unreadable", error: "tracker unavailable" },
  };
  return { repo: REPO, ticket: applyReviewTicket(number), ...appliedReview };
}

/** A turboable ticket's apply-review run whose pull request the merge gate merged, closing `implementation`. */
function appliedReviewMerged(
  number: number,
  implementation: Ticket = implementationTicket(900),
): IterationOutcome {
  const appliedReview: AppliedReview = {
    kind: "applied-review",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "answered" },
    tokensUsed: tokenCount(500),
    answers: { applied: 2, declined: 0 },
    merge: { kind: "merged", implementationTicket: implementation },
  };
  return { repo: REPO, ticket: applyReviewTicket(number), ...appliedReview };
}

/** A turboable ticket's apply-review run whose pull request the merge gate left for the developer to merge. */
function appliedReviewLeftForHuman(number: number): IterationOutcome {
  const appliedReview: AppliedReview = {
    kind: "applied-review",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "answered" },
    tokensUsed: tokenCount(500),
    answers: { applied: 2, declined: 0 },
    merge: { kind: "left-for-human", reason: "Pull Request is not mergeable" },
  };
  return { repo: REPO, ticket: applyReviewTicket(number), ...appliedReview };
}

/** As `appliedReviewLeftForHuman`, but the ready-for-human label itself could not be applied. */
function appliedReviewLeftForHumanButNotLabelled(number: number): IterationOutcome {
  const appliedReview: AppliedReview = {
    kind: "applied-review",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "answered" },
    tokensUsed: tokenCount(500),
    answers: { applied: 2, declined: 0 },
    merge: {
      kind: "left-for-human",
      reason: "Pull Request is not mergeable",
      notLabelled: { error: "the repo host refused the label" },
    },
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

/** A discovery, correction by default, overridable to any of the four kinds. */
function discovery(overrides: Partial<Discovery> = {}): Discovery {
  return {
    kind: "correction",
    title: "The ticket names the wrong file",
    body: "It should touch src/widget.ts, not src/gadget.ts.",
    ...overrides,
  };
}

/** A routing with nothing filed, dropped or refused — override whichever a test needs. */
function routing(overrides: Partial<DiscoveryRouting> = {}): DiscoveryRouting {
  return {
    filed: [],
    suggestionsDropped: 0,
    refused: [],
    blocking: [],
    discoveriesDropped: 0,
    ...overrides,
  };
}

/** A `DiscoveryReport` for `discoveryRouting`, landing on `crossTarget` when given one. */
function discoveryReport(discoveryRouting: DiscoveryRouting, crossTarget?: Ticket): DiscoveryReport {
  return { routing: discoveryRouting, ...(crossTarget !== undefined && { crossTarget }) };
}

/** An implementation ticket's own run handed back for a blocking discovery carried by `discoveryRouting`. */
function discoveryBlocked(
  number: number,
  discoveryRouting: DiscoveryRouting,
): IterationOutcome {
  return {
    repo: REPO,
    ticket: implementationTicket(number),
    kind: "discovery-blocked",
    discoveryReport: { routing: discoveryRouting },
    tokensUsed: tokenCount(500),
    handedBack: { outcome: "handed-back" },
  };
}

/** An implementation ticket's own run blocked on an existing issue instead, kept ready-for-agent. */
function blockedOnExisting(
  number: number,
  discoveryRouting: DiscoveryRouting,
  discard: Discard = { kind: "discarded" },
): IterationOutcome {
  return {
    repo: REPO,
    ticket: implementationTicket(number),
    kind: "blocked-on-existing",
    discoveryReport: { routing: discoveryRouting },
    tokensUsed: tokenCount(500),
    branch: branch("agent/900"),
    discard,
  };
}

function specReviewTicket(number: number): SpecReviewTicket {
  return { repo: REPO, number: issueNumber(number), title: `Spec review ${number}`, specReview: true };
}

/** A spec review ticket's own run that finished and was handed back cleanly. */
function specReviewedCleanly(number: number): IterationOutcome {
  return {
    repo: REPO,
    ticket: specReviewTicket(number),
    kind: "spec-reviewed",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "no drift found" },
    tokensUsed: tokenCount(500),
    handedBack: { outcome: "handed-back" },
  };
}

/** A spec review ticket's own run that finished, but whose own hand-back was refused. */
function specReviewedNotHandedBack(number: number): IterationOutcome {
  return {
    repo: REPO,
    ticket: specReviewTicket(number),
    kind: "spec-reviewed",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "no drift found" },
    tokensUsed: tokenCount(500),
    handedBack: { outcome: "refused", reason: "the tracker was unreachable" },
  };
}

/** A spec review ticket's own run that finished on a ticket an overlapping run had already closed. */
function specReviewedAlreadyClosed(number: number): IterationOutcome {
  return {
    repo: REPO,
    ticket: specReviewTicket(number),
    kind: "spec-reviewed",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "no drift found" },
    tokensUsed: tokenCount(500),
    handedBack: { outcome: "already-closed" },
  };
}

/** A spec review ticket's own run that finished and was handed back, having filed `discoveryRouting` landing on `crossTarget`. */
function specReviewedWithDiscoveries(
  number: number,
  discoveryRouting: DiscoveryRouting,
  crossTarget?: Ticket,
): IterationOutcome {
  const specReviewed: SpecReviewed = {
    kind: "spec-reviewed",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "no drift found" },
    tokensUsed: tokenCount(500),
    handedBack: { outcome: "handed-back" },
    discoveryReport: discoveryReport(discoveryRouting, crossTarget),
  };
  return { repo: REPO, ticket: specReviewTicket(number), ...specReviewed };
}

function facts(iterations: IterationOutcome[]): SummaryFacts {
  return {
    projects: [],
    iterations,
    standDown: undefined,
    invocationFailure: undefined,
    conflictSweeps: [],
    specReviewSweeps: [],
    uniformSyncSweeps: [],
    freedFromDeadInvocation: [],
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

function discoveriesLines(iterations: IterationOutcome[]): string[] {
  return sectionLines(iterations, "## Discoveries");
}

/** A finished run that filed `discoveryRouting`, landing on `crossTarget` when given one. */
function finishedWithDiscoveries(
  number: number,
  discoveryRouting: DiscoveryRouting,
  crossTarget?: Ticket,
): IterationOutcome {
  return {
    repo: REPO,
    ticket: implementationTicket(number),
    ...finishedRun(500, "agent/900"),
    discoveryReport: discoveryReport(discoveryRouting, crossTarget),
  };
}

/** A review ticket's own run that closed cleanly, but had filed `discoveryRouting` landing on `crossTarget`. */
function reviewedWithDiscoveries(
  number: number,
  discoveryRouting: DiscoveryRouting,
  crossTarget?: Ticket,
): IterationOutcome {
  const reviewed: Reviewed = {
    kind: "reviewed",
    review: { kind: "finished", tokensUsed: tokenCount(500), output: "posted" },
    tokensUsed: tokenCount(500),
    discoveryReport: discoveryReport(discoveryRouting, crossTarget),
  };
  return { repo: REPO, ticket: reviewTicket(number), ...reviewed };
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

    assert.deepEqual(lines, [`- ${REPO}#174: relabelled ready-for-human`]);
  });

  it("still renders the review as queued when it was not worked this invocation", () => {
    const lines = waitingLines([finishedWithHandover(implementationTicket(175), 176)]);

    assert.deepEqual(lines, [`- ${REPO}: ${PULL_REQUEST} — review queued as ${REPO}#176`]);
  });

  it("still renders the review as queued when it never started this invocation: an infrastructure failure leaves it untouched", () => {
    const lines = waitingLines([
      finishedWithHandover(implementationTicket(177), 178),
      reviewInfrastructureFailure(178),
    ]);

    assert.deepEqual(lines, [
      `- ${REPO}: ${PULL_REQUEST} — review queued as ${REPO}#178`,
      `- ${REPO}#178: still ready-for-agent — the sandbox or checkout failed, so fix the setup: docker died`,
    ]);
  });

  it("drops the pull request when a worked review could not be handed back, keeping only its own still-eligible line", () => {
    const lines = waitingLines([
      finishedWithHandover(implementationTicket(179), 180),
      reviewFailedNotHandedBack(180),
    ]);

    assert.deepEqual(lines, [
      `- ${REPO}#180: still ready-for-agent — the hand-back itself failed, relabel it yourself`,
    ]);
  });

  it("still renders the pull request as queued for review when an overlapping run had already closed the review ticket", () => {
    const lines = waitingLines([
      finishedWithHandover(implementationTicket(190), 191),
      reviewFailedAlreadyClosed(191),
    ]);

    assert.deepEqual(lines, [`- ${REPO}: ${PULL_REQUEST} — review queued as ${REPO}#191`]);
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
      `- ${REPO}#182: still ready-for-agent — its findings are on ${PULL_REQUEST}, but it could not be closed: the tracker was unreachable; close it yourself`,
    ]);
  });

  it("renders both the handover's reviewed line and its own waiting line, when a reviewed iteration worked from a handover this invocation could not be labelled", () => {
    const lines = waitingLines([
      finishedWithHandover(implementationTicket(182), 183),
      reviewedButNotLabelled(183),
    ]);

    assert.deepEqual(lines, [
      `- ${REPO}: ${PULL_REQUEST} — reviewed, findings posted`,
      `- ${REPO}#183: ${PULL_REQUEST} could not be labelled reviewed: the label already existed with different case; add the label yourself`,
    ]);
  });

  it("renders both the handover's reviewed line and its own waiting line, when a turbo review's comment was refused", () => {
    const lines = waitingLines([
      finishedWithHandover(implementationTicket(185), 186),
      reviewedButNotCommented(186),
    ]);

    assert.deepEqual(lines, [
      `- ${REPO}: ${PULL_REQUEST} — reviewed, findings posted`,
      `- ${REPO}#186: ${PULL_REQUEST} could not be posted /apply-review on: the pull request is locked; comment it yourself`,
    ]);
  });

  it("renders a clean review's own handover line distinctly from one with findings", () => {
    const lines = waitingLines([
      finishedWithHandover(implementationTicket(197), 198),
      cleanReview(198),
    ]);

    assert.deepEqual(lines, [
      `- ${REPO}: ${PULL_REQUEST} — reviewed, found nothing to flag, marked ready for review`,
    ]);
  });

  it("renders both the handover's reviewed line and its own waiting line, when a clean review's ready-mark was refused", () => {
    const lines = waitingLines([
      finishedWithHandover(implementationTicket(199), 200),
      cleanReviewButNotReadied(200),
    ]);

    assert.deepEqual(lines, [
      `- ${REPO}: ${PULL_REQUEST} — reviewed, found nothing to flag`,
      `- ${REPO}#200: ${PULL_REQUEST} could not be marked ready for review: the pull request is locked; mark it ready yourself`,
    ]);
  });

  it("lists nothing for a clean review's own handover once the merge gate has merged its pull request", () => {
    const lines = waitingLines([
      finishedWithHandover(implementationTicket(205), 206),
      cleanReviewMerged(206, implementationTicket(7)),
    ]);

    assert.deepEqual(lines, []);
  });

  it("lists a clean review's own handover as left for the developer to merge, in the review's own wording rather than the handover's", () => {
    const lines = waitingLines([
      finishedWithHandover(implementationTicket(207), 208),
      cleanReviewLeftForHuman(208),
    ]);

    assert.deepEqual(lines, [
      `- ${REPO}: ${PULL_REQUEST} — left for you to merge: Pull Request is not mergeable`,
    ]);
  });

  it("lists a clean review's own handover as a merge gate read failure once, not alongside the ordinary handover line", () => {
    const lines = waitingLines([
      finishedWithHandover(implementationTicket(210), 211),
      cleanReviewTimelineUnreadable(211),
    ]);

    assert.deepEqual(lines, [
      `- ${REPO}: ${PULL_REQUEST} — merge gate could not check turboable: tracker unavailable; merge it yourself if it was turboable`,
    ]);
  });

  it("lists an applied-review iteration under waiting on you when its pull request could not be labelled, alongside its ready-for-review line", () => {
    const lines = waitingLines([appliedReviewButNotLabelled(184)]);

    assert.deepEqual(lines, [
      `- ${REPO}: ${PULL_REQUEST} — ready for review`,
      `- ${REPO}#184: ${PULL_REQUEST} could not be labelled applied-review: the repo host refused the label; add the label yourself`,
    ]);
  });

  it("tells the developer to demote the closing reference themselves under waiting on you when a still-open Blocked on: could not be taken off it", () => {
    const lines = waitingLines([appliedReviewDemoteFailed(216)]);

    assert.deepEqual(lines, [
      `- ${REPO}#216: still ready-for-agent — a still-open Blocked on: could not be taken off ${PULL_REQUEST}'s closing reference: pull request is locked; change its "Closes #900." to "Part of #900.", then mark it ready and close the ticket yourself`,
    ]);
  });

  it("lists nothing under waiting on you once the merge gate has merged an apply-review iteration's pull request", () => {
    const lines = waitingLines([appliedReviewMerged(185)]);

    assert.deepEqual(lines, []);
  });

  it("lists the ordinary ready-for-review line, not a merge gate line, for a pull request the merge gate found not eligible to merge", () => {
    const lines = waitingLines([appliedReviewNotTurboable(188)]);

    assert.deepEqual(lines, [`- ${REPO}: ${PULL_REQUEST} — ready for review`]);
  });

  it("lists an apply-review iteration under waiting on you as left for the developer to merge, once the merge gate leaves it", () => {
    const lines = waitingLines([appliedReviewLeftForHuman(186)]);

    assert.deepEqual(lines, [
      `- ${REPO}: ${PULL_REQUEST} — left for you to merge: Pull Request is not mergeable`,
    ]);
  });

  it("lists an apply-review iteration's own merge gate read failure, rather than the ordinary ready-for-review line", () => {
    const lines = waitingLines([appliedReviewTimelineUnreadable(189)]);

    assert.deepEqual(lines, [
      `- ${REPO}: ${PULL_REQUEST} — merge gate could not check turboable: tracker unavailable; merge it yourself if it was turboable`,
    ]);
  });

  it("also lists a refused ready-for-human label, alongside the merge gate's own left-for-you line", () => {
    const lines = waitingLines([appliedReviewLeftForHumanButNotLabelled(187)]);

    assert.deepEqual(lines, [
      `- ${REPO}: ${PULL_REQUEST} — left for you to merge: Pull Request is not mergeable`,
      `- ${REPO}#187: ${PULL_REQUEST} could not be labelled ready-for-human: the repo host refused the label; add the label yourself`,
    ]);
  });

  it("lists nothing under waiting on you once the merge gate has merged a clean review's pull request", () => {
    const lines = waitingLines([cleanReviewMerged(201)]);

    assert.deepEqual(lines, []);
  });

  it("lists nothing under waiting on you for a clean review's pull request the merge gate found not eligible to merge", () => {
    const lines = waitingLines([cleanReviewNotTurboable(202)]);

    assert.deepEqual(lines, []);
  });

  it("lists a clean review's own merge gate read failure, unlike a settled not-turboable verdict, which lists nothing", () => {
    const lines = waitingLines([cleanReviewTimelineUnreadable(209)]);

    assert.deepEqual(lines, [
      `- ${REPO}: ${PULL_REQUEST} — merge gate could not check turboable: tracker unavailable; merge it yourself if it was turboable`,
    ]);
  });

  it("lists a clean review iteration under waiting on you as left for the developer to merge, once the merge gate leaves it", () => {
    const lines = waitingLines([cleanReviewLeftForHuman(203)]);

    assert.deepEqual(lines, [
      `- ${REPO}: ${PULL_REQUEST} — left for you to merge: Pull Request is not mergeable`,
    ]);
  });

  it("also lists a refused ready-for-human label, alongside a clean review's own merge gate left-for-you line", () => {
    const lines = waitingLines([cleanReviewLeftForHumanButNotLabelled(204)]);

    assert.deepEqual(lines, [
      `- ${REPO}: ${PULL_REQUEST} — left for you to merge: Pull Request is not mergeable`,
      `- ${REPO}#204: ${PULL_REQUEST} could not be labelled ready-for-human: the repo host refused the label; add the label yourself`,
    ]);
  });

  describe("a blocking-discovery hand-back", () => {
    it("lists the ticket under waiting on you, worded apart from a gave-up hand-back and an infrastructure failure", () => {
      const lines = waitingLines([
        discoveryBlocked(196, routing({
          filed: [{ discovery: discovery(), action: "commented" }],
        })),
      ]);

      assert.deepEqual(lines, [
        `- ${REPO}#196: relabelled ready-for-human — the ticket is the problem, not the run: it filed a correction`,
      ]);
    });

    it("names the discovered ticket a prerequisite opened", () => {
      const lines = waitingLines([
        discoveryBlocked(197, routing({
          filed: [
            {
              discovery: discovery({ kind: "prerequisite" }),
              action: "discovered-ticket",
              ticket: implementationTicket(201),
            },
          ],
        })),
      ]);

      assert.deepEqual(lines, [
        `- ${REPO}#197: relabelled ready-for-human — the ticket is the problem, not the run: it filed a prerequisite, opened as ${REPO}#201`,
      ]);
    });

    it("says a ready prerequisite's discovered ticket skipped triage", () => {
      const lines = waitingLines([
        discoveryBlocked(198, routing({
          filed: [
            {
              discovery: discovery({ kind: "prerequisite" }),
              action: "discovered-ticket",
              ticket: { ...implementationTicket(205), readyDiscovery: true },
            },
          ],
        })),
      ]);

      assert.deepEqual(lines, [
        `- ${REPO}#198: relabelled ready-for-human — the ticket is the problem, not the run: it filed a prerequisite, opened as ${REPO}#205, ready-for-agent`,
      ]);
    });

    it("names the issue a blocked-on-existing prerequisite blocked on, when another discovery still blocked the run", () => {
      const lines = waitingLines([
        discoveryBlocked(199, routing({
          filed: [
            { discovery: discovery({ kind: "correction" }), action: "commented" },
            {
              discovery: discovery({ kind: "prerequisite", title: "Needs the widget port first" }),
              action: "blocked-on-existing",
              blocker: { repo: REPO, number: issueNumber(9) },
            },
          ],
          blocking: [discovery({ kind: "correction" })],
        })),
      ]);

      assert.deepEqual(lines, [
        `- ${REPO}#199: relabelled ready-for-human — the ticket is the problem, not the run: it filed a correction; a prerequisite, blocked on ${REPO}#9`,
      ]);
    });

    it("still lists the ticket as eligible when the hand-back itself was refused, same as any other kind", () => {
      const iteration: IterationOutcome = {
        repo: REPO,
        ticket: implementationTicket(202),
        kind: "discovery-blocked",
        discoveryReport: { routing: routing({ filed: [{ discovery: discovery(), action: "commented" }] }) },
        tokensUsed: tokenCount(500),
        handedBack: { outcome: "refused", reason: "the tracker was unreachable" },
      };

      const lines = waitingLines([iteration]);

      assert.deepEqual(lines, [
        `- ${REPO}#202: still ready-for-agent — the hand-back itself failed, relabel it yourself`,
      ]);
    });

    it("renders nothing when an overlapping run had already closed the ticket", () => {
      const iteration: IterationOutcome = {
        repo: REPO,
        ticket: implementationTicket(203),
        kind: "discovery-blocked",
        discoveryReport: { routing: routing({ filed: [{ discovery: discovery(), action: "commented" }] }) },
        tokensUsed: tokenCount(500),
        handedBack: { outcome: "already-closed" },
      };

      assert.deepEqual(waitingLines([iteration]), []);
    });
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
        `- ${REPO}#189: still ready-for-agent — the sandbox or checkout failed, so fix the setup: docker died`,
        `- ${REPO}#190: still ready-for-agent — the sandbox or checkout failed, so fix the setup: disk full`,
      ],
    );
  });

  it("relabels a finished spec review for a human, with its findings on the ticket", () => {
    const lines = waitingLines([specReviewedCleanly(194)]);

    assert.deepEqual(lines, [
      `- ${REPO}#194: relabelled ready-for-human — its findings are on the ticket`,
    ]);
  });

  it("leaves a spec review still eligible when its own hand-back was refused", () => {
    const lines = waitingLines([specReviewedNotHandedBack(195)]);

    assert.deepEqual(lines, [
      `- ${REPO}#195: still ready-for-agent — the hand-back itself failed, relabel it yourself`,
    ]);
  });

  it("renders nothing for a spec review whose ticket an overlapping run had already closed", () => {
    const lines = waitingLines([specReviewedAlreadyClosed(196)]);

    assert.deepEqual(lines, []);
  });
});

describe("discoveriesSection", () => {
  it("is absent entirely when no iteration carries any discoveries — the same summary as today", () => {
    const body = summaryBody(facts([finishedWithHandover(implementationTicket(220), 221)]), "line");

    assert.doesNotMatch(body, /## Discoveries/);
  });

  it("lists a filed clarification with the ticket it commented on", () => {
    const lines = discoveriesLines([
      finishedWithDiscoveries(
        222,
        routing({ filed: [{ discovery: discovery({ kind: "clarification" }), action: "commented" }] }),
      ),
    ]);

    assert.deepEqual(lines, [
      `- ${REPO}#222: commented on ${REPO}#222 — clarification, "The ticket names the wrong file"`,
    ]);
  });

  it("lists a filed suggestion with the discovered ticket it opened", () => {
    const lines = discoveriesLines([
      finishedWithDiscoveries(
        223,
        routing({
          filed: [
            {
              discovery: discovery({ kind: "suggestion", title: "Worth a retry" }),
              action: "discovered-ticket",
              ticket: implementationTicket(230),
            },
          ],
        }),
      ),
    ]);

    assert.deepEqual(lines, [`- ${REPO}#223: opened ${REPO}#230 — suggestion, "Worth a retry"`]);
  });

  it("says a discovered ticket born ready skipped triage", () => {
    const lines = discoveriesLines([
      finishedWithDiscoveries(
        225,
        routing({
          filed: [
            {
              discovery: discovery({ kind: "suggestion", title: "Worth a retry" }),
              action: "discovered-ticket",
              ticket: { ...implementationTicket(231), readyDiscovery: true },
            },
          ],
        }),
      ),
    ]);

    assert.deepEqual(lines, [
      `- ${REPO}#225: opened ${REPO}#231, ready-for-agent — suggestion, "Worth a retry"`,
    ]);
  });

  it("names the implementation ticket a review's discovery landed on, not the review ticket itself", () => {
    const lines = discoveriesLines([
      reviewedWithDiscoveries(
        224,
        routing({ filed: [{ discovery: discovery({ kind: "clarification" }), action: "commented" }] }),
        implementationTicket(7),
      ),
    ]);

    assert.deepEqual(lines, [
      `- ${REPO}#224: commented on ${REPO}#7 — clarification, "The ticket names the wrong file"`,
    ]);
  });

  it("names the supertask a spec review's discovery landed on, not the spec review ticket itself", () => {
    const lines = discoveriesLines([
      specReviewedWithDiscoveries(
        232,
        routing({ filed: [{ discovery: discovery({ kind: "clarification" }), action: "commented" }] }),
        implementationTicket(50),
      ),
    ]);

    assert.deepEqual(lines, [
      `- ${REPO}#232: commented on ${REPO}#50 — clarification, "The ticket names the wrong file"`,
    ]);
  });

  it("omits a blocking discovery from a discovery-blocked iteration's own list — that is said by its own line and waiting entry", () => {
    const lines = discoveriesLines([
      discoveryBlocked(225, routing({ filed: [{ discovery: discovery({ kind: "correction" }), action: "commented" }] })),
    ]);

    assert.deepEqual(lines, []);
  });

  it("lists a prerequisite blocked on an existing issue, naming the issue it blocked on", () => {
    const blocker = { repo: REPO, number: issueNumber(9) };
    const lines = discoveriesLines([
      finishedWithDiscoveries(
        233,
        routing({
          filed: [
            {
              discovery: discovery({ kind: "prerequisite", title: "Needs the widget port first" }),
              action: "blocked-on-existing",
              blocker,
            },
          ],
        }),
      ),
    ]);

    assert.deepEqual(lines, [
      `- ${REPO}#233: blocked ${REPO}#233 on ${REPO}#9 — prerequisite, "Needs the widget port first"`,
    ]);
  });

  it("lists an advisory discovery filed by a cut-off run, same as a finished run's", () => {
    const lines = discoveriesLines([
      limitRefusedWithDiscoveries(
        226,
        routing({ filed: [{ discovery: discovery({ kind: "clarification" }), action: "commented" }] }),
      ),
    ]);

    assert.deepEqual(lines, [
      `- ${REPO}#226: commented on ${REPO}#226 — clarification, "The ticket names the wrong file"`,
    ]);
  });

  it("counts the suggestions the cap dropped", () => {
    const lines = discoveriesLines([
      finishedWithDiscoveries(226, routing({ suggestionsDropped: 2 })),
    ]);

    assert.deepEqual(lines, [
      `- ${REPO}#226: dropped 2 suggestions past the one already filed`,
    ]);
  });

  it("counts a single dropped suggestion in the singular", () => {
    const lines = discoveriesLines([
      finishedWithDiscoveries(227, routing({ suggestionsDropped: 1 })),
    ]);

    assert.deepEqual(lines, [
      `- ${REPO}#227: dropped 1 suggestion past the one already filed`,
    ]);
  });

  it("counts the files /discoveries dropped for being malformed", () => {
    const lines = discoveriesLines([
      finishedWithDiscoveries(228, routing({ discoveriesDropped: 3 })),
    ]);

    assert.deepEqual(lines, [
      `- ${REPO}#228: dropped 3 files under /discoveries — not valid JSON, or naming an unknown kind`,
    ]);
  });

  it("names a refused discovery, blocking or advisory alike, with why", () => {
    const lines = discoveriesLines([
      finishedWithDiscoveries(
        229,
        routing({
          refused: [
            { discovery: discovery({ kind: "clarification" }), reason: "the tracker was unreachable" },
          ],
        }),
      ),
    ]);

    assert.deepEqual(lines, [
      `- ${REPO}#229: could not file a clarification ("The ticket names the wrong file"): the tracker was unreachable`,
    ]);
  });

  it("lists a discovery-blocked run's own advisory discovery alongside its blocking one", () => {
    const lines = discoveriesLines([
      discoveryBlocked(
        231,
        routing({
          filed: [
            { discovery: discovery({ kind: "prerequisite" }), action: "discovered-ticket", ticket: implementationTicket(240) },
            { discovery: discovery({ kind: "suggestion", title: "Worth a retry" }), action: "discovered-ticket", ticket: implementationTicket(241) },
          ],
        }),
      ),
    ]);

    assert.deepEqual(lines, [`- ${REPO}#231: opened ${REPO}#241 — suggestion, "Worth a retry"`]);
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

  it("names a spec review's own ticket, since its findings are on the ticket rather than a pull request", () => {
    const lines = attemptsLines([specReviewedCleanly(307)]);

    assert.match(lines[0] ?? "", new RegExp(`Spec-reviewed ${REPO}#307: its findings are on the ticket\\.`));
  });

  it("names the issue a run kept ready-for-agent by blocking on it directly", () => {
    const lines = attemptsLines([
      blockedOnExisting(
        308,
        routing({
          filed: [
            {
              discovery: discovery({ kind: "prerequisite", title: "Needs the widget port first" }),
              action: "blocked-on-existing",
              blocker: { repo: REPO, number: issueNumber(9) },
            },
          ],
        }),
      ),
    ]);

    assert.match(
      lines[0] ?? "",
      new RegExp(`Worked ${REPO}#308: kept ready-for-agent — blocked on ${REPO}#9 until it closes\\.`),
    );
  });

  it("says its branch could not be discarded, when git refused", () => {
    const lines = attemptsLines([
      blockedOnExisting(
        309,
        routing({
          filed: [
            {
              discovery: discovery({ kind: "prerequisite" }),
              action: "blocked-on-existing",
              blocker: { repo: REPO, number: issueNumber(9) },
            },
          ],
        }),
        { kind: "kept", reason: "not fully merged" },
      ),
    ]);

    assert.match(lines[0] ?? "", /Its branch agent\/900 could not be discarded: not fully merged\./);
  });
});

describe("a ticket handed back for an unusable size label", () => {
  const FAILURE: UnusableSizeLabel = { kind: "unusable-size-label", labels: ["size:XXL"] };

  function unusableSizeLabel(number: number): IterationOutcome {
    return {
      repo: REPO,
      ticket: implementationTicket(number),
      kind: "failed",
      failure: FAILURE,
      handedBack: { outcome: "handed-back" },
    };
  }

  it("says the ticket was not run and why, in the one-line summary", () => {
    const line = summaryLine(facts([unusableSizeLabel(306)]));

    assert.match(
      line,
      /#306 was not run, because its size label names no size the budget document knows \(`size:XXL`\)\. Handed back for a human\./,
    );
  });

  it("reads the same wording sizeProblem gives — the one source hand-back.ts's own comment reads too", () => {
    const { problem, fix } = sizeProblem(FAILURE);

    assert.deepEqual(waitingLines([unusableSizeLabel(307)]), [
      `- ${REPO}#307: relabelled ready-for-human — ${problem}, so ${fix}`,
    ]);
  });
});

describe("a ticket handed back for touching a uniform file", () => {
  const FAILURE: UniformFilesTouched = {
    kind: "uniform-files-touched",
    files: ["docs/agents/coding-standards.md"],
  };

  function uniformFilesTouched(number: number): IterationOutcome {
    return {
      repo: REPO,
      ticket: implementationTicket(number),
      kind: "failed",
      failure: FAILURE,
      handedBack: { outcome: "handed-back" },
    };
  }

  it("says it finished but opened no pull request, and why, in the one-line summary", () => {
    const line = summaryLine(facts([uniformFilesTouched(306)]));

    assert.match(
      line,
      /#306 finished, but its diff touched docs\/agents\/coding-standards\.md, which the manager keeps uniform across every project, so no pull request was opened\. Handed back for a human\./,
    );
  });

  it("names the files touched in the waiting-on-you line", () => {
    assert.deepEqual(waitingLines([uniformFilesTouched(307)]), [
      `- ${REPO}#307: relabelled ready-for-human — its diff touched docs/agents/coding-standards.md, which the manager keeps uniform across every project, so no pull request was opened`,
    ]);
  });
});

describe("a ticket handed back for a model problem", () => {
  function conflictingModelLabels(number: number): {
    iteration: IterationOutcome;
    ticket: Ticket;
    failure: UnusableModelLabel;
  } {
    const ticket = implementationTicket(number);
    const failure: UnusableModelLabel = {
      kind: "conflicting-model-labels",
      labels: ["model:opus", "model:haiku"],
    };
    return {
      ticket,
      failure,
      iteration: {
        repo: REPO,
        ticket,
        kind: "failed",
        failure,
        handedBack: { outcome: "handed-back" },
      },
    };
  }

  function unusableModelLabel(number: number): {
    iteration: IterationOutcome;
    ticket: Ticket;
    failure: UnusableModelLabel;
  } {
    const ticket = implementationTicket(number);
    const failure: UnusableModelLabel = { kind: "unusable-model-label", labels: ["model:"] };
    return {
      ticket,
      failure,
      iteration: {
        repo: REPO,
        ticket,
        kind: "failed",
        failure,
        handedBack: { outcome: "handed-back" },
      },
    };
  }

  function modelRefused(number: number): {
    iteration: IterationOutcome;
    ticket: Ticket;
    failure: ModelRefused;
  } {
    const ticket = implementationTicket(number);
    const failure: ModelRefused = {
      kind: "model-refused",
      refusal: { model: modelName("opus"), words: "unknown model opus" },
      source: "model label",
    };
    return {
      ticket,
      failure,
      iteration: {
        repo: REPO,
        ticket,
        kind: "failed",
        failure,
        handedBack: { outcome: "handed-back" },
      },
    };
  }

  it("reads the same wording modelProblem gives for conflicting model labels — the one source hand-back.ts's own comment reads too", () => {
    const { iteration, ticket, failure } = conflictingModelLabels(308);
    const { problem, fix } = modelProblem(ticket, failure);

    assert.deepEqual(waitingLines([iteration]), [
      `- ${REPO}#308: relabelled ready-for-human — ${problem}, so ${fix}`,
    ]);
  });

  it("reads the same wording modelProblem gives for an unusable model label — the one source hand-back.ts's own comment reads too", () => {
    const { iteration, ticket, failure } = unusableModelLabel(310);
    const { problem, fix } = modelProblem(ticket, failure);

    assert.deepEqual(waitingLines([iteration]), [
      `- ${REPO}#310: relabelled ready-for-human — ${problem}, so ${fix}`,
    ]);
  });

  it("reads the same wording modelProblem gives for a model refusal — the one source hand-back.ts's own comment reads too", () => {
    const { iteration, ticket, failure } = modelRefused(309);
    const { problem, fix } = modelProblem(ticket, failure);

    assert.deepEqual(waitingLines([iteration]), [
      `- ${REPO}#309: relabelled ready-for-human — ${problem}, so ${fix}`,
    ]);
  });
});

describe("summaryLine", () => {
  it("reads a reviewed iteration exactly as today when notLabelled is absent", () => {
    const line = summaryLine(facts([reviewedCleanly(210)]));

    assert.equal(line, `Reviewed ${REPO}#210: posted findings on ${PULL_REQUEST}.`);
  });

  it("names the pull request, the reviewed label and the error when a reviewed iteration could not be labelled", () => {
    const line = summaryLine(facts([reviewedButNotLabelled(211)]));

    assert.equal(
      line,
      `Reviewed ${REPO}#211: posted findings on ${PULL_REQUEST}. ${PULL_REQUEST} could not be labelled reviewed: the label already existed with different case; add the label yourself.`,
    );
  });

  it("names the pull request and the error when a turbo review's comment was refused", () => {
    const line = summaryLine(facts([reviewedButNotCommented(214)]));

    assert.equal(
      line,
      `Reviewed ${REPO}#214: posted findings on ${PULL_REQUEST}. ${PULL_REQUEST} could not be posted /apply-review on: the pull request is locked; comment it yourself.`,
    );
  });

  it("reads a clean review distinctly from one with findings", () => {
    const line = summaryLine(facts([cleanReview(215)]));

    assert.equal(
      line,
      `Reviewed ${REPO}#215: found nothing to flag on ${PULL_REQUEST}, now ready for review.`,
    );
  });

  it("names the pull request and the error when a clean review's ready-mark was refused", () => {
    const line = summaryLine(facts([cleanReviewButNotReadied(216)]));

    assert.equal(
      line,
      `Reviewed ${REPO}#216: found nothing to flag on ${PULL_REQUEST}. ${PULL_REQUEST} could not be marked ready for review: the pull request is locked; mark it ready yourself.`,
    );
  });

  it("names the merge gate's own reason for a clean review's pull request the merge gate found not eligible to merge", () => {
    const line = summaryLine(facts([cleanReviewNotTurboable(220)]));

    assert.equal(
      line,
      `Reviewed ${REPO}#220: found nothing to flag on ${PULL_REQUEST}, now ready for review. Not merged: not turboable before its own run started.`,
    );
  });

  it("names the run-span reason, not the timeline one, for a clean review's pull request the merge gate declined over a run span", () => {
    const line = summaryLine(facts([cleanReviewNotTurboableInsideSpan(225)]));

    assert.equal(
      line,
      `Reviewed ${REPO}#225: found nothing to flag on ${PULL_REQUEST}, now ready for review. Not merged: turboable granted inside a run span.`,
    );
  });

  it("reads a clean review's pull request exactly as an ordinary ready-for-review when its implementation ticket never carried turboable at all", () => {
    const line = summaryLine(facts([cleanReviewNeverLabelledTurboable(226)]));

    assert.equal(
      line,
      `Reviewed ${REPO}#226: found nothing to flag on ${PULL_REQUEST}, now ready for review.`,
    );
  });

  it("says the merge gate could not check turboable for a clean review whose timeline read failed, rather than reading silently as ready for review", () => {
    const line = summaryLine(facts([cleanReviewTimelineUnreadable(224)]));

    assert.equal(
      line,
      `Reviewed ${REPO}#224: found nothing to flag on ${PULL_REQUEST}, now ready for review. Merge gate could not check turboable: tracker unavailable; merge it yourself if it was turboable.`,
    );
  });

  it("names the merged pull request's implementation ticket, its branch deleted, rather than ready for review, for a clean review", () => {
    const line = summaryLine(facts([cleanReviewMerged(221, implementationTicket(7))]));

    assert.equal(
      line,
      `Reviewed ${REPO}#221: found nothing to flag on ${PULL_REQUEST}, merged, closing ${REPO}#7, its branch deleted.`,
    );
  });

  it("names the merge gate's own reason once it leaves a clean review's pull request for the developer to merge", () => {
    const line = summaryLine(facts([cleanReviewLeftForHuman(222)]));

    assert.equal(
      line,
      `Reviewed ${REPO}#222: found nothing to flag on ${PULL_REQUEST}, now ready for review. Left for you to merge: Pull Request is not mergeable.`,
    );
  });

  it("also names a refused ready-for-human label, after a clean review's own merge gate left-for-you sentence", () => {
    const line = summaryLine(facts([cleanReviewLeftForHumanButNotLabelled(223)]));

    assert.equal(
      line,
      `Reviewed ${REPO}#223: found nothing to flag on ${PULL_REQUEST}, now ready for review. Left for you to merge: Pull Request is not mergeable. ${PULL_REQUEST} could not be labelled ready-for-human: the repo host refused the label; add the label yourself.`,
    );
  });

  it("reads an applied-review iteration exactly as today when notLabelled is absent", () => {
    const line = summaryLine(facts([appliedReviewCleanly(212)]));

    assert.equal(
      line,
      `Applied review on ${REPO}#212: 2 applied, 1 declined on ${PULL_REQUEST}, now ready for review.`,
    );
  });

  it("names the pull request, the applied-review label and the error when an applied-review iteration could not be labelled", () => {
    const line = summaryLine(facts([appliedReviewButNotLabelled(213)]));

    assert.equal(
      line,
      `Applied review on ${REPO}#213: 2 applied, 1 declined on ${PULL_REQUEST}, now ready for review. ${PULL_REQUEST} could not be labelled applied-review: the repo host refused the label; add the label yourself.`,
    );
  });

  it("names the implementation ticket a still-open Blocked on: demoted the pull request's closing reference for", () => {
    const line = summaryLine(facts([appliedReviewDemoted(214, implementationTicket(900))]));

    assert.equal(
      line,
      `Applied review on ${REPO}#214: 0 applied, 1 declined on ${PULL_REQUEST}, now ready for review. ${PULL_REQUEST} no longer closes ${REPO}#900: a still-open \`Blocked on:\` demoted its \`Closes\` line to \`Part of\`.`,
    );
  });

  it("tells the developer to demote the closing reference themselves when a still-open Blocked on: could not be taken off it", () => {
    const line = summaryLine(facts([appliedReviewDemoteFailed(215)]));

    assert.equal(
      line,
      `Applied review on ${REPO}#215: 0 applied, 1 declined on ${PULL_REQUEST}, but a still-open Blocked on: could not be taken off ${PULL_REQUEST}'s closing reference: pull request is locked. Still ready-for-agent, and ${PULL_REQUEST} still a draft: change its "Closes #900." to "Part of #900.", then mark it ready and close the ticket yourself.`,
    );
  });

  it("names the merge gate's own reason for an apply-review iteration's pull request the merge gate found not eligible to merge", () => {
    const line = summaryLine(facts([appliedReviewNotTurboable(216)]));

    assert.equal(
      line,
      `Applied review on ${REPO}#216: 2 applied, 1 declined on ${PULL_REQUEST}, now ready for review. Not merged: not turboable before its own run started.`,
    );
  });

  it("names the run-span reason, not the timeline one, for an apply-review iteration's pull request the merge gate declined over a run span", () => {
    const line = summaryLine(facts([appliedReviewNotTurboableInsideSpan(227)]));

    assert.equal(
      line,
      `Applied review on ${REPO}#227: 2 applied, 1 declined on ${PULL_REQUEST}, now ready for review. Not merged: turboable granted inside a run span.`,
    );
  });

  it("reads an apply-review iteration's pull request exactly as an ordinary ready-for-review when its implementation ticket never carried turboable at all", () => {
    const line = summaryLine(facts([appliedReviewNeverLabelledTurboable(228)]));

    assert.equal(
      line,
      `Applied review on ${REPO}#228: 2 applied, 1 declined on ${PULL_REQUEST}, now ready for review.`,
    );
  });

  it("says the merge gate could not check turboable for an apply-review iteration whose timeline read failed, rather than reading silently as ready for review", () => {
    const line = summaryLine(facts([appliedReviewTimelineUnreadable(220)]));

    assert.equal(
      line,
      `Applied review on ${REPO}#220: 2 applied, 0 declined on ${PULL_REQUEST}, now ready for review. Merge gate could not check turboable: tracker unavailable; merge it yourself if it was turboable.`,
    );
  });

  it("names the merged pull request's implementation ticket, its branch deleted, rather than ready for review", () => {
    const line = summaryLine(facts([appliedReviewMerged(217, implementationTicket(7))]));

    assert.equal(
      line,
      `Applied review on ${REPO}#217: 2 applied, 0 declined on ${PULL_REQUEST}, merged, closing ${REPO}#7, its branch deleted.`,
    );
  });

  it("names the merge gate's own reason once it leaves the pull request for the developer to merge", () => {
    const line = summaryLine(facts([appliedReviewLeftForHuman(218)]));

    assert.equal(
      line,
      `Applied review on ${REPO}#218: 2 applied, 0 declined on ${PULL_REQUEST}, now ready for review. Left for you to merge: Pull Request is not mergeable.`,
    );
  });

  it("also names a refused ready-for-human label, after the merge gate's own left-for-you sentence", () => {
    const line = summaryLine(facts([appliedReviewLeftForHumanButNotLabelled(219)]));

    assert.equal(
      line,
      `Applied review on ${REPO}#219: 2 applied, 0 declined on ${PULL_REQUEST}, now ready for review. Left for you to merge: Pull Request is not mergeable. ${PULL_REQUEST} could not be labelled ready-for-human: the repo host refused the label; add the label yourself.`,
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

    assert.match(line, /the sandbox failed on nadav-alon\/pilot#183 after the agent had already run/);
  });

  it("says the run would not start when the infrastructure failure carries no spend", () => {
    const iteration: IterationOutcome = {
      repo: REPO,
      ticket: implementationTicket(184),
      kind: "failed",
      failure: { kind: "infrastructure", reason: "docker died" },
    };

    const line = summaryLine(facts([iteration]));

    assert.match(line, /the run would not start on nadav-alon\/pilot#184/);
  });

  describe("a blocking-discovery hand-back", () => {
    it("reads apart from a gave-up hand-back and an infrastructure failure", () => {
      const line = summaryLine(facts([discoveryBlocked(190, routing({
        filed: [{ discovery: discovery(), action: "commented" }],
      }))]));

      assert.match(line, /the ticket is the problem, not the run/);
      assert.doesNotMatch(line, /the agent gave up/);
      assert.doesNotMatch(line, /the sandbox or checkout failed/);
    });

    it("names the correction", () => {
      const line = summaryLine(facts([discoveryBlocked(191, routing({
        filed: [{ discovery: discovery({ kind: "correction" }), action: "commented" }],
      }))]));

      assert.match(line, /a correction/);
    });

    it("names the discovered ticket a filed prerequisite opened", () => {
      const line = summaryLine(facts([discoveryBlocked(192, routing({
        filed: [
          {
            discovery: discovery({ kind: "prerequisite", title: "Needs the widget port first" }),
            action: "discovered-ticket",
            ticket: implementationTicket(199),
          },
        ],
      }))]));

      assert.match(line, /a prerequisite, opened as nadav-alon\/pilot#199/);
      assert.doesNotMatch(line, /#199, ready-for-agent/);
    });

    it("says a ready prerequisite's discovered ticket skipped triage", () => {
      const line = summaryLine(facts([discoveryBlocked(200, routing({
        filed: [
          {
            discovery: discovery({ kind: "prerequisite", title: "Needs the widget port first" }),
            action: "discovered-ticket",
            ticket: { ...implementationTicket(206), readyDiscovery: true },
          },
        ],
      }))]));

      assert.match(line, /a prerequisite, opened as nadav-alon\/pilot#206, ready-for-agent/);
    });

    it("names a refused blocking discovery by its kind and why, naming no ticket", () => {
      const line = summaryLine(facts([discoveryBlocked(193, routing({
        refused: [
          {
            discovery: discovery({ kind: "prerequisite" }),
            reason: "the tracker was unreachable",
          },
        ],
      }))]));

      assert.match(line, /a prerequisite that could not be filed: the tracker was unreachable/);
    });

    it("joins more than one blocking discovery", () => {
      const line = summaryLine(facts([discoveryBlocked(194, routing({
        filed: [
          { discovery: discovery({ kind: "correction" }), action: "commented" },
          {
            discovery: discovery({ kind: "prerequisite" }),
            action: "discovered-ticket",
            ticket: implementationTicket(198),
          },
        ],
      }))]));

      assert.match(line, /a correction; a prerequisite, opened as nadav-alon\/pilot#198/);
      assert.doesNotMatch(line, /#198, ready-for-agent/);
    });
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
        estimateCharged: tokenCount(200_000),
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
        specReviewSweeps: [],
        uniformSyncSweeps: [],
        freedFromDeadInvocation: [],
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
          // charged (still 200,000, from the default) pushes it over.
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
        /200,000 tokens charged as the run estimate/,
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
        /200,000 tokens charged as the run estimate/,
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
      specReviewSweeps: [],
      uniformSyncSweeps: [],
      freedFromDeadInvocation: [],
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
      specReviewSweeps: [],
      uniformSyncSweeps: [],
      freedFromDeadInvocation: [],
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
        limitRefused(220, { kind: "salvaged", branch: branch("issue-220"), stopShorts: 1 }),
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
      `The provider limit refused the run on ${REPO}#221.`,
    );
  });

  it("names a salvaged infrastructure failure's branch and says the next run will continue on it", () => {
    const line = summaryLine(
      facts([
        infrastructureFailure(222, { branch: branch("issue-222"), stopShorts: 1 }),
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

  it("adds no repeated-stop-short warning at one limit refusal in a row", () => {
    const line = summaryLine(
      facts([
        limitRefused(224, { kind: "salvaged", branch: branch("issue-224"), stopShorts: 1 }),
      ]),
    );

    assert.doesNotMatch(line, /stopped short/);
  });

  it("warns that a ticket has been stopped short repeatedly at two or more limit refusals in a row", () => {
    const line = summaryLine(
      facts([
        limitRefused(225, { kind: "salvaged", branch: branch("issue-225"), stopShorts: 3 }),
      ]),
    );

    assert.match(
      line,
      /This ticket has been stopped short 3 times in a row: consider splitting it or giving it a larger size or model\./,
    );
  });

  it("adds no repeated-stop-short warning on an infrastructure failure, whatever count its salvage carries over from an earlier limit refusal", () => {
    const line = summaryLine(
      facts([infrastructureFailure(226, { branch: branch("issue-226"), stopShorts: 2 })]),
    );

    assert.doesNotMatch(line, /stopped short/);
  });

  it("lists a limit-refused ticket under waiting on you once it has been stopped short two or more times in a row", () => {
    const lines = waitingLines([
      limitRefused(227, { kind: "salvaged", branch: branch("issue-227"), stopShorts: 2 }),
    ]);

    assert.deepEqual(lines, [
      `- ${REPO}#227: stopped short 2 times in a row — consider splitting it or giving it a larger size or model`,
    ]);
  });

  it("does not list a limit-refused ticket under waiting on you at one refusal", () => {
    const lines = waitingLines([
      limitRefused(228, { kind: "salvaged", branch: branch("issue-228"), stopShorts: 1 }),
    ]);

    assert.deepEqual(lines, []);
  });

  it("names a salvaged budget exhaustion's branch and says the next run will continue on it", () => {
    const line = summaryLine(
      facts([
        budgetExhausted(229, { kind: "salvaged", branch: branch("issue-229"), stopShorts: 1 }),
      ]),
    );

    assert.match(
      line,
      /Its branch issue-229 was salvaged: the ticket's next run will continue on it\./,
    );
  });

  it("reads a budget exhaustion exactly as today when nothing was salvaged, quoting the CLI's own words", () => {
    const line = summaryLine(facts([budgetExhausted(230, { kind: "none" })]));

    assert.equal(
      line,
      `The run on ${REPO}#230 was stopped by its spend ceiling: ${BUDGET_EXHAUSTED_JSON_RESULT}.`,
    );
  });

  it("warns that a ticket has been stopped short repeatedly at two or more budget exhaustions in a row", () => {
    const line = summaryLine(
      facts([
        budgetExhausted(231, { kind: "salvaged", branch: branch("issue-231"), stopShorts: 2 }),
      ]),
    );

    assert.match(
      line,
      /This ticket has been stopped short 2 times in a row: consider splitting it or giving it a larger size or model\./,
    );
  });

  it("lists a budget-exhausted ticket under waiting on you once it has been stopped short two or more times in a row", () => {
    const lines = waitingLines([
      budgetExhausted(232, { kind: "salvaged", branch: branch("issue-232"), stopShorts: 2 }),
    ]);

    assert.deepEqual(lines, [
      `- ${REPO}#232: stopped short 2 times in a row — consider splitting it or giving it a larger size or model`,
    ]);
  });

  it("does not list a budget-exhausted ticket under waiting on you at one exhaustion", () => {
    const lines = waitingLines([
      budgetExhausted(233, { kind: "salvaged", branch: branch("issue-233"), stopShorts: 1 }),
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

  /** The body {@link factsWithSweeps} renders for `sweeps`, line and all. */
  function bodyOf(sweeps: ConflictSweepOutcome[]): string {
    return summaryBody(factsWithSweeps(sweeps), summaryLine(factsWithSweeps(sweeps)));
  }

  /** How many of `section`'s lines are exactly `bullet`. */
  function bulletCount(section: string, bullet: string): number {
    return section.split("\n").filter((line) => line === bullet).length;
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

    const body = bodyOf(sweeps);
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

    const body = bodyOf(sweeps);

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

    const body = bodyOf(sweeps);

    const matches = body.match(/could not label/g) ?? [];
    assert.equal(matches.length, 1);
    assert.match(
      body,
      new RegExp(`- ${REPO}: could not label ${PULL_REQUEST} needs-rebase: label does not exist`),
    );
  });

  it("reports a refusal once even when the error text differs between sweeps", () => {
    const sweeps: ConflictSweepOutcome[] = [
      {
        repo: REPO,
        changes: [],
        refusals: [
          { action: "comment", pullRequest: PULL_REQUEST, error: "502 Bad Gateway (request id: 1abc)" },
        ],
      },
      {
        repo: REPO,
        changes: [],
        refusals: [
          { action: "comment", pullRequest: PULL_REQUEST, error: "502 Bad Gateway (request id: 2abc)" },
        ],
      },
    ];

    const body = bodyOf(sweeps);

    const matches = body.match(/could not post/g) ?? [];
    assert.equal(matches.length, 1);
  });

  it("names the project, not a pull request, for a refused listing", () => {
    const sweeps: ConflictSweepOutcome[] = [
      { repo: REPO, changes: [], refusals: [{ action: "list", error: "listing refused" }] },
    ];

    const body = bodyOf(sweeps);

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

    assert.match(
      summaryLine(commented),
      new RegExp(`Conflict sweep: ${REPO} \\(posted /rebase once\\)`),
    );
  });

  it("names a count, not every url, when a sweep posted /rebase on several pull requests", () => {
    const commented = factsWithSweeps([
      {
        repo: REPO,
        changes: [
          { pullRequest: PULL_REQUEST, action: "commented" },
          { pullRequest: OTHER_REPO_PULL_REQUEST, action: "commented" },
        ],
        refusals: [],
      },
    ]);

    const line = summaryLine(commented);
    assert.match(line, new RegExp(`Conflict sweep: ${REPO} \\(posted /rebase 2 times\\)`));
    assert.doesNotMatch(line, new RegExp(PULL_REQUEST));
  });

  it("gives two distinct /rebase posts on the same pull request their own bullet each, rather than collapsing the second away", () => {
    const sweeps: ConflictSweepOutcome[] = [
      { repo: REPO, changes: [{ pullRequest: PULL_REQUEST, action: "commented" }], refusals: [] },
      { repo: REPO, changes: [{ pullRequest: PULL_REQUEST, action: "commented" }], refusals: [] },
    ];

    const body = bodyOf(sweeps);
    const section = body.slice(body.indexOf("## Conflict sweeps"));

    assert.equal(bulletCount(section, `- ${REPO}: posted /rebase on ${PULL_REQUEST}`), 2);
  });

  it("reports a label met by two scans once, but each of their /rebase posts on its own", () => {
    const sweeps: ConflictSweepOutcome[] = [
      {
        repo: REPO,
        changes: [
          { pullRequest: PULL_REQUEST, action: "labelled" },
          { pullRequest: PULL_REQUEST, action: "commented" },
        ],
        refusals: [],
      },
      {
        repo: REPO,
        changes: [
          { pullRequest: PULL_REQUEST, action: "labelled" },
          { pullRequest: PULL_REQUEST, action: "commented" },
        ],
        refusals: [],
      },
    ];

    const body = bodyOf(sweeps);
    const section = body.slice(body.indexOf("## Conflict sweeps"));

    assert.equal(bulletCount(section, `- ${REPO}: labelled needs-rebase on ${PULL_REQUEST}`), 1);
    assert.equal(bulletCount(section, `- ${REPO}: posted /rebase on ${PULL_REQUEST}`), 2);
  });

  it("counts both posts, not one, in the summary line's aside when the same pull request is posted on twice", () => {
    const commented = factsWithSweeps([
      { repo: REPO, changes: [{ pullRequest: PULL_REQUEST, action: "commented" }], refusals: [] },
      { repo: REPO, changes: [{ pullRequest: PULL_REQUEST, action: "commented" }], refusals: [] },
    ]);

    assert.match(
      summaryLine(commented),
      new RegExp(`Conflict sweep: ${REPO} \\(posted /rebase 2 times\\)`),
    );
  });

  it("mentions the sweep in the summary line when it was refused something", () => {
    const refused = factsWithSweeps([
      {
        repo: REPO,
        changes: [],
        refusals: [{ action: "read", pullRequest: PULL_REQUEST, error: "mergeability refused" }],
      },
    ]);

    assert.match(summaryLine(refused), new RegExp(`Conflict sweep: ${REPO} \\(refused once\\)`));
  });

  it("names a pull request whose mergeability never settled", () => {
    const sweeps: ConflictSweepOutcome[] = [
      {
        repo: REPO,
        changes: [],
        refusals: [
          {
            action: "unsettled",
            pullRequest: PULL_REQUEST,
            error: "mergeability still unknown after 3 reads",
          },
        ],
      },
    ];

    const body = bodyOf(sweeps);
    const section = body.slice(body.indexOf("## Conflict sweeps"));

    assert.match(summaryLine(factsWithSweeps(sweeps)), new RegExp(`Conflict sweep: ${REPO}`));
    assert.match(section, /still unknown after 3 reads/);
  });

  it("names a thrown read and an unsettled one of the same pull request apart", () => {
    const sweeps: ConflictSweepOutcome[] = [
      {
        repo: REPO,
        changes: [],
        refusals: [{ action: "read", pullRequest: PULL_REQUEST, error: "mergeability refused" }],
      },
      {
        repo: REPO,
        changes: [],
        refusals: [
          { action: "unsettled", pullRequest: PULL_REQUEST, error: "mergeability still unknown after 3 reads" },
        ],
      },
    ];

    const body = bodyOf(sweeps);

    assert.match(body, /mergeability refused/);
    assert.match(body, /still unknown after 3 reads/);
  });
});

describe("spec review sweeps", () => {
  const OTHER_REPO = repoSlug("nadav-alon/other");

  function specReview(supertaskNumber: number, number: number): Ticket {
    return {
      repo: REPO,
      number: issueNumber(number),
      title: `Spec review for #${supertaskNumber}`,
      specReview: true,
    };
  }

  /**
   * Facts naming a `no-eligible-tickets` project for every repo
   * `specReviewSweeps` names, the same way `factsWithSweeps` does for a
   * conflict sweep.
   */
  function factsWithSpecReviewSweeps(
    specReviewSweeps: SpecReviewSweepOutcome[],
  ): SummaryFacts {
    const repos = [...new Set(specReviewSweeps.map((sweep) => sweep.repo))];
    return {
      ...facts([]),
      projects: repos.map((repo) => ({ repo, verdict: "no-eligible-tickets" as const })),
      specReviewSweeps,
    };
  }

  function bodyOf(sweeps: SpecReviewSweepOutcome[]): string {
    const built = factsWithSpecReviewSweeps(sweeps);
    return summaryBody(built, summaryLine(built));
  }

  it("renders nothing extra, byte for byte, when no sweep opened, linked or refused anything", () => {
    const projects = [{ repo: REPO, verdict: "no-eligible-tickets" as const }];
    const withoutSweeps: SummaryFacts = { ...facts([]), projects };
    const withEmptySweeps: SummaryFacts = {
      ...facts([]),
      projects,
      specReviewSweeps: [{ repo: REPO, opened: [], linked: [], refusals: [] }],
    };

    const line = summaryLine(withoutSweeps);
    assert.equal(summaryLine(withEmptySweeps), line);
    assert.equal(
      summaryBody(withEmptySweeps, summaryLine(withEmptySweeps)),
      summaryBody(withoutSweeps, line),
    );
    assert.doesNotMatch(line, /Spec review sweep/);
  });

  it("names the spec review it opened and the supertask it reviews, in the body", () => {
    const sweeps: SpecReviewSweepOutcome[] = [
      { repo: REPO, opened: [specReview(40, 68)], linked: [], refusals: [] },
      { repo: OTHER_REPO, opened: [specReview(10, 20)], linked: [], refusals: [] },
    ];

    const body = bodyOf(sweeps);
    const section = body.slice(body.indexOf("## Spec review sweep"));

    assert.match(section, new RegExp(`- ${REPO}: opened ${REPO}#68 \\(Spec review for #40\\)`));
    assert.match(section, new RegExp(`- ${OTHER_REPO}: opened ${OTHER_REPO}#20 \\(Spec review for #10\\)`));
  });

  it("names the supertask and the error for an open refusal, in the body", () => {
    const supertask = implementationTicket(40);
    const sweeps: SpecReviewSweepOutcome[] = [
      {
        repo: REPO,
        opened: [],
        linked: [],
        refusals: [{ supertask, action: "open", error: "tracker unreachable" }],
      },
    ];

    const body = bodyOf(sweeps);

    assert.match(
      body,
      new RegExp(`- ${REPO}: could not open a spec review for ${REPO}#40: tracker unreachable`),
    );
  });

  it("names the supertask and the error for a link refusal, without claiming an open was tried", () => {
    const supertask = implementationTicket(40);
    const sweeps: SpecReviewSweepOutcome[] = [
      {
        repo: REPO,
        opened: [],
        linked: [],
        refusals: [{ supertask, action: "link", error: "denied" }],
      },
    ];

    const body = bodyOf(sweeps);
    const section = body.slice(body.indexOf("## Spec review sweep"));

    assert.match(section, new RegExp(`- ${REPO}: could not link an existing spec review to ${REPO}#40: denied`));
    assert.doesNotMatch(section, /could not open a spec review/);
  });

  it("dedupes a refusal a later scan the same invocation met again for the same supertask", () => {
    const supertask = implementationTicket(40);
    const sweeps: SpecReviewSweepOutcome[] = [
      {
        repo: REPO,
        opened: [],
        linked: [],
        refusals: [{ supertask, action: "open", error: "tracker unreachable" }],
      },
      {
        repo: REPO,
        opened: [],
        linked: [],
        refusals: [{ supertask, action: "open", error: "tracker unreachable" }],
      },
    ];

    const body = bodyOf(sweeps);
    const matches = body.match(/could not open a spec review for nadav-alon\/pilot#40/g);

    assert.equal(matches?.length, 1);
    assert.match(
      summaryLine(factsWithSpecReviewSweeps(sweeps)),
      new RegExp(`Spec review sweep: ${REPO} \\(refused once\\)`),
    );
  });

  it("mentions the sweep in the summary line when it opened a spec review", () => {
    const opened = factsWithSpecReviewSweeps([
      { repo: REPO, opened: [specReview(40, 68)], linked: [], refusals: [] },
    ]);

    assert.match(
      summaryLine(opened),
      new RegExp(`Spec review sweep: ${REPO} \\(opened ${REPO}#68\\)`),
    );
  });

  it("names every opened spec review, not just a count", () => {
    const opened = factsWithSpecReviewSweeps([
      {
        repo: REPO,
        opened: [specReview(40, 68), specReview(10, 20)],
        linked: [],
        refusals: [],
      },
    ]);

    assert.match(summaryLine(opened), /opened nadav-alon\/pilot#68, nadav-alon\/pilot#20/);
  });

  it("mentions the sweep in the summary line when it was refused something", () => {
    const supertask = implementationTicket(40);
    const refused = factsWithSpecReviewSweeps([
      {
        repo: REPO,
        opened: [],
        linked: [],
        refusals: [{ supertask, action: "open", error: "tracker unreachable" }],
      },
    ]);

    assert.match(
      summaryLine(refused),
      new RegExp(`Spec review sweep: ${REPO} \\(refused once\\)`),
    );
  });

  it("names the spec review it linked, in the body, distinct from an opened line", () => {
    const supertask = implementationTicket(40);
    const sweeps: SpecReviewSweepOutcome[] = [
      {
        repo: REPO,
        opened: [specReview(10, 20)],
        linked: [{ supertask, specReview: specReview(40, 68) }],
        refusals: [],
      },
    ];

    const body = bodyOf(sweeps);
    const section = body.slice(body.indexOf("## Spec review sweep"));

    assert.match(section, new RegExp(`- ${REPO}: opened ${REPO}#20 \\(Spec review for #10\\)`));
    assert.match(section, new RegExp(`- ${REPO}: linked ${REPO}#68 \\(Spec review for #40\\)`));
  });

  it("mentions the sweep in the summary line when it linked a floating spec review", () => {
    const supertask = implementationTicket(40);
    const linked = factsWithSpecReviewSweeps([
      {
        repo: REPO,
        opened: [],
        linked: [{ supertask, specReview: specReview(40, 68) }],
        refusals: [],
      },
    ]);

    assert.match(
      summaryLine(linked),
      new RegExp(`Spec review sweep: ${REPO} \\(linked ${REPO}#68\\)`),
    );
  });

  it("keeps a project whose only spec review sweep activity is a link, rather than filtering it out as nothing to report", () => {
    const supertask = implementationTicket(40);
    const linked = factsWithSpecReviewSweeps([
      {
        repo: REPO,
        opened: [],
        linked: [{ supertask, specReview: specReview(40, 68) }],
        refusals: [],
      },
    ]);

    const body = bodyOf(linked.specReviewSweeps);

    assert.match(summaryLine(linked), /Spec review sweep:/);
    assert.match(body, /## Spec review sweep/);
  });

  it("dedupes a link a later scan the same invocation met again for the same supertask", () => {
    const supertask = implementationTicket(40);
    const link = { supertask, specReview: specReview(40, 68) };
    const sweeps: SpecReviewSweepOutcome[] = [
      { repo: REPO, opened: [], linked: [link], refusals: [] },
      { repo: REPO, opened: [], linked: [link], refusals: [] },
    ];

    const body = bodyOf(sweeps);
    const matches = body.match(/linked nadav-alon\/pilot#68 \(Spec review for #40\)/g);

    assert.equal(matches?.length, 1);
    assert.match(
      summaryLine(factsWithSpecReviewSweeps(sweeps)),
      new RegExp(`Spec review sweep: ${REPO} \\(linked ${REPO}#68\\)`),
    );
  });
});

describe("freed from a dead invocation", () => {
  const INVOCATION: OpenInvocation = {
    openedAt: new Date("2026-09-19T08:09:00.000Z"),
    process: processId(7563),
  };

  it("renders nothing extra, byte for byte, when nothing was freed", () => {
    const withoutFreed = facts([]);
    const withEmptyFreed: SummaryFacts = {
      ...facts([]),
      freedFromDeadInvocation: [],
    };

    const line = summaryLine(withoutFreed);
    assert.equal(
      summaryBody(withEmptyFreed, summaryLine(withEmptyFreed)),
      summaryBody(withoutFreed, line),
    );
    assert.doesNotMatch(line, /Freed from a dead invocation/);
  });

  it("names a freed ticket and the in-flight invocation it came from", () => {
    const built: SummaryFacts = {
      ...facts([]),
      freedFromDeadInvocation: [
        {
          ticket: { repo: REPO, number: issueNumber(432) },
          invocation: INVOCATION,
        },
      ],
    };

    const body = summaryBody(built, summaryLine(built));
    const section = body.slice(body.indexOf("## Freed from a dead invocation"));

    assert.match(section, new RegExp(`- ${REPO}#432: freed`));
    assert.match(section, /process 7563/);
    assert.match(section, /never closed/);
  });

  it("names every ticket a dead invocation freed, not just one", () => {
    const built: SummaryFacts = {
      ...facts([]),
      freedFromDeadInvocation: [
        { ticket: { repo: REPO, number: issueNumber(432) }, invocation: INVOCATION },
        { ticket: { repo: REPO, number: issueNumber(434) }, invocation: INVOCATION },
      ],
    };

    const body = summaryBody(built, summaryLine(built));

    assert.match(body, new RegExp(`- ${REPO}#432: freed`));
    assert.match(body, new RegExp(`- ${REPO}#434: freed`));
  });
});

describe("composeInvocationReport", () => {
  const STARTED_AT = new Date("2026-03-05T14:37:00.000Z");

  /** A gave-up run, handed back cleanly — the failure policy working, not the setup breaking. */
  function gaveUp(number: number): IterationOutcome {
    return {
      repo: REPO,
      ticket: implementationTicket(number),
      kind: "failed",
      failure: { kind: "gave-up", reason: "left the tests red" },
      handedBack: { outcome: "handed-back" },
    };
  }

  /**
   * A ticket handed back ahead of the gate, for an unusable model label — it
   * was never run, so it does not count as work when deciding the outcome.
   */
  function aheadOfGate(number: number): IterationOutcome {
    return {
      repo: REPO,
      ticket: implementationTicket(number),
      kind: "failed",
      failure: { kind: "unusable-model-label", labels: ["model:foo"] },
      handedBack: { outcome: "handed-back" },
    };
  }

  /** The stand-down a limit refusal on `implementationTicket(7)` triggers, per CONTEXT.md's "Limit refusal". */
  const LIMIT_REFUSED_STAND_DOWN: InvocationStandDown = {
    reason: "provider-limit",
    limitRefusal: LIMIT_REFUSAL,
    ticket: implementationTicket(7),
    handedBack: false,
  };

  /**
   * A `SummaryTracker` that records every summary it is asked to publish,
   * answering with a fresh issue address each time — built here rather than
   * reusing the fuller `FakeIssueTracker`, since composing a report needs
   * nothing else the tracker port can do.
   */
  function recordingTracker(): SummaryTracker & {
    published: { title: string; body: string }[];
  } {
    const published: { title: string; body: string }[] = [];
    return {
      published,
      async publishSummary(title, body) {
        published.push({ title, body });
        return issueUrl(
          `https://github.com/nadav-alon/side-projects-manager/issues/${published.length}`,
        );
      },
    };
  }

  /** A `SummaryTracker` whose `publishSummary` always refuses, naming `reason`. */
  function refusingTracker(reason: string): SummaryTracker {
    return {
      async publishSummary() {
        throw new Error(reason);
      },
    };
  }

  it("reports the line as its message, and publishes the body built from the same facts", async () => {
    const built = facts([gaveUp(7)]);
    const tracker = recordingTracker();

    const report = await composeInvocationReport(tracker, {
      startedAt: STARTED_AT,
      facts: built,
      alreadyAnnouncedToday: false,
    });

    const line = summaryLine(built);
    assert.equal(report.message, line);
    assert.equal(tracker.published[0]?.body, summaryBody(built, line));
    assert.equal(
      tracker.published[0]?.title,
      `Morning loop summary — ${localDay(STARTED_AT)} ${localTimeOfMinute(STARTED_AT)}`,
    );
  });

  it("publishes a morning that worked something even when today is already announced", async () => {
    const tracker = recordingTracker();

    const report = await composeInvocationReport(tracker, {
      startedAt: STARTED_AT,
      facts: facts([gaveUp(7)]),
      alreadyAnnouncedToday: true,
    });

    assert.equal(report.outcome, "work-selected");
    assert.equal(tracker.published.length, 1);
    assert.equal(
      report.summaryLocation,
      issueUrl("https://github.com/nadav-alon/side-projects-manager/issues/1"),
    );
  });

  it("reports work-selected, and always publishes, when a run happened alongside a limit-refused one", async () => {
    const tracker = recordingTracker();

    const report = await composeInvocationReport(tracker, {
      startedAt: STARTED_AT,
      facts: {
        ...facts([gaveUp(7), limitRefused(8, { kind: "none" })]),
        standDown: { reason: "stopped" },
      },
      alreadyAnnouncedToday: true,
    });

    assert.equal(report.outcome, "work-selected");
    assert.equal(tracker.published.length, 1);
  });

  it("reports a stand-down that ran nothing as stood-down", async () => {
    const report = await composeInvocationReport(recordingTracker(), {
      startedAt: STARTED_AT,
      facts: { ...facts([]), standDown: { reason: "stopped" } },
      alreadyAnnouncedToday: false,
    });

    assert.equal(report.outcome, "stood-down");
  });

  it("reports a stand-down as stood-down even with an iteration handed back ahead of the gate", async () => {
    const report = await composeInvocationReport(recordingTracker(), {
      startedAt: STARTED_AT,
      facts: { ...facts([aheadOfGate(7)]), standDown: { reason: "stopped" } },
      alreadyAnnouncedToday: false,
    });

    assert.equal(report.outcome, "stood-down");
  });

  it("reports a stand-down with limit-refused and ahead-of-gate iterations as stood-down", async () => {
    const report = await composeInvocationReport(recordingTracker(), {
      startedAt: STARTED_AT,
      facts: {
        ...facts([limitRefused(7, { kind: "none" }), aheadOfGate(8)]),
        standDown: LIMIT_REFUSED_STAND_DOWN,
      },
      alreadyAnnouncedToday: false,
    });

    assert.equal(report.outcome, "stood-down");
  });

  it("publishes a stand-down whose limit refusal kept a branch, even with an iteration handed back ahead of the gate", async () => {
    const tracker = recordingTracker();

    const report = await composeInvocationReport(tracker, {
      startedAt: STARTED_AT,
      facts: {
        ...facts([
          limitRefused(7, { kind: "kept", reason: "git could not delete the branch" }),
          aheadOfGate(8),
        ]),
        standDown: LIMIT_REFUSED_STAND_DOWN,
      },
      alreadyAnnouncedToday: true,
    });

    assert.equal(report.outcome, "stood-down");
    assert.equal(tracker.published.length, 1);
  });

  it("does not publish a stand-down with only limit-refused iterations when today is already announced", async () => {
    const tracker = recordingTracker();

    const report = await composeInvocationReport(tracker, {
      startedAt: STARTED_AT,
      facts: {
        ...facts([limitRefused(7, { kind: "none" })]),
        standDown: LIMIT_REFUSED_STAND_DOWN,
      },
      alreadyAnnouncedToday: true,
    });

    assert.equal(report.outcome, "stood-down");
    assert.equal(tracker.published.length, 0);
  });

  it("does not publish a stand-down whose limit refusal cleanly discarded its branch, when today is already announced", async () => {
    const tracker = recordingTracker();

    const report = await composeInvocationReport(tracker, {
      startedAt: STARTED_AT,
      facts: {
        ...facts([limitRefused(7, { kind: "discarded" })]),
        standDown: LIMIT_REFUSED_STAND_DOWN,
      },
      alreadyAnnouncedToday: true,
    });

    assert.equal(report.outcome, "stood-down");
    assert.equal(tracker.published.length, 0);
  });

  it("publishes a stand-down with only limit-refused iterations when today is not yet announced", async () => {
    const tracker = recordingTracker();

    const report = await composeInvocationReport(tracker, {
      startedAt: STARTED_AT,
      facts: {
        ...facts([limitRefused(7, { kind: "none" })]),
        standDown: LIMIT_REFUSED_STAND_DOWN,
      },
      alreadyAnnouncedToday: false,
    });

    assert.equal(report.outcome, "stood-down");
    assert.equal(tracker.published.length, 1);
  });

  it("publishes a stand-down whose limit refusal kept an undiscardable branch, even when today is already announced", async () => {
    const tracker = recordingTracker();

    const report = await composeInvocationReport(tracker, {
      startedAt: STARTED_AT,
      facts: {
        ...facts([
          limitRefused(7, { kind: "kept", reason: "git could not delete the branch" }),
        ]),
        standDown: LIMIT_REFUSED_STAND_DOWN,
      },
      alreadyAnnouncedToday: true,
    });

    assert.equal(report.outcome, "stood-down");
    assert.equal(tracker.published.length, 1);
  });

  it("publishes a stand-down whose limit refusal salvaged a branch, even when today is already announced", async () => {
    const tracker = recordingTracker();

    const report = await composeInvocationReport(tracker, {
      startedAt: STARTED_AT,
      facts: {
        ...facts([
          limitRefused(7, { kind: "salvaged", branch: branch("issue-7"), stopShorts: 1 }),
        ]),
        standDown: LIMIT_REFUSED_STAND_DOWN,
      },
      alreadyAnnouncedToday: true,
    });

    assert.equal(report.outcome, "stood-down");
    assert.equal(tracker.published.length, 1);
  });

  it("publishes a stand-down whose limit refusal filed a discovery, even when today is already announced", async () => {
    const tracker = recordingTracker();

    const report = await composeInvocationReport(tracker, {
      startedAt: STARTED_AT,
      facts: {
        ...facts([
          limitRefusedWithDiscoveries(
            7,
            routing({ filed: [{ discovery: discovery(), action: "commented" }] }),
          ),
        ]),
        standDown: LIMIT_REFUSED_STAND_DOWN,
      },
      alreadyAnnouncedToday: true,
    });

    assert.equal(report.outcome, "stood-down");
    assert.equal(tracker.published.length, 1);
  });

  it("does not publish a stand-down whose limit refusal only dropped a discovery, when today is already announced", async () => {
    const tracker = recordingTracker();

    const report = await composeInvocationReport(tracker, {
      startedAt: STARTED_AT,
      facts: {
        ...facts([
          limitRefusedWithDiscoveries(7, routing({ discoveriesDropped: 1 })),
        ]),
        standDown: LIMIT_REFUSED_STAND_DOWN,
      },
      alreadyAnnouncedToday: true,
    });

    assert.equal(report.outcome, "stood-down");
    assert.equal(tracker.published.length, 0);
  });

  it("does not publish a quiet morning when today is already announced", async () => {
    const tracker = recordingTracker();

    const report = await composeInvocationReport(tracker, {
      startedAt: STARTED_AT,
      facts: facts([]),
      alreadyAnnouncedToday: true,
    });

    assert.equal(report.outcome, "dry-queue");
    assert.equal(tracker.published.length, 0);
    assert.equal(report.summaryLocation, undefined);
  });

  it("publishes a dry queue that freed a ticket even when today is already announced", async () => {
    const tracker = recordingTracker();
    const freed: SummaryFacts = {
      ...facts([]),
      freedFromDeadInvocation: [
        {
          ticket: { repo: REPO, number: issueNumber(432) },
          invocation: {
            openedAt: new Date("2026-03-05T08:09:00.000Z"),
            process: processId(7563),
          },
        },
      ],
    };

    const report = await composeInvocationReport(tracker, {
      startedAt: STARTED_AT,
      facts: freed,
      alreadyAnnouncedToday: true,
    });

    assert.equal(report.outcome, "dry-queue");
    assert.equal(tracker.published.length, 1);
    assert.match(tracker.published[0]?.body ?? "", new RegExp(`- ${REPO}#432: freed`));
  });

  it("publishes a quiet morning when today is not yet announced", async () => {
    const tracker = recordingTracker();

    const report = await composeInvocationReport(tracker, {
      startedAt: STARTED_AT,
      facts: facts([]),
      alreadyAnnouncedToday: false,
    });

    assert.equal(tracker.published.length, 1);
    assert.equal(
      report.summaryLocation,
      issueUrl("https://github.com/nadav-alon/side-projects-manager/issues/1"),
    );
  });

  it("carries a summary that could not be published as a structured field, body and all", async () => {
    const tracker = refusingTracker("rate limited");

    const report = await composeInvocationReport(tracker, {
      startedAt: STARTED_AT,
      facts: facts([]),
      alreadyAnnouncedToday: false,
    });

    assert.equal(report.summaryFailure?.reason, "rate limited");
    assert.match(report.summaryFailure?.body ?? "", /nothing to do/i);
    assert.equal(report.summaryLocation, undefined);
    assert.match(report.message, /summary issue could not be published: rate limited/);
  });

  describe("needsAttention", () => {
    it("is true for an invocation that never finished", async () => {
      const broken: SummaryFacts = { ...facts([]), invocationFailure: "registry.json is not valid JSON" };

      const report = await composeInvocationReport(recordingTracker(), {
        startedAt: STARTED_AT,
        facts: broken,
        alreadyAnnouncedToday: false,
      });

      assert.equal(report.needsAttention, true);
    });

    it("is true for an iteration the sandbox or checkout itself failed on", async () => {
      const report = await composeInvocationReport(recordingTracker(), {
        startedAt: STARTED_AT,
        facts: facts([infrastructureFailure(7)]),
        alreadyAnnouncedToday: false,
      });

      assert.equal(report.needsAttention, true);
    });

    it("is true for a summary this invocation composed but could not publish", async () => {
      const report = await composeInvocationReport(refusingTracker("rate limited"), {
        startedAt: STARTED_AT,
        facts: facts([]),
        alreadyAnnouncedToday: false,
      });

      assert.equal(report.needsAttention, true);
    });

    it("is false for an agent that merely gave up — its ticket was handed back, and that is the policy working", async () => {
      const report = await composeInvocationReport(recordingTracker(), {
        startedAt: STARTED_AT,
        facts: facts([gaveUp(7)]),
        alreadyAnnouncedToday: false,
      });

      assert.equal(report.needsAttention, false);
    });

    it("is false for a quiet morning that published cleanly", async () => {
      const report = await composeInvocationReport(recordingTracker(), {
        startedAt: STARTED_AT,
        facts: facts([]),
        alreadyAnnouncedToday: false,
      });

      assert.equal(report.needsAttention, false);
    });
  });
});
