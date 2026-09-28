import assert from "node:assert/strict";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";

import { failureOf, handedBackFailure, type IterationOutcome } from "./iteration-outcome.ts";
import { morningLoop } from "./morning-run.ts";
import type { InvocationReport } from "./summary.ts";
import {
  APPLIED_REVIEW_LABEL,
  APPLY_REVIEW_COMMENT,
  DEFAULT_BUDGET,
  MergeabilityUnknown,
  NEEDS_REBASE,
  READY_FOR_AGENT_LABEL,
  READY_FOR_HUMAN_LABEL,
  READY_FOR_HUMAN_PULL_REQUEST_LABEL,
  REBASE_COMMENT,
  REVIEWED_LABEL,
  backlogIn,
  branch,
  checkout,
  commitSha,
  iterationLimit,
  issueNumber,
  localDay,
  modelName,
  nits as toNits,
  processId,
  pullRequestUrl,
  reserveFraction,
  reviewTitle,
  ticketGist,
  ticketKey,
  tokenCount,
  transcriptDirectory,
  transcriptPath,
  usd,
  type ApplyReviewTicket,
  type CommitSha,
  type Discovery,
  type Nits,
  type OpenInvocation,
  type RebaseTicket,
  type ReviewTicket,
  type RunFinished,
  type RunOutcome,
  type RunRequest,
  type State,
  type Ticket,
  type TicketGist,
} from "./ports/index.ts";
import {
  FROZEN_NOW,
  MANAGER,
  PILOT,
  SPENDABLE_THIS_WEEK,
  YESTERDAY,
  BUDGET_EXHAUSTED_JSON_RESULT,
  FakeClock,
  FakeProgress,
  FakeRepoHost,
  HANGS,
  LIMIT_REFUSAL,
  PROVIDER_FAILURE_PROSE,
  endsWithTranscript,
  gate,
  type FakePorts,
  type Registration,
  fakePorts,
  spent,
  verdicts,
} from "./testing/index.ts";

/** The run estimate an unsized ticket charges under `DEFAULT_BUDGET`. */
const UNSIZED_ESTIMATE = DEFAULT_BUDGET.sizes[DEFAULT_BUDGET.unsizedCountsAs];

/** The finished half of an iteration outcome — undefined if it ended any other way. */
function finished(iteration: IterationOutcome | undefined) {
  return iteration?.kind === "finished" ? iteration : undefined;
}

/** The limit-refused half of an iteration outcome — undefined if it ended any other way. */
function limitRefused(iteration: IterationOutcome | undefined) {
  return iteration?.kind === "limit-refused" ? iteration : undefined;
}

/** The budget-exhausted half of an iteration outcome — undefined if it ended any other way. */
function budgetExhausted(iteration: IterationOutcome | undefined) {
  return iteration?.kind === "budget-exhausted" ? iteration : undefined;
}

/** The discovery-blocked half of an iteration outcome — undefined if it ended any other way. */
function discoveryBlocked(iteration: IterationOutcome | undefined) {
  return iteration?.kind === "discovery-blocked" ? iteration : undefined;
}

/** The blocked-on-existing half of an iteration outcome — undefined if it ended any other way. */
function blockedOnExisting(iteration: IterationOutcome | undefined) {
  return iteration?.kind === "blocked-on-existing" ? iteration : undefined;
}

/** Why the gate refused — undefined if it never did, or something else stood the morning down instead. */
function gateRefusal(report: InvocationReport) {
  const standDown = report.standDown;
  return standDown === undefined || !("refused" in standDown)
    ? undefined
    : standDown;
}

/** What became of a failed iteration's own hand-back — undefined for any other outcome. */
function handedBackOf(iteration: IterationOutcome | undefined) {
  return iteration?.kind === "failed" && handedBackFailure(iteration)
    ? iteration.handedBack.outcome
    : undefined;
}

function pullRequestOf(iteration: IterationOutcome | undefined) {
  return finished(iteration)?.handover?.pullRequest;
}

function reviewTicketOf(iteration: IterationOutcome | undefined) {
  return finished(iteration)?.handover?.reviewTicket;
}

/** The sandbox run an iteration made — absent for a review, or a run that never started. */
function ranWith(iteration: IterationOutcome | undefined) {
  return iteration === undefined ||
    iteration.kind === "reviewed" ||
    iteration.kind === "applied-review" ||
    iteration.kind === "rebased" ||
    iteration.kind === "spec-reviewed" ||
    iteration.kind === "pull-request-resolved" ||
    iteration.kind === "discovery-blocked" ||
    iteration.kind === "blocked-on-existing"
    ? undefined
    : iteration.run;
}

const PULL_REQUEST = pullRequestUrl(
  "https://github.com/nadav-alon/pilot/pull/12",
);

/** A review ticket, eligible like any other, naming the pull request it asks about. */
function queued(ports: FakePorts, registration: Registration = {}): ReviewTicket {
  ports.store.register(PILOT, registration);
  return ports.tracker.addEligibleTicket(PILOT, {
    number: issueNumber(42),
    title: "Review the draft pull request for #7",
    pullRequest: { kind: "review", url: PULL_REQUEST },
  }) as ReviewTicket;
}

/** Records a finding on the queued pull request, as a reviewing agent would post it. */
function postedAFinding(ports: FakePorts): void {
  ports.repoHost.postReviewFinding(PULL_REQUEST, {
    path: "src/thing.ts",
    line: 3,
    body: "Missing a null check here.",
  });
}

/**
 * Records a clean review — CONTEXT.md's "Clean review" — on the queued pull
 * request: a review submitted with no finding on it, as a reviewing agent
 * that found nothing to flag would leave one.
 */
function postedACleanReview(ports: FakePorts): void {
  ports.repoHost.postCleanReview(PULL_REQUEST);
}

/** A spec review ticket, eligible like any other, naming no pull request. */
function queuedSpecReview(ports: FakePorts, registration: Registration = {}): Ticket {
  ports.store.register(PILOT, registration);
  return ports.tracker.addSpecReviewTicket(PILOT, {
    number: issueNumber(51),
    title: "Review the loop spec",
  });
}

/**
 * A supertask, and a spec review ticket hanging off it as its sub-issue — the
 * shape `createSpecReviewTicket` gives one, and the one a spec review run's
 * own discoveries route against, per CONTEXT.md's "Discovery". Shared by
 * every "a spec review ticket, selected" discovery test, which otherwise
 * opens the identical preamble under a different name.
 */
async function queuedSpecReviewWithSupertask(
  ports: FakePorts,
): Promise<{ supertask: Ticket; specReview: Ticket }> {
  ports.store.register(PILOT);
  const supertask = ports.tracker.addSupertask(PILOT, {
    number: issueNumber(50),
    title: "Too big for one run",
  });
  const specReview = await ports.tracker.createSpecReviewTicket(supertask, "Review it.");
  return { supertask, specReview };
}

const PULL_REQUEST_TICKET_TITLE = {
  review: "Review the draft pull request for #7",
  "apply-review": "Apply the review on the draft pull request for #7",
  rebase: "Rebase the draft pull request for #7",
} as const;

/**
 * The implementation ticket #7, and a `kind` ticket on it, as the review,
 * `/apply-review` or `/rebase` workflow would open one as its own sub-issue —
 * shared by every pull-request ticket kind's own "a blocking discovery"
 * tests, which otherwise open the identical preamble under a different name.
 * An apply-review ticket needs an open thread to have anything to apply, and
 * a rebase ticket needs a conflicting pull request to have anything to
 * rebase; a review ticket needs neither.
 */
function queuedWithImplementation(
  ports: FakePorts,
  kind: keyof typeof PULL_REQUEST_TICKET_TITLE,
): { implementation: Ticket; pullRequestTicket: Ticket } {
  ports.store.register(PILOT);
  if (kind === "apply-review") {
    ports.repoHost.openApplyReviewThread(PULL_REQUEST);
  }
  if (kind === "rebase") {
    ports.repoHost.mergeStatus = () => "conflicting";
  }
  const implementation = ports.tracker.addEligibleTicket(PILOT, {
    number: issueNumber(7),
    title: "Add the thing",
  });
  const numbers = { review: 42, "apply-review": 43, rebase: 44 } as const;
  const pullRequestTicket = ports.tracker.addEligibleTicket(PILOT, {
    number: issueNumber(numbers[kind]),
    title: PULL_REQUEST_TICKET_TITLE[kind],
    pullRequest: { kind, url: PULL_REQUEST },
    parent: issueNumber(7),
  });
  return { implementation, pullRequestTicket };
}

describe("morningLoop", () => {
  it("reports a dry queue when nothing is registered", async () => {
    const ports = fakePorts();

    const report = await morningLoop(ports);

    assert.equal(report.outcome, "dry-queue");
    assert.deepEqual(report.projects, []);
    assert.match(report.message, /nothing to do/i);
  });

  it("reports a dry queue when every backlog is empty", async () => {
    const ports = fakePorts();
    ports.store.register(MANAGER);
    ports.store.register(PILOT);

    const report = await morningLoop(ports);

    assert.equal(report.outcome, "dry-queue");
    assert.deepEqual(verdicts(report.projects), [
      [MANAGER, "no-eligible-tickets"],
      [PILOT, "no-eligible-tickets"],
    ]);
    assert.match(report.message, /nothing to do/i);
  });

  it("never runs an agent when the queue is dry", async (t) => {
    const ports = fakePorts();
    ports.store.register(PILOT);
    const run = t.mock.method(ports.sandbox, "run");

    await morningLoop(ports);

    assert.equal(run.mock.callCount(), 0);
  });

  it("selects the project it found work in", async () => {
    const ports = fakePorts();
    ports.store.register(PILOT);
    ports.tracker.addEligibleTicket(PILOT, {
      number: issueNumber(7),
      title: "Add the thing",
    });

    const report = await morningLoop(ports);

    assert.equal(report.outcome, "work-selected");
    assert.deepEqual(verdicts(report.projects), [[PILOT, "selected"]]);
    assert.match(report.message, /nadav-alon\/pilot/);
  });

  it("selects one project and one ticket per iteration, working through a backlog one at a time", async () => {
    const ports = fakePorts();
    ports.store.register(PILOT);
    ports.tracker.addEligibleTicket(PILOT, {
      number: issueNumber(7),
      title: "Add the thing",
    });
    ports.tracker.addEligibleTicket(PILOT, {
      number: issueNumber(8),
      title: "Add the other thing",
    });

    await morningLoop(ports);

    // Two distinct tickets, each its own sandbox run: an iteration is one
    // project and one ticket, and the second iteration picked up what the
    // first left, since ticket #7 is excluded once worked rather than
    // re-offered.
    assert.deepEqual(
      ports.sandbox.runs.map((run) => run.ticket.number),
      [7, 8],
    );
  });

  it("timestamps the report from the injected clock, not wall time", async () => {
    const ports = fakePorts();
    const startedAt = ports.clock.now();

    const report = await morningLoop(ports);

    assert.deepEqual(report.startedAt, startedAt);
  });

  it("is reported as skipped for being paused", async () => {
    const ports = fakePorts();
    ports.store.register(MANAGER, { paused: true });
    ports.store.register(PILOT);

    const report = await morningLoop(ports);

    assert.match(
      report.message,
      /nadav-alon\/side-projects-manager \(paused\)/,
    );
    assert.match(
      report.message,
      /nadav-alon\/pilot \(no ready-for-agent tickets\)/,
    );
  });

  it("selects a sibling ticket instead, when one in the same backlog is a supertask", async () => {
    const ports = fakePorts();
    ports.store.register(PILOT);
    ports.tracker.addSupertask(
      PILOT,
      { number: issueNumber(66), title: "Too big for one run" },
    );
    ports.tracker.addEligibleTicket(PILOT, {
      number: issueNumber(67),
      title: "One of the slices",
    });

    const report = await morningLoop(ports);

    assert.equal(report.outcome, "work-selected");
    assert.deepEqual(
      ports.sandbox.runs.map((run) => run.ticket.number),
      [67],
    );
    // Selected for #67, yet still says #66 was passed over.
    assert.match(report.message, /#66 declared a supertask/);
  });

  it("selects a sibling ticket instead, and says the blocked one was passed over", async () => {
    const ports = fakePorts();
    ports.store.register(PILOT);
    ports.tracker.addBlockedTicket(
      PILOT,
      { number: issueNumber(56), title: "Waits on #55" },
      2,
    );
    ports.tracker.addEligibleTicket(PILOT, {
      number: issueNumber(55),
      title: "The blocker",
    });

    const report = await morningLoop(ports);

    assert.equal(report.outcome, "work-selected");
    assert.deepEqual(
      ports.sandbox.runs.map((run) => run.ticket.number),
      [55],
    );
    assert.match(report.message, /#56 blocked by an open ticket/);
  });

  it("still selects, but flags, a ticket with an open sub-issue that carries no supertask label", async () => {
    const ports = fakePorts();
    ports.store.register(PILOT);
    ports.tracker.addEligibleTicket(PILOT, {
      number: issueNumber(66),
      title: "Too big for one run",
    });
    ports.tracker.addIneligibleTicket(PILOT, {
      number: issueNumber(67),
      title: "One of the slices",
      parent: issueNumber(66),
    });

    const report = await morningLoop(ports);

    assert.equal(report.outcome, "work-selected");
    assert.deepEqual(
      ports.sandbox.runs.map((run) => run.ticket.number),
      [66],
    );
    assert.match(report.message, /Check for a missed supertask label: .*#66/);
  });

  describe("a truncated backlog", () => {
    it("names the truncated project in the waiting section, even when nothing else is waiting", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addSupertask(
        PILOT,
        { number: issueNumber(66), title: "Too big for one run" },
      );
      ports.tracker.truncateBacklog(PILOT);

      const report = await morningLoop(ports);

      assert.deepEqual(report.iterations, []);
      const body = ports.tracker.summaries[0]?.body ?? "";
      assert.match(body, /## Waiting on you/);
      const waiting = body.slice(body.indexOf("## Waiting on you"));
      const bullets = waiting
        .split("\n")
        .filter((line) => line.includes(PILOT));
      assert.equal(bullets.length, 1);
      assert.match(
        bullets[0] ?? "",
        new RegExp(
          `- ${PILOT}: holds more than 100 ready-for-agent tickets — only the newest 100 were considered`,
        ),
      );
    });

    it("names truncated projects in registry order", async () => {
      const ports = fakePorts();
      ports.store.register(MANAGER);
      ports.tracker.addSupertask(
        MANAGER,
        { number: issueNumber(66), title: "Too big for one run" },
      );
      ports.tracker.truncateBacklog(MANAGER);
      ports.store.register(PILOT);
      ports.tracker.addSupertask(
        PILOT,
        { number: issueNumber(67), title: "Also too big" },
      );
      ports.tracker.truncateBacklog(PILOT);

      await morningLoop(ports);

      const body = ports.tracker.summaries[0]?.body ?? "";
      const waiting = body.slice(body.indexOf("## Waiting on you"));
      assert.notEqual(waiting.indexOf(MANAGER), -1);
      assert.notEqual(waiting.indexOf(PILOT), -1);
      assert.ok(waiting.indexOf(MANAGER) < waiting.indexOf(PILOT));
    });

    it("never mentions truncation in the one-line message", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      ports.tracker.truncateBacklog(PILOT);

      const report = await morningLoop(ports);

      assert.doesNotMatch(report.message, /truncat|100 ready-for-agent/i);
    });

    it("adds no waiting section when no project is truncated", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addSupertask(
        PILOT,
        { number: issueNumber(66), title: "Too big for one run" },
      );

      await morningLoop(ports);

      const body = ports.tracker.summaries[0]?.body ?? "";
      assert.doesNotMatch(body, /## Waiting on you/);
    });
  });

  describe("state", () => {
    it("is written back after every invocation, including a quiet one", async (t) => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      const saveState = t.mock.method(ports.store, "saveState");

      await morningLoop(ports);

      // Once for the invocation's own bookkeeping, and again once the quiet
      // summary — today's first — has published, to record today as announced.
      assert.equal(saveState.mock.callCount(), 2);
    });

    it("keeps what earlier invocations recorded", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.store.markWorked(PILOT, YESTERDAY, {
        at: YESTERDAY,
        tokensUsed: tokenCount(120_000),
      });

      await morningLoop(ports);
      const report = await morningLoop(ports);

      assert.deepEqual(report.projects[0]?.lastWorkedAt, YESTERDAY);
    });
  });

  describe("tickets worked today", () => {
    const TODAY = localDay(FROZEN_NOW);

    /**
     * Runs the invocation, returning the state as it was saved the instant
     * the ticket's own run started — before the invocation could go on to
     * hand the ticket back cleanly and free it again, which is a different
     * behaviour most callers of this are not about.
     *
     * Reimplements `FakeSandbox.run` rather than delegating to the bound
     * original: `Sandbox.run` is overloaded on whether `model` is present,
     * and neither `.bind` nor a mock replacement keeps that shape, so a
     * request typed as the general `RunRequest` has no original overload left
     * to call through to.
     */
    async function savedWhenRunStarted(
      ports: FakePorts,
      t: TestContext,
    ): Promise<State | undefined> {
      let saved: State | undefined;
      t.mock.method(ports.sandbox, "run", async (request: RunRequest) => {
        saved = await ports.store.loadState();
        ports.sandbox.runs.push(request);
        return ports.sandbox.result(request.ticket);
      });
      await morningLoop(ports);
      return saved;
    }

    it("records a ticket it works as worked today, dropping an earlier day's record", async (t) => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      ports.store.markWorkedOn(localDay(YESTERDAY), {
        repo: MANAGER,
        number: issueNumber(3),
      });

      const saved = await savedWhenRunStarted(ports, t);

      assert.deepEqual(saved?.workedToday, {
        day: TODAY,
        tickets: [{ repo: PILOT, number: issueNumber(7) }],
      });
    });

    it("keeps the tickets an earlier invocation worked today", async (t) => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      ports.store.markWorkedOn(TODAY, { repo: MANAGER, number: issueNumber(3) });

      const saved = await savedWhenRunStarted(ports, t);

      assert.deepEqual(saved?.workedToday, {
        day: TODAY,
        tickets: [
          { repo: MANAGER, number: issueNumber(3) },
          { repo: PILOT, number: issueNumber(7) },
        ],
      });
    });

    it("says a project whose only eligible ticket was already worked today, not that it has none", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      ports.store.markWorkedOn(TODAY, { repo: PILOT, number: issueNumber(7) });

      const report = await morningLoop(ports);

      assert.match(report.message, /nadav-alon\/pilot \(already worked today\)/);
    });

    it("frees the ticket for a later firing today when the sandbox could not run it", async (t) => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      t.mock.method(ports.sandbox, "run", async () => {
        throw new Error("the docker daemon is not running");
      });

      await morningLoop(ports);

      assert.deepEqual(
        (await ports.store.loadState()).workedToday?.tickets,
        [],
      );
    });

    it("frees the ticket for a later firing today when the provider limit refused its run", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      ports.sandbox.result = (ticket) => ({
        kind: "limit-refused",
        branch: branch(`fake/${ticket.repo}/${ticket.number}`),
        commits: [],
        words: LIMIT_REFUSAL,
        tokensUsed: tokenCount(0),
      });

      await morningLoop(ports);

      assert.deepEqual(
        (await ports.store.loadState()).workedToday?.tickets,
        [],
      );
    });

    it("frees the ticket for a later firing today when a provider failure cut off its run", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      ports.sandbox.result = (ticket) => ({
        kind: "provider-failed",
        branch: branch(`fake/${ticket.repo}/${ticket.number}`),
        commits: [],
        words: PROVIDER_FAILURE_PROSE,
        tokensUsed: tokenCount(0),
      });

      await morningLoop(ports);

      assert.deepEqual(
        (await ports.store.loadState()).workedToday?.tickets,
        [],
      );
    });

    it("frees the ticket for a later firing today when its own spend ceiling stopped its run", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      ports.sandbox.result = (ticket) => ({
        kind: "budget-exhausted",
        branch: branch(`fake/${ticket.repo}/${ticket.number}`),
        commits: [],
        words: BUDGET_EXHAUSTED_JSON_RESULT,
        tokensUsed: tokenCount(0),
      });

      await morningLoop(ports);

      assert.deepEqual(
        (await ports.store.loadState()).workedToday?.tickets,
        [],
      );
    });

    it("has saved the ticket as worked today before the sandbox starts, so a run killed part way still counts", async (t) => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });

      const saved = await savedWhenRunStarted(ports, t);

      assert.deepEqual(saved?.workedToday, {
        day: TODAY,
        tickets: [{ repo: PILOT, number: issueNumber(7) }],
      });
    });

    it("frees the ticket for a later firing today once a finished run's hand-back lands", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });

      await morningLoop(ports);

      assert.deepEqual(
        (await ports.store.loadState()).workedToday?.tickets,
        [],
      );
    });

    it("frees a ticket handed back for conflicting model labels for a later firing today", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      const ticket = ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      ports.tracker.addLabel(ticket, "model:opus");
      ports.tracker.addLabel(ticket, "model:haiku");

      await morningLoop(ports);

      assert.deepEqual(
        (await ports.store.loadState()).workedToday?.tickets,
        [],
      );
    });

    it("keeps the ticket on the record for the rest of the day when its hand-back is refused", async (t) => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      ports.sandbox.result = () => ({
        kind: "gave-up",
        branch: branch("issue-7-add-the-thing"),
        commits: [],
        output: "I could not find the thing",
        tokensUsed: tokenCount(1_000),
        reason: "the tests stayed red",
      });
      t.mock.method(ports.tracker, "handBack", async () => {
        throw new Error("the tracker is unreachable");
      });

      await morningLoop(ports);

      assert.deepEqual(
        (await ports.store.loadState()).workedToday?.tickets,
        [{ repo: PILOT, number: issueNumber(7) }],
      );
    });

    it("frees a review ticket for a later firing today once it closes cleanly", async () => {
      const ports = fakePorts();
      queued(ports);
      postedAFinding(ports);

      await morningLoop(ports);

      assert.deepEqual(
        (await ports.store.loadState()).workedToday?.tickets,
        [],
      );
    });

    it("keeps a review ticket on the record for the rest of the day when the loop cannot close it", async (t) => {
      const ports = fakePorts();
      queued(ports);
      postedAFinding(ports);
      t.mock.method(ports.tracker, "closeReviewTicket", async () => {
        throw new Error("issue is locked");
      });

      await morningLoop(ports);

      assert.deepEqual(
        (await ports.store.loadState()).workedToday?.tickets,
        [{ repo: PILOT, number: issueNumber(42) }],
      );
    });

    it("frees an apply-review ticket for a later firing today once it closes cleanly", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      const pullRequest = pullRequestUrl(
        "https://github.com/nadav-alon/pilot/pull/12",
      );
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(43),
        title: "Apply the review on the draft pull request for #7",
        pullRequest: { kind: "apply-review", url: pullRequest },
      });

      await morningLoop(ports);

      assert.deepEqual(
        (await ports.store.loadState()).workedToday?.tickets,
        [],
      );
    });

    it("keeps an apply-review ticket on the record for the rest of the day when the loop cannot close it", async (t) => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      const pullRequest = pullRequestUrl(
        "https://github.com/nadav-alon/pilot/pull/12",
      );
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(43),
        title: "Apply the review on the draft pull request for #7",
        pullRequest: { kind: "apply-review", url: pullRequest },
      });
      t.mock.method(ports.tracker, "closeApplyReviewTicket", async () => {
        throw new Error("issue is locked");
      });

      await morningLoop(ports);

      assert.deepEqual(
        (await ports.store.loadState()).workedToday?.tickets,
        [{ repo: PILOT, number: issueNumber(43) }],
      );
    });

    it("frees a rebase ticket for a later firing today once it closes cleanly", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.repoHost.mergeStatus = () => "clean";
      const pullRequest = pullRequestUrl(
        "https://github.com/nadav-alon/pilot/pull/12",
      );
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(44),
        title: "Rebase the draft pull request for #7",
        pullRequest: { kind: "rebase", url: pullRequest },
      });

      await morningLoop(ports);

      assert.deepEqual(
        (await ports.store.loadState()).workedToday?.tickets,
        [],
      );
    });

    it("keeps a rebase ticket on the record for the rest of the day when the loop cannot close it", async (t) => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.repoHost.mergeStatus = () => "clean";
      const pullRequest = pullRequestUrl(
        "https://github.com/nadav-alon/pilot/pull/12",
      );
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(44),
        title: "Rebase the draft pull request for #7",
        pullRequest: { kind: "rebase", url: pullRequest },
      });
      t.mock.method(ports.tracker, "closeRebaseTicket", async () => {
        throw new Error("issue is locked");
      });

      await morningLoop(ports);

      assert.deepEqual(
        (await ports.store.loadState()).workedToday?.tickets,
        [{ repo: PILOT, number: issueNumber(44) }],
      );
    });

    it("frees a resolved pull request ticket for a later firing today once it closes cleanly", async () => {
      const ports = fakePorts();
      queued(ports);
      ports.repoHost.setPullRequestState(PULL_REQUEST, "merged");

      await morningLoop(ports);

      assert.deepEqual(
        (await ports.store.loadState()).workedToday?.tickets,
        [],
      );
    });

    it("keeps a resolved pull request ticket on the record for the rest of the day when the loop cannot close it", async (t) => {
      const ports = fakePorts();
      queued(ports);
      ports.repoHost.setPullRequestState(PULL_REQUEST, "merged");
      t.mock.method(ports.tracker, "closeReviewTicket", async () => {
        throw new Error("issue is locked");
      });

      await morningLoop(ports);

      assert.deepEqual(
        (await ports.store.loadState()).workedToday?.tickets,
        [{ repo: PILOT, number: issueNumber(42) }],
      );
    });

    describe("freed from a dead invocation", () => {
      const DEAD: OpenInvocation = {
        openedAt: new Date("2026-09-19T08:09:00.000Z"),
        process: processId(7563),
      };
      const SELF: OpenInvocation = {
        openedAt: new Date("2026-09-19T09:56:00.000Z"),
        process: processId(9001),
      };

      it("selects a ticket a dead in-flight invocation recorded as worked today", async () => {
        const ports = fakePorts();
        ports.store.register(PILOT);
        ports.tracker.addEligibleTicket(PILOT, {
          number: issueNumber(432),
          title: "Add the thing",
        });
        await ports.store.openInvocation(DEAD);
        ports.store.markWorkedOn(TODAY, {
          repo: PILOT,
          number: issueNumber(432),
          recordedBy: DEAD,
        });
        await ports.store.openInvocation(SELF);

        const report = await morningLoop(ports, { invocation: SELF });

        assert.ok(
          report.iterations.some(
            (iteration) => iteration.ticket.number === issueNumber(432),
          ),
        );
      });

      it("keeps a ticket passed over when the invocation that recorded it has closed", async () => {
        const ports = fakePorts();
        ports.store.register(PILOT);
        ports.tracker.addEligibleTicket(PILOT, {
          number: issueNumber(432),
          title: "Add the thing",
        });
        await ports.store.openInvocation(DEAD);
        await ports.store.closeInvocation(DEAD, {
          closedAt: new Date("2026-09-19T08:20:00.000Z"),
          outcome: "work-selected",
          projects: [],
        });
        ports.store.markWorkedOn(TODAY, {
          repo: PILOT,
          number: issueNumber(432),
          recordedBy: DEAD,
        });
        await ports.store.openInvocation(SELF);

        const report = await morningLoop(ports, { invocation: SELF });

        assert.equal(
          report.iterations.some(
            (iteration) => iteration.ticket.number === issueNumber(432),
          ),
          false,
        );
      });

      it("leaves a ticket passed over when morningLoop is given no invocation identity", async () => {
        const ports = fakePorts();
        ports.store.register(PILOT);
        ports.tracker.addEligibleTicket(PILOT, {
          number: issueNumber(432),
          title: "Add the thing",
        });
        await ports.store.openInvocation(DEAD);
        ports.store.markWorkedOn(TODAY, {
          repo: PILOT,
          number: issueNumber(432),
          recordedBy: DEAD,
        });

        const report = await morningLoop(ports);

        assert.equal(
          report.iterations.some(
            (iteration) => iteration.ticket.number === issueNumber(432),
          ),
          false,
        );
      });

      it("names the freed ticket and the in-flight invocation it came from in the summary", async () => {
        const ports = fakePorts();
        ports.store.register(PILOT);
        ports.tracker.addEligibleTicket(PILOT, {
          number: issueNumber(432),
          title: "Add the thing",
        });
        await ports.store.openInvocation(DEAD);
        ports.store.markWorkedOn(TODAY, {
          repo: PILOT,
          number: issueNumber(432),
          recordedBy: DEAD,
        });
        await ports.store.openInvocation(SELF);

        await morningLoop(ports, { invocation: SELF });

        const body = ports.tracker.summaries[0]?.body ?? "";
        assert.match(body, /## Freed from a dead invocation/);
        assert.match(body, /nadav-alon\/pilot#432/);
        assert.match(body, /7563/);
      });

      it("frees nothing, but still stamps a newly recorded ticket with its own identity and says so on progress, when the journal cannot be read", async (t) => {
        const ports = fakePorts();
        ports.store.register(PILOT);
        ports.repoHost.mergeStatus = () => "clean";
        const pullRequest = pullRequestUrl(
          "https://github.com/nadav-alon/pilot/pull/12",
        );
        ports.tracker.addEligibleTicket(PILOT, {
          number: issueNumber(44),
          title: "Rebase the draft pull request for #7",
          pullRequest: { kind: "rebase", url: pullRequest },
        });
        t.mock.method(ports.tracker, "closeRebaseTicket", async () => {
          throw new Error("issue is locked");
        });
        await ports.store.openInvocation(SELF);
        const progress = new FakeProgress();
        ports.progress = progress;
        t.mock.method(ports.store, "loadJournal", async () => {
          throw new Error("journal.json: not valid JSON");
        });

        await morningLoop(ports, { invocation: SELF });

        assert.deepEqual(
          (await ports.store.loadState()).workedToday?.tickets,
          [{ repo: PILOT, number: issueNumber(44), recordedBy: SELF }],
        );
        assert.ok(
          progress.events.some((event) => event.kind === "journal-unreadable"),
        );
      });

      it("still publishes a summary naming a freed ticket, even with a dry queue on a day already announced", async () => {
        const ports = fakePorts();
        ports.store.register(PILOT);
        await ports.store.openInvocation(DEAD);
        ports.store.markWorkedOn(TODAY, {
          repo: PILOT,
          number: issueNumber(432),
          recordedBy: DEAD,
        });
        await ports.store.openInvocation(SELF);
        ports.store.markAnnouncedOn(TODAY);

        const report = await morningLoop(ports, { invocation: SELF });

        assert.equal(report.outcome, "dry-queue");
        assert.equal(ports.tracker.summaries.length, 1);
        const body = ports.tracker.summaries[0]?.body ?? "";
        assert.match(body, /## Freed from a dead invocation/);
        assert.match(body, /nadav-alon\/pilot#432/);
      });
    });
  });

  describe("the run", () => {
    it("passes the selected ticket and the project checkout to the sandbox", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      const ticket = ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });

      await morningLoop(ports);

      assert.deepEqual(ports.sandbox.runs, [
        {
          ticket,
          checkout: `${FakeRepoHost.MANAGED_LOCATION}/${PILOT}`,
          spendCeiling: DEFAULT_BUDGET.spendCeiling,
        },
      ]);
    });

    it("asks the repo host for a checkout of the project it selected", async () => {
      const ports = fakePorts();
      ports.store.register(MANAGER, { paused: true });
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.clones, [PILOT]);
    });

    it("clones nothing when the queue is dry", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.clones, []);
      assert.deepEqual(ports.sandbox.runs, []);
    });

    it("reports the branch, commits, output and cost the run came back with", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      ports.sandbox.result = () => ({
        kind: "finished",
        branch: branch("issue-7-add-the-thing"),
        commits: [commitSha("c0ffee1"), commitSha("c0ffee2")],
        output: "implemented the thing",
        tokensUsed: tokenCount(42_000),
      });

      const report = await morningLoop(ports);

      assert.deepEqual(finished(report.iterations[0])?.run, {
        kind: "finished",
        branch: branch("issue-7-add-the-thing"),
        commits: [commitSha("c0ffee1"), commitSha("c0ffee2")],
        output: "implemented the thing",
        tokensUsed: tokenCount(42_000),
      });
    });

    it("has no run to report on a quiet morning", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);

      const report = await morningLoop(ports);

      assert.deepEqual(report.iterations, []);
    });

    it("says in the message what the run left behind", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      ports.sandbox.result = () => ({
        kind: "finished",
        branch: branch("issue-7-add-the-thing"),
        commits: [commitSha("c0ffee1")],
        output: "",
        tokensUsed: tokenCount(42_000),
      });

      const report = await morningLoop(ports);

      assert.match(report.message, /nadav-alon\/pilot/);
      assert.match(report.message, /issue-7-add-the-thing/);
    });
  });

  describe("what a run records", () => {
    it("records the project as worked, at the clock's instant", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });

      await morningLoop(ports);
      const report = await morningLoop(ports);

      assert.deepEqual(report.projects[0]?.lastWorkedAt, FROZEN_NOW);
    });

    it("records what the run cost", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      ports.sandbox.result = () => ({
        kind: "finished",
        branch: branch("issue-7-add-the-thing"),
        commits: [],
        output: "",
        tokensUsed: tokenCount(42_000),
      });

      await morningLoop(ports);

      const state = await ports.store.loadState();
      assert.deepEqual(state.projects.get(PILOT)?.runs, [
        { at: FROZEN_NOW, tokensUsed: tokenCount(42_000) },
      ]);
    });

    it("keeps the runs earlier invocations recorded", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.store.markWorked(PILOT, YESTERDAY, {
        at: YESTERDAY,
        tokensUsed: tokenCount(120_000),
      });
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });

      await morningLoop(ports);

      const state = await ports.store.loadState();
      assert.deepEqual(
        state.projects.get(PILOT)?.runs.map((run) => run.at),
        [YESTERDAY, FROZEN_NOW],
      );
    });

    it("records nothing against a project it never ran", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);

      await morningLoop(ports);

      const state = await ports.store.loadState();
      assert.equal(state.projects.get(PILOT), undefined);
    });
  });

  describe("run in progress", () => {
    const SELF: OpenInvocation = {
      openedAt: new Date("2026-09-19T09:56:00.000Z"),
      process: processId(9001),
    };
    const TICKET = { number: issueNumber(7), title: "Add the thing" };

    it("records the run on the invocation's own journal entry while it is going, and clears it once the run ends", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, TICKET);
      await ports.store.openInvocation(SELF);
      ports.sandbox.hold();

      const invocation = morningLoop(ports, { invocation: SELF });
      await ports.sandbox.whenHeld(1);

      const inFlight = await ports.store.loadJournal();
      assert.deepEqual(
        inFlight.records.find((record) => record.process === SELF.process)?.runs,
        [
          {
            kind: "implementation",
            repo: PILOT,
            number: TICKET.number,
            startedAt: FROZEN_NOW,
            transcriptDirectory: transcriptDirectory(
              path.join("/fake-transcripts", ticketKey({ repo: PILOT, number: TICKET.number })),
            ),
          },
        ],
      );

      ports.sandbox.release({ repo: PILOT, ...TICKET });
      await invocation;

      const afterward = await ports.store.loadJournal();
      assert.deepEqual(
        afterward.records.find((record) => record.process === SELF.process)?.runs ?? [],
        [],
      );
    });

    it("records the pull request a review run is bound to, alongside its ticket", async () => {
      const ports = fakePorts();
      const ticket = queued(ports);
      await ports.store.openInvocation(SELF);
      ports.sandbox.hold();

      const invocation = morningLoop(ports, { invocation: SELF });
      await ports.sandbox.whenHeld(1);

      const inFlight = await ports.store.loadJournal();
      const [run] = inFlight.records.find((record) => record.process === SELF.process)?.runs ?? [];
      assert.equal(run?.pullRequest, PULL_REQUEST);

      ports.sandbox.release(ticket);
      await invocation;
    });

    it("records nothing when the invocation carries no journal identity", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, TICKET);

      await morningLoop(ports);

      const journal = await ports.store.loadJournal();
      assert.deepEqual(journal.records, []);
    });

    it("warns, rather than silently losing it, when recording the run started fails to write", async (t) => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, TICKET);
      await ports.store.openInvocation(SELF);
      t.mock.method(ports.store, "recordRunStarted", async () => {
        throw new Error("journal write failed");
      });
      const warnings: string[] = [];
      t.mock.method(console, "warn", (line: string) => {
        warnings.push(line);
      });

      const report = await morningLoop(ports, { invocation: SELF });
      // `onStarted` fires the write and moves on without waiting on it, so
      // give it a turn to settle before checking it warned.
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(report.outcome, "work-selected");
      assert.equal(ports.sandbox.runs.length, 1);
      assert.ok(warnings.some((line) => line.includes("journal write failed")));
    });

    it("still spends the run's cost, and does not fail the invocation, when clearing it from the journal fails to write", async (t) => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, TICKET);
      await ports.store.openInvocation(SELF);
      t.mock.method(ports.store, "recordRunEnded", async () => {
        throw new Error("journal write failed");
      });

      const report = await morningLoop(ports, { invocation: SELF });

      assert.equal(report.outcome, "work-selected");
      const state = await ports.store.loadState();
      assert.equal(state.projects.get(PILOT)?.runs.length, 1);
    });

    it("reports the sandbox's own failure, not a failed clear, when both the sandbox and the clear fail", async (t) => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, TICKET);
      await ports.store.openInvocation(SELF);
      t.mock.method(ports.sandbox, "run", async () => {
        throw new Error("docker is not running");
      });
      t.mock.method(ports.store, "recordRunEnded", async () => {
        throw new Error("journal write failed");
      });

      const report = await morningLoop(ports, { invocation: SELF });

      assert.equal(failureOf(report.iterations[0])?.kind, "infrastructure");
      assert.match(report.message, /docker is not running/);
    });
  });

  describe("run span", () => {
    const TICKET = { number: issueNumber(7), title: "Add the thing" };

    it("records the ticket's own run span in the state document while it is going, and closes it once the run ends", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, TICKET);
      ports.sandbox.hold();

      const invocation = morningLoop(ports);
      await ports.sandbox.whenHeld(1);

      const inProgress = await ports.store.loadState();
      assert.deepEqual(inProgress.runSpans, [
        { repo: PILOT, number: TICKET.number, startedAt: FROZEN_NOW },
      ]);

      ports.sandbox.release({ repo: PILOT, ...TICKET });
      await invocation;

      const afterward = await ports.store.loadState();
      assert.deepEqual(afterward.runSpans, [
        { repo: PILOT, number: TICKET.number, startedAt: FROZEN_NOW, endedAt: FROZEN_NOW },
      ]);
    });

    it("replaces a span an earlier invocation left with this run's own", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      const ticket = ports.tracker.addEligibleTicket(PILOT, TICKET);
      ports.store.markRunSpan(
        ticket,
        new Date("2025-12-31T09:00:00.000Z"),
        new Date("2025-12-31T09:10:00.000Z"),
      );

      await morningLoop(ports);

      const state = await ports.store.loadState();
      assert.deepEqual(state.runSpans, [
        { repo: PILOT, number: TICKET.number, startedAt: FROZEN_NOW, endedAt: FROZEN_NOW },
      ]);
    });

    it("records nothing against the state document when the clone never happens", async (t) => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, TICKET);
      t.mock.method(ports.repoHost, "clone", async () => {
        throw new Error("the repo host is down");
      });

      await morningLoop(ports);

      const state = await ports.store.loadState();
      assert.equal(state.runSpans, undefined);
    });

    it("leaves an earlier run's own span untouched when this run's sandbox never starts", async (t) => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      const ticket = ports.tracker.addEligibleTicket(PILOT, TICKET);
      ports.store.markRunSpan(
        ticket,
        new Date("2025-12-31T09:00:00.000Z"),
        new Date("2025-12-31T09:10:00.000Z"),
      );
      t.mock.method(ports.sandbox, "run", async () => {
        throw new Error("docker is not running");
      });

      await morningLoop(ports);

      const state = await ports.store.loadState();
      assert.deepEqual(state.runSpans, [
        {
          repo: PILOT,
          number: TICKET.number,
          startedAt: new Date("2025-12-31T09:00:00.000Z"),
          endedAt: new Date("2025-12-31T09:10:00.000Z"),
        },
      ]);
    });
  });

  describe("the draft pull request", () => {
    const BRANCH = branch("issue-7-add-the-thing");

    /**
     * A registered project with ticket #7 ready, and a run against it.
     *
     * What separates the cases here is only how the run ended, so that is all
     * a test says: `ran(ports)` did the work. `failure` and `commits: []`
     * are the two ways it can leave nothing to hand over; `gist` is what a
     * finished run carried away, not how it ended.
     */
    function ran(
      ports: FakePorts,
      run: {
        commits?: CommitSha[];
        failure?: string;
        gist?: TicketGist;
        nits?: Nits;
        discoveries?: Discovery[];
        discoveriesDropped?: number;
      } = {},
    ): Ticket {
      ports.store.register(PILOT);
      const ticket = ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      ports.sandbox.result = () =>
        run.failure === undefined
          ? {
              kind: "finished",
              branch: BRANCH,
              commits: run.commits ?? [commitSha("c0ffee1")],
              output: "",
              tokensUsed: tokenCount(42_000),
              ...(run.gist !== undefined && { gist: run.gist }),
              ...(run.nits !== undefined && { nits: run.nits }),
              ...(run.discoveries !== undefined && { discoveries: run.discoveries }),
              ...(run.discoveriesDropped !== undefined && {
                discoveriesDropped: run.discoveriesDropped,
              }),
            }
          : {
              kind: "gave-up",
              branch: BRANCH,
              commits: run.commits ?? [commitSha("c0ffee1")],
              output: "",
              reason: run.failure,
              tokensUsed: tokenCount(42_000),
              ...(run.discoveries !== undefined && { discoveries: run.discoveries }),
              ...(run.discoveriesDropped !== undefined && {
                discoveriesDropped: run.discoveriesDropped,
              }),
            };
      return ticket;
    }

    it("is opened for the branch a run left commits on", async () => {
      const ports = fakePorts();
      const ticket = ran(ports);

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.pullRequests, [
        {
          directory: `${FakeRepoHost.MANAGED_LOCATION}/${PILOT}`,
          branch: BRANCH,
          ticket,
        },
      ]);
    });

    it("adds no reviewed or applied-review label to an implementation run's own pull request", async () => {
      const ports = fakePorts();
      ran(ports);

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.labelled, []);
    });

    it("is opened with the run's ticket gist, when it carried one", async () => {
      const ports = fakePorts();
      const gist = ticketGist("Add the thing to the widget.");
      const ticket = ran(ports, { gist });

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.pullRequests, [
        {
          directory: `${FakeRepoHost.MANAGED_LOCATION}/${PILOT}`,
          branch: BRANCH,
          ticket,
          gist,
        },
      ]);
    });

    it("is reported, so the developer is told where to review", async () => {
      const ports = fakePorts();
      ran(ports);

      const report = await morningLoop(ports);

      assert.equal(pullRequestOf(report.iterations[0]), FakeRepoHost.RUN_PULL_REQUEST);
      assert.match(report.message, new RegExp(FakeRepoHost.RUN_PULL_REQUEST));
    });

    it("hands the implementation ticket back, with a comment naming its draft pull request", async () => {
      const ports = fakePorts();
      const ticket = ran(ports);

      await morningLoop(ports);

      const handback = ports.tracker.handbacks.find(
        (entry) => entry.ticket.number === ticket.number,
      );
      assert.ok(handback, "the implementation ticket should have been handed back");
      assert.match(
        handback.comment,
        new RegExp(FakeRepoHost.RUN_PULL_REQUEST),
      );
    });

    it("takes the implementation ticket out of the queue, so a later invocation does not select it again", async () => {
      const ports = fakePorts();
      ran(ports);

      // One invocation works both the implementation ticket and, straight
      // after, the review it queued — this same fake's review always posts.
      // A later invocation finding nothing at all is what proves neither
      // ticket is still eligible.
      await morningLoop(ports);
      const tomorrow = await morningLoop(ports);

      assert.equal(ports.sandbox.runs.length, 1);
      assert.equal(tomorrow.outcome, "dry-queue");
    });

    it("is not opened for a run that committed nothing", async () => {
      const ports = fakePorts();
      ran(ports, { commits: [] });

      const report = await morningLoop(ports);

      assert.deepEqual(ports.repoHost.pullRequests, []);
      assert.equal(pullRequestOf(report.iterations[0]), undefined);
    });

    it("is opened with the run's nits, when it left any", async () => {
      const ports = fakePorts();
      const nits = toNits("- the widget's name is misspelled two lines up");
      const ticket = ran(ports, { nits });

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.pullRequests, [
        {
          directory: `${FakeRepoHost.MANAGED_LOCATION}/${PILOT}`,
          branch: BRANCH,
          ticket,
          nits,
        },
      ]);
    });

    it("is not opened for a run that committed nothing, gist or not", async () => {
      const ports = fakePorts();
      const gist = ticketGist("Add the thing to the widget.");
      ran(ports, { commits: [], gist });

      const report = await morningLoop(ports);

      assert.deepEqual(ports.repoHost.pullRequests, []);
      assert.equal(pullRequestOf(report.iterations[0]), undefined);
    });

    it("leaves the message saying nothing was left behind", async () => {
      const ports = fakePorts();
      ran(ports, { commits: [] });

      const report = await morningLoop(ports);

      // Never the branch: the sandbox keeps no branch for a run that
      // committed nothing, so naming one would send the developer looking
      // for something that was never created.
      assert.match(report.message, /left nothing behind/);
      assert.doesNotMatch(report.message, /issue-7-add-the-thing/);
    });

    it("is not opened for a run the agent did not finish", async () => {
      const ports = fakePorts();
      ran(ports, { failure: "the agent gave up" });

      const report = await morningLoop(ports);

      assert.deepEqual(ports.repoHost.pullRequests, []);
      assert.equal(pullRequestOf(report.iterations[0]), undefined);
    });

    it("names no branch for a failed run, whose commits are discarded", async () => {
      const ports = fakePorts();
      ran(ports, { failure: "the agent gave up" });

      const report = await morningLoop(ports);

      // What became of a failed agent's commits is settled: they are thrown
      // away. Naming the branch would send the developer into the checkout
      // after something that is no longer there — the ticket carries what
      // happened instead.
      assert.doesNotMatch(report.message, /issue-7-add-the-thing/);
      assert.match(report.message, /the agent gave up/);
    });

    it("is not opened on a morning that ran nothing", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);

      const report = await morningLoop(ports);

      assert.deepEqual(ports.repoHost.pullRequests, []);
      assert.equal(pullRequestOf(report.iterations[0]), undefined);
    });

    it("still leaves the project recorded as worked, at what the run cost", async () => {
      const ports = fakePorts();
      ran(ports);
      ports.sandbox.reviewResult = () => ({
        kind: "finished",
        output: "",
        tokensUsed: tokenCount(3_000),
      });

      await morningLoop(ports);

      // Two runs: the implementation, and — since it committed and left a
      // review ticket in the same, otherwise-dry backlog — the review that
      // this same invocation went straight on to work, at its own cost.
      const state = await ports.store.loadState();
      assert.deepEqual(state.projects.get(PILOT), {
        lastWorkedAt: FROZEN_NOW,
        runs: [
          { at: FROZEN_NOW, tokensUsed: tokenCount(42_000) },
          { at: FROZEN_NOW, tokensUsed: tokenCount(3_000) },
        ],
      });
    });

    it("gives a failed iteration naming the pushed branch when it could not be opened, and the invocation goes on", async () => {
      const ports = fakePorts();
      ran(ports);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(8),
        title: "Add the other thing",
      });
      ports.repoHost.draftPullRequest = async () => ({
        kind: "pushed",
        failure: "pull requests are disabled on this repository",
      });

      const report = await morningLoop(ports);

      assert.equal(report.outcome, "work-selected");
      assert.equal(failureOf(report.iterations[0])?.kind, "handover-failed");
      assert.match(report.message, /pull requests are disabled/);
      assert.match(report.message, new RegExp(BRANCH));
      assert.match(ports.tracker.summaries[0]?.body ?? "", new RegExp(BRANCH));
      // The next iteration still ran: #8, after #7's handover failed.
      assert.deepEqual(
        ports.sandbox.runs.map((run) => run.ticket.number),
        [7, 8],
      );
    });

    it("hands the ticket back when it could not be opened, with a comment naming the branch", async () => {
      const ports = fakePorts();
      const ticket = ran(ports);
      ports.repoHost.draftPullRequest = async () => ({
        kind: "pushed",
        failure: "pull requests are disabled on this repository",
      });

      await morningLoop(ports);

      const handback = ports.tracker.handbacks.find(
        (entry) => entry.ticket.number === ticket.number,
      );
      assert.ok(handback, "the implementation ticket should have been handed back");
      assert.match(handback.comment, new RegExp(BRANCH));
      assert.match(handback.comment, /pull requests are disabled/);
      // The branch is the work, so it is kept rather than discarded.
      assert.deepEqual(ports.repoHost.discarded, []);
      const tomorrow = await morningLoop(ports);
      assert.equal(tomorrow.outcome, "dry-queue");
    });

    it("gives a failed iteration naming the branch when the push itself was refused, and leaves the work recorded", async () => {
      const ports = fakePorts();
      const ticket = ran(ports);
      ports.repoHost.draftPullRequest = async () => ({
        kind: "unpushed",
        failure: "the remote rejected the push",
      });

      const report = await morningLoop(ports);

      assert.equal(report.outcome, "work-selected");
      assert.equal(failureOf(report.iterations[0])?.kind, "handover-failed");
      assert.match(report.message, /the remote rejected the push/);
      assert.match(report.message, new RegExp(BRANCH));
      // Never said to be on the host: the branch is only in the checkout.
      const checkoutPath = `${FakeRepoHost.MANAGED_LOCATION}/${PILOT}`;
      assert.match(report.message, /not pushed/);
      assert.match(report.message, new RegExp(checkoutPath));
      // The comment's own wording — naming the branch and checkout — is
      // covered by hand-back.test.ts; here it is enough that the hand back
      // happened, for the ticket this iteration selected.
      assert.equal(ports.tracker.handbacks[0]?.ticket.number, ticket.number);
      const state = await ports.store.loadState();
      assert.deepEqual(state.projects.get(PILOT)?.runs, [
        { at: FROZEN_NOW, tokensUsed: tokenCount(42_000) },
      ]);
    });

    it("says the ticket is still eligible when it could not be opened and the hand-back was refused too", async (t) => {
      const ports = fakePorts();
      ran(ports);
      ports.repoHost.draftPullRequest = async () => ({
        kind: "pushed",
        failure: "pull requests are disabled on this repository",
      });
      t.mock.method(ports.tracker, "handBack", async () => {
        throw new Error("the tracker is unreachable");
      });

      const report = await morningLoop(ports);

      assert.match(report.message, /the tracker is unreachable/);
      assert.match(report.message, /still ready-for-agent/);
      assert.match(report.message, new RegExp(BRANCH));
    });

    describe("a run whose diff touches a uniform file", () => {
      it("opens no draft pull request", async () => {
        const ports = fakePorts();
        ran(ports);
        ports.repoHost.changedPaths = () => ["docs/agents/coding-standards.md"];

        await morningLoop(ports);

        assert.deepEqual(ports.repoHost.pullRequests, []);
      });

      it("leaves the branch unpushed in the checkout, rather than discarding it", async () => {
        const ports = fakePorts();
        ran(ports);
        ports.repoHost.changedPaths = () => ["docs/agents/coding-standards.md"];

        const report = await morningLoop(ports);

        assert.deepEqual(ports.repoHost.discarded, []);
        assert.match(
          ports.tracker.handbacks[0]?.comment ?? "",
          new RegExp(`not pushed.*${FakeRepoHost.MANAGED_LOCATION}/${PILOT}`),
        );
        assert.equal(failureOf(report.iterations[0])?.kind, "uniform-files-touched");
      });

      it("hands the ticket back, with a comment naming the file touched", async () => {
        const ports = fakePorts();
        const ticket = ran(ports);
        ports.repoHost.changedPaths = () => ["docs/agents/coding-standards.md"];

        const report = await morningLoop(ports);

        assert.equal(failureOf(report.iterations[0])?.kind, "uniform-files-touched");
        const handback = ports.tracker.handbacks.find(
          (entry) => entry.ticket.number === ticket.number,
        );
        assert.ok(handback, "the implementation ticket should have been handed back");
        assert.match(handback.comment, /docs\/agents\/coding-standards\.md/);
        assert.equal(ports.tracker.carriesLabel(ticket, "ready-for-human"), true);
      });

      it("opens no draft pull request when the diff touches a uniform file alongside other files", async () => {
        const ports = fakePorts();
        ran(ports);
        ports.repoHost.changedPaths = () => ["src/widget.ts", "docs/agents/coding-standards.md"];

        await morningLoop(ports);

        assert.deepEqual(ports.repoHost.pullRequests, []);
      });

      it("opens no draft pull request when the diff touches a uniform workflow file", async () => {
        const ports = fakePorts();
        ran(ports);
        ports.repoHost.changedPaths = () => [".github/workflows/rebase.yml"];

        const report = await morningLoop(ports);

        assert.deepEqual(ports.repoHost.pullRequests, []);
        assert.equal(failureOf(report.iterations[0])?.kind, "uniform-files-touched");
      });

      it("names every file touched, in UNIFORM_FILES's own order rather than the diff's", async () => {
        const ports = fakePorts();
        const ticket = ran(ports);
        ports.repoHost.changedPaths = () => [
          ".github/workflows/rebase.yml",
          "docs/agents/coding-standards.md",
        ];

        await morningLoop(ports);

        const handback = ports.tracker.handbacks.find(
          (entry) => entry.ticket.number === ticket.number,
        );
        assert.ok(handback, "the implementation ticket should have been handed back");
        assert.match(
          handback.comment,
          /docs\/agents\/coding-standards\.md.*\.github\/workflows\/rebase\.yml/s,
        );
      });

      it("still opens a draft pull request when the diff touches no uniform file", async () => {
        const ports = fakePorts();
        const ticket = ran(ports);
        ports.repoHost.changedPaths = () => ["src/widget.ts"];

        await morningLoop(ports);

        assert.deepEqual(ports.repoHost.pullRequests, [
          {
            directory: `${FakeRepoHost.MANAGED_LOCATION}/${PILOT}`,
            branch: BRANCH,
            ticket,
          },
        ]);
      });

      it("still opens a draft pull request on the manager's own registered project, even when its diff touches a uniform file", async () => {
        const ports = fakePorts();
        ports.store.register(MANAGER, { manager: true });
        const ticket = ports.tracker.addEligibleTicket(MANAGER, {
          number: issueNumber(7),
          title: "Add the thing",
        });
        ports.sandbox.result = () => ({
          kind: "finished",
          branch: BRANCH,
          commits: [commitSha("c0ffee1")],
          output: "",
          tokensUsed: tokenCount(42_000),
        });
        ports.repoHost.changedPaths = () => ["docs/agents/coding-standards.md"];

        await morningLoop(ports);

        assert.deepEqual(ports.repoHost.pullRequests, [
          {
            directory: `${FakeRepoHost.MANAGED_LOCATION}/${MANAGER}`,
            branch: BRANCH,
            ticket,
          },
        ]);
      });

      it("hands the ticket back as a failed handover, rather than crashing the invocation, when its diff cannot be read", async (t) => {
        const ports = fakePorts();
        const ticket = ran(ports);
        t.mock.method(ports.repoHost, "readChangedPaths", async () => {
          throw new Error("fatal: not a git repository");
        });
        ports.tracker.addEligibleTicket(PILOT, {
          number: issueNumber(8),
          title: "Add the other thing",
        });

        const report = await morningLoop(ports);

        assert.equal(report.outcome, "work-selected");
        assert.equal(failureOf(report.iterations[0])?.kind, "handover-failed");
        assert.match(report.message, /fatal: not a git repository/);
        assert.deepEqual(ports.repoHost.pullRequests, []);
        // The branch is kept, unpushed, exactly as any other failed handover's is.
        assert.deepEqual(ports.repoHost.discarded, []);
        assert.equal(ports.tracker.carriesLabel(ticket, "ready-for-human"), true);
        // The next iteration still ran: #8, after #7's diff could not be read.
        assert.deepEqual(
          ports.sandbox.runs.map((run) => run.ticket.number),
          [7, 8],
        );
      });

      it("takes the ticket out of the queue, so a later invocation does not select it again", async () => {
        const ports = fakePorts();
        ran(ports);
        ports.repoHost.changedPaths = () => ["docs/agents/coding-standards.md"];

        await morningLoop(ports);
        const tomorrow = await morningLoop(ports);

        assert.equal(tomorrow.outcome, "dry-queue");
      });
    });

    describe("a blocking discovery", () => {
      function correction(overrides: Partial<Discovery> = {}): Discovery {
        return {
          kind: "correction",
          title: "The ticket names the wrong file",
          body: "It should touch src/widget.ts, not src/gadget.ts.",
          ...overrides,
        };
      }

      it("is discarded, opens no pull request, and hands back the ticket with the correction in a comment", async () => {
        const ports = fakePorts();
        const ticket = ran(ports, { discoveries: [correction()] });

        const report = await morningLoop(ports);

        assert.deepEqual(ports.repoHost.pullRequests, []);
        assert.equal(pullRequestOf(report.iterations[0]), undefined);
        assert.deepEqual(ports.repoHost.discarded, [
          { directory: `${FakeRepoHost.MANAGED_LOCATION}/${PILOT}`, branch: BRANCH },
        ]);
        const handback = ports.tracker.handbacks.find(
          (entry) => entry.ticket.number === ticket.number,
        );
        assert.ok(handback, "the ticket should have been handed back");
        assert.match(handback.comment, /blocking discovery/);
        assert.match(handback.comment, /The ticket names the wrong file/);
        assert.equal(discoveryBlocked(report.iterations[0])?.kind, "discovery-blocked");
      });

      it("still discards and hands back a run the agent would otherwise have finished, even though it committed", async () => {
        const ports = fakePorts();
        ran(ports, { discoveries: [correction()], commits: [commitSha("c0ffee1")] });

        await morningLoop(ports);

        assert.deepEqual(ports.repoHost.pullRequests, []);
      });

      it("hands back a run that gave up as a blocking discovery, not as a gave-up run", async () => {
        const ports = fakePorts();
        const ticket = ran(ports, {
          failure: "the tests would not go green",
          discoveries: [correction()],
        });

        await morningLoop(ports);

        const handback = ports.tracker.handbacks.find(
          (entry) => entry.ticket.number === ticket.number,
        );
        assert.match(handback?.comment ?? "", /blocking discovery/);
        assert.doesNotMatch(handback?.comment ?? "", /the agent gave up/);
      });

      it("proceeds exactly as normal for a clarification or a suggestion, filing them on the target", async () => {
        const ports = fakePorts();
        ran(ports, {
          discoveries: [
            { kind: "clarification", title: "What 'the thing' means", body: "Read as the button." },
            { kind: "suggestion", title: "Worth a retry", body: "Consider retrying on failure." },
          ],
        });

        const report = await morningLoop(ports);

        assert.equal(pullRequestOf(report.iterations[0]), FakeRepoHost.RUN_PULL_REQUEST);
        assert.equal(ports.tracker.comments.length, 1);
        assert.equal(ports.tracker.discoveredTickets.length, 1);
        const finished = report.iterations[0];
        assert.equal(finished?.kind, "finished");
        assert.equal(
          finished?.kind === "finished" ? finished.discoveryReport?.routing.filed.length : undefined,
          2,
        );
      });

      it("blocks the ticket on an existing open issue directly, keeping it ready-for-agent rather than opening a pull request or handing it back", async () => {
        const ports = fakePorts();
        const blocker = ports.tracker.addIneligibleTicket(PILOT, {
          number: issueNumber(9),
          title: "The widget port",
        });
        const ticket = ran(ports, {
          discoveries: [
            {
              kind: "prerequisite",
              title: "Needs the widget port first",
              body: `There is no widget port yet.\n\nBlocked on: #${blocker.number}.`,
            },
          ],
        });

        const report = await morningLoop(ports);

        assert.deepEqual(ports.repoHost.pullRequests, []);
        assert.equal(ports.tracker.discoveredTickets.length, 0);
        assert.equal(report.iterations[0]?.kind, "blocked-on-existing");
        assert.equal(ports.tracker.carriesLabel(ticket, READY_FOR_AGENT_LABEL), true);
        assert.equal(
          ports.tracker.handbacks.some((entry) => entry.ticket.number === ticket.number),
          false,
        );
        const comment = ports.tracker.comments.find(
          (entry) => entry.ticket.number === ticket.number,
        );
        assert.match(comment?.comment ?? "", /Blocked on nadav-alon\/pilot#9 until it closes\./);
        assert.doesNotMatch(comment?.comment ?? "", /blocking discovery/);
      });

      it("discards the branch of a run blocked on an existing issue, even though it committed", async () => {
        const ports = fakePorts();
        ports.tracker.addIneligibleTicket(PILOT, { number: issueNumber(9), title: "The widget port" });
        ran(ports, {
          commits: [commitSha("c0ffee1")],
          discoveries: [
            {
              kind: "prerequisite",
              title: "Needs the widget port first",
              body: "Blocked on: #9.",
            },
          ],
        });

        const report = await morningLoop(ports);

        assert.equal(blockedOnExisting(report.iterations[0])?.discard.kind, "discarded");
      });

      it("files only the first of two suggestions, reporting one dropped", async () => {
        const ports = fakePorts();
        ran(ports, {
          discoveries: [
            { kind: "suggestion", title: "First", body: "..." },
            { kind: "suggestion", title: "Second", body: "..." },
          ],
        });

        const report = await morningLoop(ports);

        assert.equal(ports.tracker.discoveredTickets.length, 1);
        assert.equal(ports.tracker.discoveredTickets[0]?.title, "First");
        const finished = report.iterations[0];
        assert.equal(
          finished?.kind === "finished" ? finished.discoveryReport?.routing.suggestionsDropped : undefined,
          1,
        );
      });

      it("reports a refused tracker write without losing the rest", async (t) => {
        const ports = fakePorts();
        let calls = 0;
        t.mock.method(ports.tracker, "comment", async () => {
          calls += 1;
          if (calls === 1) {
            throw new Error("the tracker refused the comment");
          }
        });
        ran(ports, {
          discoveries: [
            { kind: "clarification", title: "First", body: "..." },
            { kind: "clarification", title: "Second", body: "..." },
          ],
        });

        const report = await morningLoop(ports);

        const finished = report.iterations[0];
        const routing =
          finished?.kind === "finished" ? finished.discoveryReport?.routing : undefined;
        assert.equal(routing?.refused.length, 1);
        assert.match(routing?.refused[0]?.reason ?? "", /refused the comment/);
        assert.equal(routing?.filed.length, 1);
      });

      it("still hands the ticket back for a blocking discovery the tracker refused to comment", async (t) => {
        const ports = fakePorts();
        const ticket = ran(ports, { discoveries: [correction()] });
        t.mock.method(ports.tracker, "comment", async () => {
          throw new Error("the tracker refused the comment");
        });

        await morningLoop(ports);

        assert.deepEqual(ports.repoHost.pullRequests, []);
        const handback = ports.tracker.handbacks.find(
          (entry) => entry.ticket.number === ticket.number,
        );
        assert.ok(handback, "the ticket should have been handed back");
        assert.match(handback.comment, /blocking discovery/);
      });

      it("carries how many files the run dropped through onto the finished iteration's own routing", async () => {
        const ports = fakePorts();
        ran(ports, {
          discoveries: [{ kind: "clarification", title: "First", body: "..." }],
          discoveriesDropped: 2,
        });

        const report = await morningLoop(ports);

        const finished = report.iterations[0];
        assert.equal(
          finished?.kind === "finished" ? finished.discoveryReport?.routing.discoveriesDropped : undefined,
          2,
        );
      });

      it("names no target on an implementation run's own discovery-blocked iteration, whose target is its own ticket", async () => {
        const ports = fakePorts();
        ran(ports, { discoveries: [correction()] });

        const report = await morningLoop(ports);

        assert.equal(discoveryBlocked(report.iterations[0])?.discoveryReport.crossTarget, undefined);
      });
    });
  });

  describe("the review ticket", () => {
    /** A run that did the work: commits on a branch, against ticket #7. */
    function ranSuccessfully(ports: FakePorts): Ticket {
      ports.store.register(PILOT);
      const ticket = ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      ports.sandbox.result = () => ({
        kind: "finished",
        branch: branch("issue-7-add-the-thing"),
        commits: [commitSha("c0ffee1")],
        output: "",
        tokensUsed: tokenCount(42_000),
      });
      return ticket;
    }

    it("is opened against the ticket the run worked, naming its pull request", async () => {
      const ports = fakePorts();
      const ticket = ranSuccessfully(ports);

      await morningLoop(ports);

      assert.deepEqual(
        ports.tracker.reviewTickets.map((review) => ({
          parent: review.parent,
          pullRequest: review.pullRequest,
        })),
        [{ parent: ticket, pullRequest: FakeRepoHost.RUN_PULL_REQUEST }],
      );
    });

    it("is opened by the loop rather than asked of the agent, and only once", async (t) => {
      const ports = fakePorts();
      ranSuccessfully(ports);
      // The agent is handed the ticket and nothing else: whatever it did or
      // failed to do in the sandbox, the review is the loop's to open.
      //
      // One implementation run, and one review — a review ticket's own run,
      // this same invocation goes straight on to work since nothing else was
      // eligible — but only one review ticket, since a review does not earn a
      // review of its own.
      const run = t.mock.method(ports.sandbox, "run");
      const review = t.mock.method(ports.sandbox, "review");

      await morningLoop(ports);

      assert.equal(run.mock.callCount(), 1);
      assert.equal(review.mock.callCount(), 1);
      assert.equal(ports.tracker.reviewTickets.length, 1);
    });

    it("is opened only once the pull request it names exists", async (t) => {
      const ports = fakePorts();
      ranSuccessfully(ports);
      const order: string[] = [];
      t.mock.method(ports.repoHost, "openDraftPullRequest", async () => {
        order.push("pull request");
        return {
          kind: "opened" as const,
          pullRequest: FakeRepoHost.RUN_PULL_REQUEST,
        };
      });
      t.mock.method(ports.tracker, "createReviewTicket", async () => {
        order.push("review ticket");
        return { repo: PILOT, number: issueNumber(8), title: "Review" };
      });

      await morningLoop(ports);

      assert.deepEqual(order, ["pull request", "review ticket"]);
    });

    it("takes the ticket it reviews out of the queue, once its review is queued beside it", async () => {
      const ports = fakePorts();
      const ticket = ranSuccessfully(ports);

      await morningLoop(ports);

      // Handed back rather than left eligible: a review is queued beside the
      // ticket that earned it, and the ticket itself goes to the developer,
      // so a later morning does not select it again — closing the review
      // ticket stays the developer's, separately.
      const { tickets: backlog } = backlogIn(await ports.tracker.listOpenIssues(PILOT));
      assert.ok(!backlog.some((eligible) => eligible.number === ticket.number));
      assert.equal(ports.tracker.handbacks[0]?.ticket.number, ticket.number);
    });

    it("is reported, so the developer is told the review is queued", async () => {
      const ports = fakePorts();
      ranSuccessfully(ports);

      const report = await morningLoop(ports);

      const review = ports.tracker.reviewTickets[0]?.ticket;
      assert.deepEqual(reviewTicketOf(report.iterations[0]), review);
      // In the line as well as the field: the message is the whole of what a
      // trigger prints, so a review only the field knows about is a review
      // nobody is told is waiting.
      assert.match(report.message, new RegExp(`#${review?.number}`));
    });

    it("is not opened for a run that committed nothing", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      ports.sandbox.result = () => ({
        kind: "finished",
        branch: branch("issue-7-add-the-thing"),
        commits: [],
        output: "the agent gave up",
        tokensUsed: tokenCount(42_000),
      });

      const report = await morningLoop(ports);

      // Nothing was opened, so there is nothing to review.
      assert.deepEqual(ports.tracker.reviewTickets, []);
      assert.equal(reviewTicketOf(report.iterations[0]), undefined);
    });

    it("is still queued when an overlapping run closed the implementation ticket before its own hand-back", async () => {
      const ports = fakePorts();
      const ticket = ranSuccessfully(ports);
      ports.sandbox.result = () => {
        // Stands in for an overlapping run finishing first: by the time this
        // run's own hand-back reaches the tracker, the ticket it worked is
        // already closed — the pull request and its review are real all the
        // same, so the hand-back finding nothing to do must not take them
        // down with it.
        ports.tracker.closeOutOfBand(ticket);
        return {
          kind: "finished",
          branch: branch("issue-7-add-the-thing"),
          commits: [commitSha("c0ffee1")],
          output: "",
          tokensUsed: tokenCount(42_000),
        };
      };

      const report = await morningLoop(ports);

      const review = ports.tracker.reviewTickets[0]?.ticket;
      assert.deepEqual(reviewTicketOf(report.iterations[0]), review);
      // The implementation ticket itself was never handed back — only its
      // review, which this same invocation goes on to work, is: the fake
      // sandbox's own default review posts no finding.
      assert.equal(
        ports.tracker.handbacks.some((handback) => handback.ticket.number === ticket.number),
        false,
      );
      assert.equal(finished(report.iterations[0])?.handedBack.outcome, "already-closed");
    });

    it("is not opened on a morning that ran nothing", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);

      const report = await morningLoop(ports);

      assert.deepEqual(ports.tracker.reviewTickets, []);
      assert.equal(reviewTicketOf(report.iterations[0]), undefined);
    });

    it("gives a failed iteration naming the draft pull request when it could not be created, and the invocation goes on", async (t) => {
      const ports = fakePorts();
      ranSuccessfully(ports);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(8),
        title: "Add the other thing",
      });
      t.mock.method(ports.tracker, "createReviewTicket", async () => {
        throw new Error("issues are disabled on this repository");
      });

      const report = await morningLoop(ports);

      assert.equal(report.outcome, "work-selected");
      assert.equal(failureOf(report.iterations[0])?.kind, "handover-failed");
      assert.match(report.message, /issues are disabled/);
      assert.match(report.message, new RegExp(FakeRepoHost.RUN_PULL_REQUEST));
      assert.deepEqual(
        ports.sandbox.runs.map((run) => run.ticket.number),
        [7, 8],
      );
      const state = await ports.store.loadState();
      assert.deepEqual(state.projects.get(PILOT)?.runs, [
        { at: FROZEN_NOW, tokensUsed: tokenCount(42_000) },
        { at: FROZEN_NOW, tokensUsed: tokenCount(42_000) },
      ]);
    });

    it("hands the ticket back when it could not be created, with a comment naming the draft pull request", async (t) => {
      const ports = fakePorts();
      const ticket = ranSuccessfully(ports);
      t.mock.method(ports.tracker, "createReviewTicket", async () => {
        throw new Error("issues are disabled on this repository");
      });

      await morningLoop(ports);

      const handback = ports.tracker.handbacks.find(
        (entry) => entry.ticket.number === ticket.number,
      );
      assert.ok(handback, "the implementation ticket should have been handed back");
      assert.match(
        handback.comment,
        new RegExp(FakeRepoHost.RUN_PULL_REQUEST),
      );
      const { tickets: backlog } = backlogIn(await ports.tracker.listOpenIssues(PILOT));
      assert.deepEqual(backlog, []);
    });
  });

  describe("a review ticket, selected", () => {
    it("runs a reviewing agent rather than an implementing one", async (t) => {
      const ports = fakePorts();
      queued(ports);
      const run = t.mock.method(ports.sandbox, "run");
      const review = t.mock.method(ports.sandbox, "review");

      await morningLoop(ports);

      assert.equal(run.mock.callCount(), 0);
      assert.equal(review.mock.callCount(), 1);
    });

    it("passes the review ticket and the project checkout to the sandbox", async () => {
      const ports = fakePorts();
      const ticket = queued(ports);

      await morningLoop(ports);

      assert.deepEqual(ports.sandbox.reviews, [
        {
          ticket,
          checkout: `${FakeRepoHost.MANAGED_LOCATION}/${PILOT}`,
          spendCeiling: DEFAULT_BUDGET.spendCeiling,
        },
      ]);
    });

    it("closes the review ticket once it finished", async () => {
      const ports = fakePorts();
      const ticket = queued(ports);
      postedAFinding(ports);

      await morningLoop(ports);

      assert.deepEqual(ports.tracker.closedReviewTickets, [ticket]);
      const { tickets: backlog } = backlogIn(await ports.tracker.listOpenIssues(PILOT));
      assert.deepEqual(backlog, []);
    });

    it("labels the pull request reviewed once the ticket closes", async () => {
      const ports = fakePorts();
      queued(ports);
      postedAFinding(ports);

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.labelled, [
        { pullRequest: PULL_REQUEST, label: REVIEWED_LABEL },
      ]);
    });

    it("reports a refused label without reopening the review ticket", async (t) => {
      const ports = fakePorts();
      const ticket = queued(ports);
      postedAFinding(ports);
      t.mock.method(ports.repoHost, "labelPullRequest", async () => {
        throw new Error("label does not exist");
      });

      const report = await morningLoop(ports);

      assert.deepEqual(ports.tracker.closedReviewTickets, [ticket]);
      const outcome = report.iterations[0];
      assert.equal(outcome?.kind, "reviewed");
      assert.equal(
        outcome?.kind === "reviewed" ? outcome.notLabelled?.error : undefined,
        "label does not exist",
      );
      assert.equal(
        outcome?.kind === "reviewed" ? outcome.notClosed : undefined,
        undefined,
      );
    });

    describe("turbo", () => {
      it("posts the apply-review comment once a turbo project's review ticket closes", async () => {
        const ports = fakePorts();
        queued(ports, { turbo: true });
        postedAFinding(ports);

        await morningLoop(ports);

        assert.deepEqual(ports.repoHost.comments, [
          { pullRequest: PULL_REQUEST, body: APPLY_REVIEW_COMMENT },
        ]);
      });

      it("posts nothing for a project that is not turbo", async () => {
        const ports = fakePorts();
        queued(ports);
        postedAFinding(ports);

        await morningLoop(ports);

        assert.deepEqual(ports.repoHost.comments, []);
      });

      it("posts the comment even when the reviewed label failed", async (t) => {
        const ports = fakePorts();
        queued(ports, { turbo: true });
        postedAFinding(ports);
        t.mock.method(ports.repoHost, "labelPullRequest", async () => {
          throw new Error("label does not exist");
        });

        await morningLoop(ports);

        assert.deepEqual(ports.repoHost.comments, [
          { pullRequest: PULL_REQUEST, body: APPLY_REVIEW_COMMENT },
        ]);
      });

      it("posts no comment when the review ticket could not be closed", async (t) => {
        const ports = fakePorts();
        queued(ports, { turbo: true });
        postedAFinding(ports);
        t.mock.method(ports.tracker, "closeReviewTicket", async () => {
          throw new Error("issue is locked");
        });

        await morningLoop(ports);

        assert.deepEqual(ports.repoHost.comments, []);
      });

      it("reports a refused comment without reopening the review ticket", async (t) => {
        const ports = fakePorts();
        const ticket = queued(ports, { turbo: true });
        postedAFinding(ports);
        t.mock.method(ports.repoHost, "postComment", async () => {
          throw new Error("pull request is locked");
        });

        const report = await morningLoop(ports);

        assert.deepEqual(ports.tracker.closedReviewTickets, [ticket]);
        const outcome = report.iterations[0];
        assert.equal(outcome?.kind, "reviewed");
        assert.equal(
          outcome?.kind === "reviewed" ? outcome.notCommented?.error : undefined,
          "pull request is locked",
        );
        assert.equal(
          outcome?.kind === "reviewed" ? outcome.notClosed : undefined,
          undefined,
        );
        assert.match(report.message, /pull request is locked/);
      });
    });

    describe("a clean review", () => {
      it("closes the ticket, labels the pull request reviewed, and marks it ready for review", async () => {
        const ports = fakePorts();
        const ticket = queued(ports);
        postedACleanReview(ports);

        await morningLoop(ports);

        assert.deepEqual(ports.tracker.closedReviewTickets, [ticket]);
        assert.deepEqual(ports.repoHost.labelled, [
          { pullRequest: PULL_REQUEST, label: REVIEWED_LABEL },
        ]);
        assert.deepEqual(ports.repoHost.readyMarked, [PULL_REQUEST]);
        assert.deepEqual(ports.repoHost.comments, []);
      });

      it("checks the pull request for a posted review, having found no finding on it", async () => {
        const ports = fakePorts();
        queued(ports);
        postedACleanReview(ports);

        await morningLoop(ports);

        assert.deepEqual(ports.repoHost.findingChecks, [
          { pullRequest: PULL_REQUEST, since: FROZEN_NOW },
        ]);
        assert.deepEqual(ports.repoHost.reviewChecks, [
          { pullRequest: PULL_REQUEST, since: FROZEN_NOW },
        ]);
      });

      it("never checks for a posted review once a finding is already found", async () => {
        const ports = fakePorts();
        queued(ports);
        postedAFinding(ports);

        await morningLoop(ports);

        assert.deepEqual(ports.repoHost.reviewChecks, []);
      });

      it("posts no /apply-review comment for a turbo project, since there is nothing to apply", async () => {
        const ports = fakePorts();
        queued(ports, { turbo: true });
        postedACleanReview(ports);

        await morningLoop(ports);

        assert.deepEqual(ports.repoHost.comments, []);
      });

      it("reports a refused ready-mark without reopening the ticket", async (t) => {
        const ports = fakePorts();
        const ticket = queued(ports);
        postedACleanReview(ports);
        t.mock.method(ports.repoHost, "markPullRequestReady", async () => {
          throw new Error("pull request is locked");
        });

        const report = await morningLoop(ports);

        assert.deepEqual(ports.tracker.closedReviewTickets, [ticket]);
        const outcome = report.iterations[0];
        assert.equal(outcome?.kind, "reviewed");
        assert.equal(
          outcome?.kind === "reviewed" ? outcome.notReadied?.error : undefined,
          "pull request is locked",
        );
        assert.equal(
          outcome?.kind === "reviewed" ? outcome.notClosed : undefined,
          undefined,
        );
        assert.match(report.message, /pull request is locked/);
      });

      it("leaves a review with findings a draft, never marking it ready", async () => {
        const ports = fakePorts();
        queued(ports);
        postedAFinding(ports);

        await morningLoop(ports);

        assert.deepEqual(ports.repoHost.readyMarked, []);
      });

      describe("the merge gate", () => {
        const IMPLEMENTATION = issueNumber(7);
        const RUN_STARTED = new Date(FROZEN_NOW.getTime() - 3_600_000);
        const RUN_ENDED = new Date(FROZEN_NOW.getTime() - 1_800_000);
        const GRANTED_IN_TIME = new Date(RUN_STARTED.getTime() - 60_000);

        /**
         * A turbo project's implementation ticket #7, turboable before its
         * own run started, and the review ticket its pull request already
         * carries, linked to it as a sub-issue — the merge gate's own
         * precondition for even asking. As `queuedTurboable` in the
         * apply-review describe above, but for a review ticket.
         */
        function queuedTurboableReview(
          ports: FakePorts,
          { turbo = true, grantedAt = GRANTED_IN_TIME } = {},
        ): Ticket {
          ports.store.register(PILOT, { turbo });
          const implementation = ports.tracker.addEligibleTicket(PILOT, {
            number: IMPLEMENTATION,
            title: "Add the thing",
          });
          ports.store.markRunSpan(implementation, RUN_STARTED, RUN_ENDED);
          ports.tracker.recordTurboableEvent(implementation, "labeled", grantedAt);
          ports.tracker.addEligibleTicket(PILOT, {
            number: issueNumber(42),
            title: "Review the draft pull request for #7",
            pullRequest: { kind: "review", url: PULL_REQUEST },
            parent: IMPLEMENTATION,
          });
          return implementation;
        }

        it("merges the pull request with a merge commit once a turboable ticket's review comes back clean", async () => {
          const ports = fakePorts();
          const implementation = queuedTurboableReview(ports);
          postedACleanReview(ports);

          const report = await morningLoop(ports);

          assert.deepEqual(ports.repoHost.merged, [PULL_REQUEST]);
          const outcome = report.iterations[0];
          assert.equal(outcome?.kind, "reviewed");
          assert.deepEqual(
            outcome?.kind === "reviewed" ? outcome.merge : undefined,
            { kind: "merged", implementationTicket: implementation },
          );
          assert.deepEqual(
            ports.repoHost.labelled.filter(
              (labelled) => labelled.label === READY_FOR_HUMAN_PULL_REQUEST_LABEL,
            ),
            [],
          );
        });

        it("labels the pull request ready-for-human instead of merging when the repo host refuses the merge, reporting rather than raising it", async (t) => {
          const ports = fakePorts();
          queuedTurboableReview(ports);
          postedACleanReview(ports);
          t.mock.method(ports.repoHost, "mergePullRequest", async () => {
            throw new Error("Pull Request is not mergeable");
          });

          const report = await morningLoop(ports);

          assert.deepEqual(ports.repoHost.merged, []);
          assert.deepEqual(
            ports.repoHost.labelled.filter(
              (labelled) => labelled.label === READY_FOR_HUMAN_PULL_REQUEST_LABEL,
            ),
            [{ pullRequest: PULL_REQUEST, label: READY_FOR_HUMAN_PULL_REQUEST_LABEL }],
          );
          const outcome = report.iterations[0];
          assert.deepEqual(
            outcome?.kind === "reviewed" ? outcome.merge : undefined,
            { kind: "left-for-human", reason: "Pull Request is not mergeable" },
          );
        });

        it("labels the pull request ready-for-human without attempting a merge when the pull request still carries a declined thread", async () => {
          const ports = fakePorts();
          queuedTurboableReview(ports);
          postedACleanReview(ports);
          ports.repoHost.openApplyReviewThread(PULL_REQUEST);
          ports.repoHost.answerApplyReviewThread(
            PULL_REQUEST,
            0,
            "declined",
            "out of scope",
            new Date(FROZEN_NOW.getTime() - 120_000),
          );

          const report = await morningLoop(ports);

          assert.deepEqual(ports.repoHost.merged, []);
          assert.deepEqual(
            ports.repoHost.labelled.filter(
              (labelled) => labelled.label === READY_FOR_HUMAN_PULL_REQUEST_LABEL,
            ),
            [{ pullRequest: PULL_REQUEST, label: READY_FOR_HUMAN_PULL_REQUEST_LABEL }],
          );
          const outcome = report.iterations[0];
          assert.deepEqual(
            outcome?.kind === "reviewed" ? outcome.merge : undefined,
            { kind: "left-for-human", reason: "1 declined thread" },
          );
        });

        it("never merges when the implementation ticket was not turboable before its own run started", async () => {
          const ports = fakePorts();
          queuedTurboableReview(ports, {
            grantedAt: new Date(RUN_STARTED.getTime() + 60_000),
          });
          postedACleanReview(ports);

          const report = await morningLoop(ports);

          assert.deepEqual(ports.repoHost.merged, []);
          const outcome = report.iterations[0];
          assert.deepEqual(
            outcome?.kind === "reviewed" ? outcome.merge : undefined,
            {
              kind: "not-turboable",
              reason: "not turboable before its own run started",
              declinedGrant: true,
            },
          );
        });

        it("never merges, naming the run span rather than the timeline, when the grant falls inside another ticket's run span in the same repo", async () => {
          const ports = fakePorts();
          queuedTurboableReview(ports);
          ports.store.markRunSpan(
            { repo: PILOT, number: issueNumber(99) },
            new Date(GRANTED_IN_TIME.getTime() - 60_000),
            new Date(GRANTED_IN_TIME.getTime() + 60_000),
          );
          postedACleanReview(ports);

          const report = await morningLoop(ports);

          assert.deepEqual(ports.repoHost.merged, []);
          const outcome = report.iterations[0];
          assert.deepEqual(
            outcome?.kind === "reviewed" ? outcome.merge : undefined,
            { kind: "not-turboable", reason: "turboable granted inside a run span", declinedGrant: true },
          );
        });

        it("merges once the only span covering the grant was left open by a dead invocation, now read as ended at its own start", async () => {
          const ports = fakePorts();
          const implementation = queuedTurboableReview(ports);
          const DEAD: OpenInvocation = {
            openedAt: new Date(GRANTED_IN_TIME.getTime() - 3_600_000),
            process: processId(4242),
          };
          await ports.store.openInvocation(DEAD);
          ports.store.markRunSpan(
            { repo: PILOT, number: issueNumber(99) },
            new Date(GRANTED_IN_TIME.getTime() - 60_000),
            undefined,
            DEAD,
          );
          const SELF: OpenInvocation = { openedAt: FROZEN_NOW, process: processId(5555) };
          await ports.store.openInvocation(SELF);
          postedACleanReview(ports);

          const report = await morningLoop(ports, { invocation: SELF });

          assert.deepEqual(ports.repoHost.merged, [PULL_REQUEST]);
          const outcome = report.iterations[0];
          assert.deepEqual(
            outcome?.kind === "reviewed" ? outcome.merge : undefined,
            { kind: "merged", implementationTicket: implementation },
          );
        });

        it("still rejects a grant landing exactly at a crash-left-open span's own start — inclusive bounds", async () => {
          const ports = fakePorts();
          const deadStarted = new Date(RUN_STARTED.getTime() - 120_000);
          queuedTurboableReview(ports, { grantedAt: deadStarted });
          const DEAD: OpenInvocation = {
            openedAt: new Date(deadStarted.getTime() - 3_600_000),
            process: processId(4242),
          };
          await ports.store.openInvocation(DEAD);
          ports.store.markRunSpan(
            { repo: PILOT, number: issueNumber(99) },
            deadStarted,
            undefined,
            DEAD,
          );
          const SELF: OpenInvocation = { openedAt: FROZEN_NOW, process: processId(5555) };
          await ports.store.openInvocation(SELF);
          postedACleanReview(ports);

          const report = await morningLoop(ports, { invocation: SELF });

          assert.deepEqual(ports.repoHost.merged, []);
          const outcome = report.iterations[0];
          assert.deepEqual(
            outcome?.kind === "reviewed" ? outcome.merge : undefined,
            { kind: "not-turboable", reason: "turboable granted inside a run span", declinedGrant: true },
          );
        });

        it("never merges on a project that is not turbo, whatever the implementation ticket carries", async () => {
          const ports = fakePorts();
          queuedTurboableReview(ports, { turbo: false });
          postedACleanReview(ports);

          const report = await morningLoop(ports);

          assert.deepEqual(ports.repoHost.merged, []);
          assert.deepEqual(ports.repoHost.readyMarked, [PULL_REQUEST]);
          const outcome = report.iterations[0];
          assert.equal(
            outcome?.kind === "reviewed" ? outcome.merge : undefined,
            undefined,
          );
        });

        it("never asks the gate for a review that comes back with findings, even on a turbo project", async () => {
          const ports = fakePorts();
          queuedTurboableReview(ports);
          postedAFinding(ports);

          const report = await morningLoop(ports);

          assert.deepEqual(ports.repoHost.merged, []);
          const outcome = report.iterations[0];
          assert.equal(
            outcome?.kind === "reviewed" ? outcome.merge : undefined,
            undefined,
          );
          assert.deepEqual(ports.repoHost.comments, [
            { pullRequest: PULL_REQUEST, body: APPLY_REVIEW_COMMENT },
          ]);
        });

        it("closes the ticket as not-turboable, rather than raising, when the implementation ticket lookup fails", async (t) => {
          const ports = fakePorts();
          queuedTurboableReview(ports);
          postedACleanReview(ports);
          let calls = 0;
          const original = ports.tracker.listOpenIssues.bind(ports.tracker);
          t.mock.method(
            ports.tracker,
            "listOpenIssues",
            async (...args: Parameters<typeof original>) => {
              calls++;
              if (calls > 1) {
                throw new Error("tracker unavailable");
              }
              return original(...args);
            },
          );

          const report = await morningLoop(ports);

          assert.deepEqual(ports.repoHost.merged, []);
          const outcome = report.iterations[0];
          assert.equal(outcome?.kind, "reviewed");
          assert.deepEqual(ports.tracker.closedReviewTickets.length, 1);
          assert.deepEqual(
            outcome?.kind === "reviewed" ? outcome.merge : undefined,
            {
              kind: "not-turboable",
              reason: "could not find its implementation ticket",
              declinedGrant: false,
            },
          );
        });

        it("closes the ticket as timeline-unreadable, rather than raising, when reading its turboable timeline fails", async (t) => {
          const ports = fakePorts();
          queuedTurboableReview(ports);
          postedACleanReview(ports);
          t.mock.method(ports.tracker, "wasTurboableAt", async () => {
            throw new Error("tracker unavailable");
          });

          const report = await morningLoop(ports);

          assert.deepEqual(ports.repoHost.merged, []);
          assert.deepEqual(
            ports.repoHost.labelled.filter(
              (labelled) => labelled.label === READY_FOR_HUMAN_PULL_REQUEST_LABEL,
            ),
            [],
          );
          const outcome = report.iterations[0];
          assert.equal(outcome?.kind, "reviewed");
          assert.deepEqual(ports.tracker.closedReviewTickets.length, 1);
          assert.deepEqual(
            outcome?.kind === "reviewed" ? outcome.merge : undefined,
            { kind: "timeline-unreadable", error: "tracker unavailable" },
          );
        });

        it("labels the pull request ready-for-human instead of merging when its checks are still running", async () => {
          const ports = fakePorts();
          queuedTurboableReview(ports);
          postedACleanReview(ports);
          ports.repoHost.checksStatus = () => "pending";

          const report = await morningLoop(ports);

          assert.deepEqual(ports.repoHost.merged, []);
          assert.deepEqual(
            ports.repoHost.labelled.filter(
              (labelled) => labelled.label === READY_FOR_HUMAN_PULL_REQUEST_LABEL,
            ),
            [{ pullRequest: PULL_REQUEST, label: READY_FOR_HUMAN_PULL_REQUEST_LABEL }],
          );
          const outcome = report.iterations[0];
          assert.deepEqual(
            outcome?.kind === "reviewed" ? outcome.merge : undefined,
            { kind: "left-for-human", reason: "checks still running" },
          );
        });

        it("labels the pull request ready-for-human, reporting rather than raising, when reading its declined threads fails", async (t) => {
          const ports = fakePorts();
          queuedTurboableReview(ports);
          postedACleanReview(ports);
          t.mock.method(ports.repoHost, "readApplyReviewAnswers", async () => {
            throw new Error("thread read unavailable");
          });

          const report = await morningLoop(ports);

          assert.deepEqual(ports.repoHost.merged, []);
          assert.deepEqual(
            ports.repoHost.labelled.filter(
              (labelled) => labelled.label === READY_FOR_HUMAN_PULL_REQUEST_LABEL,
            ),
            [{ pullRequest: PULL_REQUEST, label: READY_FOR_HUMAN_PULL_REQUEST_LABEL }],
          );
          const outcome = report.iterations[0];
          assert.deepEqual(
            outcome?.kind === "reviewed" ? outcome.merge : undefined,
            { kind: "left-for-human", reason: "thread read unavailable" },
          );
        });
      });
    });

    it("adds no label when the review ticket cannot be closed", async (t) => {
      const ports = fakePorts();
      queued(ports);
      postedAFinding(ports);
      t.mock.method(ports.tracker, "closeReviewTicket", async () => {
        throw new Error("issue is locked");
      });

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.labelled, []);
    });

    it("adds no label to a review whose agent gave up", async () => {
      const ports = fakePorts();
      queued(ports);
      ports.sandbox.reviewResult = () => ({
        kind: "gave-up",
        output: "I could not read the diff",
        tokensUsed: tokenCount(1_000),
        reason: "the review skill exited 1",
      });

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.labelled, []);
    });

    it("adds no label to a review the provider limit refused", async () => {
      const ports = fakePorts();
      queued(ports);
      ports.sandbox.reviewResult = () => ({
        kind: "limit-refused",
        words: LIMIT_REFUSAL,
        tokensUsed: tokenCount(0),
      });

      const report = await morningLoop(ports);

      assert.equal(report.iterations[0]?.kind, "limit-refused");
      assert.deepEqual(ports.repoHost.labelled, []);
    });

    it("hands back a review whose agent gave up, rather than leaving it to come round again", async () => {
      const ports = fakePorts();
      const ticket = queued(ports);
      ports.sandbox.reviewResult = () => ({
        kind: "gave-up",
        output: "I could not read the diff",
        tokensUsed: tokenCount(1_000),
        reason: "the review skill exited 1",
      });

      const report = await morningLoop(ports);
      const tomorrow = await morningLoop(ports);

      assert.equal(failureOf(report.iterations[0])?.kind, "gave-up");
      assert.equal(handedBackOf(report.iterations[0]), "handed-back");
      assert.deepEqual(ports.tracker.closedReviewTickets, []);
      // The comment's own wording is covered by hand-back.test.ts; here it is
      // enough that the hand back happened, for the ticket this iteration
      // selected.
      const [handback] = ports.tracker.handbacks;
      assert.equal(handback?.ticket.number, ticket.number);
      assert.equal(ports.sandbox.reviews.length, 1);
      assert.equal(tomorrow.outcome, "dry-queue");
    });

    it("leaves a review ticket alone when an overlapping run closed it before this one gave up", async () => {
      const ports = fakePorts();
      const ticket = queued(ports);
      ports.sandbox.reviewResult = () => {
        // Stands in for an overlapping run finishing first: by the time this
        // run's own agent gives up, the ticket it was working is already
        // closed.
        ports.tracker.closeOutOfBand(ticket);
        return {
          kind: "gave-up",
          output: "I could not read the diff",
          tokensUsed: tokenCount(1_000),
          reason: "the review skill exited 1",
        };
      };

      const report = await morningLoop(ports);

      assert.equal(failureOf(report.iterations[0])?.kind, "gave-up");
      assert.equal(handedBackOf(report.iterations[0]), "already-closed");
      assert.deepEqual(ports.tracker.handbacks, []);
      assert.equal(
        ports.tracker.carriesLabel(ticket, READY_FOR_HUMAN_LABEL),
        false,
      );
      const [summary] = ports.tracker.summaries;
      assert.ok(summary);
      assert.doesNotMatch(summary.body, /Waiting on you/);
    });

    it("hands back a review whose agent finished but posted nothing, naming the pull request", async () => {
      const ports = fakePorts();
      const ticket = queued(ports);
      // The sandbox process exited clean, but its own last step — posting the
      // aggregated report — never landed on the pull request, so the fake
      // has no finding recorded for it.

      const report = await morningLoop(ports);

      assert.equal(failureOf(report.iterations[0])?.kind, "gave-up");
      assert.deepEqual(ports.tracker.closedReviewTickets, []);
      const [handback] = ports.tracker.handbacks;
      assert.equal(handback?.ticket.number, ticket.number);
      assert.match(handback.comment, /posted nothing/);
      assert.ok(handback.comment.includes(PULL_REQUEST));
      const { tickets: backlog } = backlogIn(await ports.tracker.listOpenIssues(PILOT));
      assert.deepEqual(backlog, []);
    });

    it("records what a review that gave up cost", async () => {
      const ports = fakePorts();
      queued(ports);
      ports.sandbox.reviewResult = () => ({
        kind: "gave-up",
        output: "",
        tokensUsed: tokenCount(3_000),
        reason: "the review skill exited 1",
      });

      await morningLoop(ports);

      const state = await ports.store.loadState();
      assert.deepEqual(state.projects.get(PILOT)?.runs, [
        { at: FROZEN_NOW, tokensUsed: tokenCount(3_000) },
      ]);
    });

    it("carries the review's transcript into the failed iteration, rather than dropping it with the rest of the outcome", async () => {
      const ports = fakePorts();
      queued(ports);
      const transcript = transcriptPath("/home/node/.claude/projects/-repo/session.jsonl");
      ports.sandbox.reviewResult = () => ({
        kind: "gave-up",
        output: "I could not read the diff",
        tokensUsed: tokenCount(1_000),
        reason: "the review skill exited 1",
        transcript,
      });

      const report = await morningLoop(ports);

      const iteration = report.iterations[0];
      assert.equal(
        iteration?.kind === "failed" ? iteration.transcript : undefined,
        transcript,
      );
    });

    it("names the review's transcript in the hand-back comment, when it left one", async () => {
      const ports = fakePorts();
      queued(ports);
      const transcript = transcriptPath("/home/node/.claude/projects/-repo/session.jsonl");
      ports.sandbox.reviewResult = () => ({
        kind: "gave-up",
        output: "I could not read the diff",
        tokensUsed: tokenCount(1_000),
        reason: "the review skill exited 1",
        transcript,
      });

      await morningLoop(ports);

      assert.match(
        ports.tracker.handbacks[0]?.comment ?? "",
        endsWithTranscript(transcript),
      );
    });

    it("says a review's hand-back itself failed, leaving the ticket for the developer to relabel", async (t) => {
      const ports = fakePorts();
      queued(ports);
      t.mock.method(ports.tracker, "handBack", async () => {
        throw new Error("gh is not logged in");
      });

      const report = await morningLoop(ports);

      assert.equal(handedBackOf(report.iterations[0]), "refused");
      assert.match(report.message, /gh is not logged in/);
      assert.match(report.message, /relabel it yourself/);
    });

    it("reports a review whose pull request cannot be checked for its findings, rather than raising it", async (t) => {
      const ports = fakePorts();
      const ticket = queued(ports);
      ports.tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
      ports.sandbox.reviewResult = () => ({
        kind: "finished",
        output: "posted findings",
        tokensUsed: tokenCount(9_000),
      });
      t.mock.method(ports.repoHost, "hasReviewFindings", async () => {
        throw new Error("gh api rate limited");
      });

      const report = await morningLoop(ports);

      assert.notEqual(report.outcome, "invocation-failed");
      assert.deepEqual(
        report.iterations.map((iteration) => [iteration.ticket.number, iteration.kind]),
        [
          [ticket.number, "reviewed"],
          [7, "finished"],
        ],
      );
      assert.match(report.message, /gh api rate limited/);
      assert.deepEqual(ports.tracker.closedReviewTickets, []);
      assert.deepEqual(ports.tracker.handbacks.map((h) => h.ticket.number), [7]);
      assert.deepEqual(ports.repoHost.labelled, []);
      const body = ports.tracker.summaries[0]?.body ?? "";
      const waiting = body.slice(body.indexOf("## Waiting on you"));
      assert.match(waiting, new RegExp(`pilot#${ticket.number}`));
      const state = await ports.store.loadState();
      assert.deepEqual(state.projects.get(PILOT)?.runs[0], {
        at: FROZEN_NOW,
        tokensUsed: tokenCount(9_000),
      });
    });

    it("reports a clean review whose pull request cannot be checked for a posted review, rather than raising it", async (t) => {
      const ports = fakePorts();
      const ticket = queued(ports);
      ports.tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
      ports.sandbox.reviewResult = () => ({
        kind: "finished",
        output: "found nothing to flag",
        tokensUsed: tokenCount(9_000),
      });
      t.mock.method(ports.repoHost, "hasPostedReview", async () => {
        throw new Error("gh api rate limited");
      });

      const report = await morningLoop(ports);

      assert.notEqual(report.outcome, "invocation-failed");
      assert.deepEqual(
        report.iterations.map((iteration) => [iteration.ticket.number, iteration.kind]),
        [
          [ticket.number, "reviewed"],
          [7, "finished"],
        ],
      );
      assert.match(report.message, /gh api rate limited/);
      assert.deepEqual(ports.tracker.closedReviewTickets, []);
      assert.deepEqual(ports.tracker.handbacks.map((h) => h.ticket.number), [7]);
      assert.deepEqual(ports.repoHost.labelled, []);
      assert.deepEqual(ports.repoHost.readyMarked, []);
    });

    it("reports a review ticket that cannot be closed, rather than raising it", async (t) => {
      const ports = fakePorts();
      const ticket = queued(ports);
      postedAFinding(ports);
      t.mock.method(ports.tracker, "closeReviewTicket", async () => {
        throw new Error("issue is locked");
      });

      const report = await morningLoop(ports);

      assert.equal(report.outcome, "work-selected");
      assert.equal(report.iterations[0]?.kind, "reviewed");
      assert.match(report.message, /issue is locked/);
      assert.match(report.message, /close it yourself/);
      const body = ports.tracker.summaries[0]?.body ?? "";
      assert.match(
        body,
        new RegExp(`## Waiting on you[\\s\\S]*pilot#${ticket.number}`),
      );
    });

    it("carries on past a review whose sandbox breaks, as an infrastructure failure that leaves the review open", async (t) => {
      const ports = fakePorts();
      const ticket = queued(ports);
      ports.tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
      t.mock.method(ports.sandbox, "review", async () => {
        throw new Error("docker is not running");
      });

      const report = await morningLoop(ports);

      assert.deepEqual(
        report.iterations.map((iteration) => [iteration.ticket.number, iteration.kind]),
        [
          [ticket.number, "failed"],
          [7, "finished"],
        ],
      );
      assert.equal(failureOf(report.iterations[0])?.kind, "infrastructure");
      assert.ok(
        ports.tracker.handbacks.every((h) => h.ticket.number !== ticket.number),
      );
    });

    it("carries on past a review whose checkout cannot be made, as an infrastructure failure that leaves the review open", async (t) => {
      const ports = fakePorts();
      const ticket = queued(ports);
      ports.tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
      const clone = ports.repoHost.clone.bind(ports.repoHost);
      let clones = 0;
      t.mock.method(ports.repoHost, "clone", async (repo: typeof PILOT) => {
        clones += 1;
        if (clones === 1) {
          throw new Error("no such remote");
        }
        return clone(repo);
      });

      const report = await morningLoop(ports);

      assert.deepEqual(
        report.iterations.map((iteration) => [iteration.ticket.number, iteration.kind]),
        [
          [ticket.number, "failed"],
          [7, "finished"],
        ],
      );
      assert.equal(failureOf(report.iterations[0])?.kind, "infrastructure");
      assert.equal(ports.sandbox.reviews.length, 0);
      assert.ok(
        ports.tracker.handbacks.every((h) => h.ticket.number !== ticket.number),
      );
    });

    it("tells a review that gave up apart from one whose sandbox broke, in the summary", async (t) => {
      const gaveUp = fakePorts();
      const ticket = queued(gaveUp);
      gaveUp.sandbox.reviewResult = () => ({
        kind: "gave-up",
        output: "",
        tokensUsed: tokenCount(1_000),
        reason: "the review skill exited 1",
      });
      const broke = fakePorts();
      queued(broke);
      t.mock.method(broke.sandbox, "review", async () => {
        throw new Error("docker is not running");
      });

      await morningLoop(gaveUp);
      await morningLoop(broke);

      const gaveUpBody = gaveUp.tracker.summaries[0]?.body ?? "";
      const brokeBody = broke.tracker.summaries[0]?.body ?? "";
      const which = `${PILOT}#${ticket.number}`;
      assert.match(gaveUpBody, new RegExp(`gave up on ${which}`));
      assert.match(gaveUpBody, new RegExp(`${which}: relabelled ready-for-human`));
      assert.doesNotMatch(gaveUpBody, /fix the setup/);
      assert.match(
        brokeBody,
        new RegExp(`${which}: still ready-for-agent — the sandbox or checkout failed`),
      );
      assert.doesNotMatch(brokeBody, /gave up/);
    });

    it("checks the pull request for findings posted no earlier than when the review started", async () => {
      const ports = fakePorts();
      queued(ports);

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.findingChecks, [
        { pullRequest: PULL_REQUEST, since: FROZEN_NOW },
      ]);
    });

    it("is reported with nothing posted, when the agent ran but no finding ever landed", async () => {
      const ports = fakePorts();
      queued(ports);

      const report = await morningLoop(ports);

      assert.match(report.message, /posted nothing/i);
    });

    it("opens no pull request and queues no further review", async () => {
      const ports = fakePorts();
      queued(ports);

      const report = await morningLoop(ports);

      assert.equal(ports.repoHost.pullRequests.length, 0);
      assert.equal(ports.tracker.reviewTickets.length, 0);
      assert.equal(pullRequestOf(report.iterations[0]), undefined);
      assert.equal(reviewTicketOf(report.iterations[0]), undefined);
    });

    it("records what the review cost", async () => {
      const ports = fakePorts();
      queued(ports);
      ports.sandbox.reviewResult = () => ({
        kind: "finished",
        output: "posted findings",
        tokensUsed: tokenCount(9_000),
      });

      await morningLoop(ports);

      const state = await ports.store.loadState();
      assert.deepEqual(state.projects.get(PILOT)?.runs, [
        { at: FROZEN_NOW, tokensUsed: tokenCount(9_000) },
      ]);
    });

    it("is reported as reviewed, naming the pull request findings were posted to", async () => {
      const ports = fakePorts();
      queued(ports);
      postedAFinding(ports);

      const report = await morningLoop(ports);

      assert.equal(report.outcome, "work-selected");
      assert.match(report.message, /Reviewed nadav-alon\/pilot#42/);
      assert.match(report.message, new RegExp(PULL_REQUEST.replace(/\//g, "\\/")));
    });

    it("is reported with the agent's failure, when the review did not finish", async () => {
      const ports = fakePorts();
      const ticket = queued(ports);
      ports.sandbox.reviewResult = () => ({
        kind: "gave-up",
        output: "the agent gave up",
        tokensUsed: tokenCount(1_000),
        reason: "the agent gave up",
      });

      const report = await morningLoop(ports);

      assert.match(
        report.message,
        new RegExp(`the agent gave up on ${PILOT}#${ticket.number}: the agent gave up`, "i"),
      );
    });

    it("closes a review ticket whose pull request is already merged, without running anything", async () => {
      const ports = fakePorts();
      const ticket = queued(ports);
      ports.repoHost.setPullRequestState(PULL_REQUEST, "merged");

      const report = await morningLoop(ports);

      assert.equal(ports.sandbox.reviews.length, 0);
      assert.equal(ports.repoHost.clones.length, 0);
      assert.equal(report.iterations[0]?.kind, "pull-request-resolved");
      assert.deepEqual(ports.tracker.closedReviewTickets, [ticket]);
      const [closed] = ports.tracker.closedReviewTicketComments;
      assert.deepEqual(closed?.ticket, ticket);
      assert.match(closed?.comment ?? "", /already been merged/);
      assert.match(report.message, /already merged/);
      const body = ports.tracker.summaries[0]?.body ?? "";
      assert.doesNotMatch(body, /## Waiting on you/);
    });

    it("closes a review ticket whose pull request is closed without merging, without running anything", async () => {
      const ports = fakePorts();
      const ticket = queued(ports);
      ports.repoHost.setPullRequestState(PULL_REQUEST, "closed");

      const report = await morningLoop(ports);

      assert.equal(ports.sandbox.reviews.length, 0);
      assert.equal(report.iterations[0]?.kind, "pull-request-resolved");
      assert.deepEqual(ports.tracker.closedReviewTickets, [ticket]);
      const [closed] = ports.tracker.closedReviewTicketComments;
      assert.deepEqual(closed?.ticket, ticket);
      assert.match(closed?.comment ?? "", /closed without merging/);
      assert.match(report.message, /closed without merging/);
    });

    it("reports a resolved review ticket that cannot be closed, rather than raising it", async (t) => {
      const ports = fakePorts();
      const ticket = queued(ports);
      ports.repoHost.setPullRequestState(PULL_REQUEST, "merged");
      t.mock.method(ports.tracker, "closeReviewTicket", async () => {
        throw new Error("issue is locked");
      });

      const report = await morningLoop(ports);

      assert.equal(report.iterations[0]?.kind, "pull-request-resolved");
      assert.match(report.message, /issue is locked/);
      assert.match(report.message, /close it yourself/);
      const body = ports.tracker.summaries[0]?.body ?? "";
      assert.match(
        body,
        new RegExp(`## Waiting on you[\\s\\S]*pilot#${ticket.number}`),
      );
    });

    describe("a blocking discovery", () => {
      it("opens a discovered ticket that blocks the implementation ticket, and hands back the review ticket, not the implementation ticket", async () => {
        const ports = fakePorts();
        const { implementation, pullRequestTicket: review } = queuedWithImplementation(
          ports,
          "review",
        );
        postedAFinding(ports);
        ports.sandbox.reviewResult = () => ({
          kind: "finished",
          output: "",
          tokensUsed: tokenCount(1_000),
          discoveries: [
            {
              kind: "prerequisite",
              title: "Needs the widget port first",
              body: "There is no widget port to review against yet.",
            },
          ],
        });

        const report = await morningLoop(ports);

        assert.equal(ports.tracker.discoveredTickets.length, 1);
        assert.equal(ports.tracker.discoveredTickets[0]?.blocking, true);
        assert.deepEqual(ports.tracker.closedReviewTickets, []);
        const handback = ports.tracker.handbacks[0];
        assert.equal(handback?.ticket.number, review.number);
        assert.notEqual(handback?.ticket.number, implementation.number);
        assert.match(handback?.comment ?? "", /implementation ticket, nadav-alon\/pilot#7/);
        assert.equal(report.iterations[0]?.kind, "discovery-blocked");
      });

      it("blocks the implementation ticket on an existing open issue directly, closing the review ticket normally rather than handing anything back", async () => {
        const ports = fakePorts();
        const { implementation, pullRequestTicket: review } = queuedWithImplementation(
          ports,
          "review",
        );
        const blocker = ports.tracker.addIneligibleTicket(PILOT, {
          number: issueNumber(9),
          title: "The widget port",
        });
        postedAFinding(ports);
        ports.sandbox.reviewResult = () => ({
          kind: "finished",
          output: "",
          tokensUsed: tokenCount(1_000),
          discoveries: [
            {
              kind: "prerequisite",
              title: "Needs the widget port first",
              body: `There is no widget port yet.\n\nBlocked on: #${blocker.number}.`,
            },
          ],
        });

        const report = await morningLoop(ports);

        assert.equal(ports.tracker.discoveredTickets.length, 0);
        assert.deepEqual(
          ports.tracker.closedReviewTickets.map((ticket) => ticket.number),
          [review.number],
        );
        assert.equal(
          ports.tracker.handbacks.some((entry) => entry.ticket.number === implementation.number),
          false,
        );
        assert.equal(ports.tracker.carriesLabel(implementation, READY_FOR_AGENT_LABEL), true);
        const comment = ports.tracker.comments.find(
          (entry) => entry.ticket.number === implementation.number,
        );
        assert.match(comment?.comment ?? "", /Blocked on nadav-alon\/pilot#9 until it closes\./);
        assert.equal(report.iterations[0]?.kind, "reviewed");
      });

      it("hands back the review ticket for a gave-up run that also filed a correction, not as a gave-up run", async () => {
        const ports = fakePorts();
        const { pullRequestTicket: review } = queuedWithImplementation(ports, "review");
        ports.sandbox.reviewResult = () => ({
          kind: "gave-up",
          output: "I could not tell what to review",
          reason: "the diff made no sense",
          tokensUsed: tokenCount(1_000),
          discoveries: [
            {
              kind: "correction",
              title: "The ticket names the wrong file",
              body: "It should touch src/widget.ts.",
            },
          ],
        });

        await morningLoop(ports);

        const handback = ports.tracker.handbacks.find(
          (entry) => entry.ticket.number === review.number,
        );
        assert.match(handback?.comment ?? "", /blocking discovery/);
        assert.doesNotMatch(handback?.comment ?? "", /the agent gave up/);
      });

      it("proceeds as normal for a clarification or a suggestion, filing them on the implementation ticket and naming it as the reviewed iteration's target", async () => {
        const ports = fakePorts();
        const { implementation } = queuedWithImplementation(ports, "review");
        postedAFinding(ports);
        ports.sandbox.reviewResult = () => ({
          kind: "finished",
          output: "",
          tokensUsed: tokenCount(1_000),
          discoveries: [
            { kind: "clarification", title: "What #7 means", body: "Read as the button." },
          ],
        });

        const report = await morningLoop(ports);

        assert.equal(ports.tracker.comments.length, 1);
        assert.equal(ports.tracker.comments[0]?.ticket.number, issueNumber(7));
        assert.deepEqual(
          ports.tracker.closedReviewTickets.map((ticket) => ticket.number),
          [issueNumber(42)],
        );
        const [iteration] = report.iterations;
        assert.equal(iteration?.kind, "reviewed");
        assert.equal(
          iteration?.kind === "reviewed" ? iteration.discoveryReport?.crossTarget?.number : undefined,
          implementation.number,
        );
      });
    });
  });

  describe("a spec review ticket, selected", () => {
    it("runs a spec-reviewing agent rather than an implementing one", async (t) => {
      const ports = fakePorts();
      queuedSpecReview(ports);
      const run = t.mock.method(ports.sandbox, "run");
      const specReview = t.mock.method(ports.sandbox, "specReview");

      await morningLoop(ports);

      assert.equal(run.mock.callCount(), 0);
      assert.equal(specReview.mock.callCount(), 1);
    });

    it("passes the spec review ticket and the project checkout to the sandbox", async () => {
      const ports = fakePorts();
      const ticket = queuedSpecReview(ports);

      await morningLoop(ports);

      assert.deepEqual(ports.sandbox.specReviews, [
        {
          // `queuedSpecReview` hands back the raw ticket `addSpecReviewTicket`
          // stored, before `specReview` is folded in from its label — the way
          // `listOpenIssues` reads it back for selection.
          ticket: { ...ticket, specReview: true },
          checkout: `${FakeRepoHost.MANAGED_LOCATION}/${PILOT}`,
          spendCeiling: DEFAULT_BUDGET.spendCeiling,
        },
      ]);
    });

    it("hands the ticket back with its own findings as the comment, once it finishes", async () => {
      const ports = fakePorts();
      const ticket = queuedSpecReview(ports);
      ports.sandbox.specReviewResult = () => ({
        kind: "finished",
        output: "the retry-policy sub-issue never landed the change the spec described",
        tokensUsed: tokenCount(9_000),
      });

      const report = await morningLoop(ports);
      const tomorrow = await morningLoop(ports);

      const outcome = report.iterations[0];
      assert.equal(outcome?.kind, "spec-reviewed");
      assert.equal(
        outcome?.kind === "spec-reviewed" ? outcome.handedBack.outcome : undefined,
        "handed-back",
      );
      const [handback] = ports.tracker.handbacks;
      assert.equal(handback?.ticket.number, ticket.number);
      assert.match(
        handback?.comment ?? "",
        /the retry-policy sub-issue never landed the change the spec described/,
      );
      assert.equal(
        ports.tracker.carriesLabel(ticket, READY_FOR_HUMAN_LABEL),
        true,
      );
      assert.equal(tomorrow.outcome, "dry-queue");
    });

    it("hands back a spec review whose agent gave up, rather than leaving it to come round again", async () => {
      const ports = fakePorts();
      const ticket = queuedSpecReview(ports);
      ports.sandbox.specReviewResult = () => ({
        kind: "gave-up",
        output: "could not find a parent issue",
        tokensUsed: tokenCount(1_000),
        reason: "no supertask to review against",
      });

      const report = await morningLoop(ports);
      const tomorrow = await morningLoop(ports);

      assert.equal(failureOf(report.iterations[0])?.kind, "gave-up");
      assert.equal(handedBackOf(report.iterations[0]), "handed-back");
      const [handback] = ports.tracker.handbacks;
      assert.equal(handback?.ticket.number, ticket.number);
      assert.equal(ports.sandbox.specReviews.length, 1);
      assert.equal(tomorrow.outcome, "dry-queue");
    });

    it("records what a spec review run cost", async () => {
      const ports = fakePorts();
      queuedSpecReview(ports);
      ports.sandbox.specReviewResult = () => ({
        kind: "finished",
        output: "no drift found",
        tokensUsed: tokenCount(3_000),
      });

      await morningLoop(ports);

      const state = await ports.store.loadState();
      assert.deepEqual(state.projects.get(PILOT)?.runs, [
        { at: FROZEN_NOW, tokensUsed: tokenCount(3_000) },
      ]);
    });

    it("hands back a spec review the agent CLI refused the model for, rather than leaving it to come round again", async () => {
      const ports = fakePorts();
      const ticket = queuedSpecReview(ports);
      ports.tracker.addLabel(ticket, "model:this-model-does-not-exist-xyz");
      ports.sandbox.specReviewResult = () => ({
        kind: "model-refused",
        refusal: {
          model: modelName("this-model-does-not-exist-xyz"),
          words: "unrecognised model",
        },
        tokensUsed: tokenCount(0),
      });

      const report = await morningLoop(ports);

      assert.equal(failureOf(report.iterations[0])?.kind, "model-refused");
      assert.equal(handedBackOf(report.iterations[0]), "handed-back");
    });

    it("leaves a spec review ticket untouched when the provider limit refuses it, standing the invocation down", async () => {
      const ports = fakePorts();
      queuedSpecReview(ports);
      ports.sandbox.specReviewResult = () => ({
        kind: "limit-refused",
        words: LIMIT_REFUSAL,
        tokensUsed: tokenCount(0),
      });

      const report = await morningLoop(ports);

      assert.equal(report.iterations[0]?.kind, "limit-refused");
      assert.deepEqual(ports.tracker.handbacks, []);
      assert.equal(report.standDown?.reason, "provider-limit");
    });

    describe("a blocking discovery", () => {
      it("opens a discovered ticket that blocks the supertask, and hands back the spec review ticket, not the supertask", async () => {
        const ports = fakePorts();
        const { supertask, specReview } = await queuedSpecReviewWithSupertask(ports);
        ports.sandbox.specReviewResult = () => ({
          kind: "finished",
          output: "DRIFT REPORT: the retry policy never landed",
          tokensUsed: tokenCount(1_000),
          discoveries: [
            {
              kind: "prerequisite",
              title: "Needs the retry-policy sub-issue done first",
              body: "The spec cannot be reviewed until #48 lands.",
            },
          ],
        });

        const report = await morningLoop(ports);

        assert.equal(ports.tracker.discoveredTickets.length, 1);
        assert.equal(ports.tracker.discoveredTickets[0]?.blocking, true);
        const handback = ports.tracker.handbacks[0];
        assert.equal(handback?.ticket.number, specReview.number);
        assert.notEqual(handback?.ticket.number, supertask.number);
        assert.match(handback?.comment ?? "", /supertask, nadav-alon\/pilot#50/);
        assert.match(handback?.comment ?? "", /DRIFT REPORT/);
        assert.equal(report.iterations[0]?.kind, "discovery-blocked");
      });

      it("hands the spec review ticket back for a blocking discovery a refused spec review filed, not the supertask, and still stands down", async () => {
        const ports = fakePorts();
        const { supertask, specReview } = await queuedSpecReviewWithSupertask(ports);
        ports.sandbox.specReviewResult = () => ({
          kind: "limit-refused",
          words: LIMIT_REFUSAL,
          tokensUsed: tokenCount(0),
          discoveries: [
            {
              kind: "correction",
              title: "The supertask names the wrong repo",
              body: "It should review the pilot repo, not this one.",
            },
          ],
        });

        const report = await morningLoop(ports);

        assert.equal(report.iterations[0]?.kind, "discovery-blocked");
        assert.deepEqual(
          report.iterations[0]?.kind === "discovery-blocked" ? report.iterations[0].cutOff : undefined,
          { kind: "limit-refused", limitRefusal: LIMIT_REFUSAL },
        );
        const handback = ports.tracker.handbacks[0];
        assert.equal(handback?.ticket.number, specReview.number);
        assert.notEqual(handback?.ticket.number, supertask.number);
        assert.match(handback?.comment ?? "", /blocking discovery/);
        const { tickets: backlog } = backlogIn(await ports.tracker.listOpenIssues(PILOT));
        assert.ok(!backlog.some((ticket) => ticket.number === specReview.number));
        assert.ok(report.standDown?.reason === "provider-limit");
        assert.equal(report.standDown.ticket.number, specReview.number);
        assert.ok(report.standDown.handedBack);
      });

      it("hands the spec review ticket back for a blocking discovery a provider-failed spec review filed, and still stands down", async () => {
        const ports = fakePorts();
        const { supertask, specReview } = await queuedSpecReviewWithSupertask(ports);
        ports.sandbox.specReviewResult = () => ({
          kind: "provider-failed",
          words: PROVIDER_FAILURE_PROSE,
          tokensUsed: tokenCount(0),
          discoveries: [
            {
              kind: "prerequisite",
              title: "Needs the retry-policy sub-issue done first",
              body: "The spec cannot be reviewed until #48 lands.",
            },
          ],
        });

        const report = await morningLoop(ports);

        assert.equal(report.iterations[0]?.kind, "discovery-blocked");
        assert.deepEqual(
          report.iterations[0]?.kind === "discovery-blocked" ? report.iterations[0].cutOff : undefined,
          { kind: "provider-failed", providerFailure: PROVIDER_FAILURE_PROSE },
        );
        const handback = ports.tracker.handbacks[0];
        assert.equal(handback?.ticket.number, specReview.number);
        assert.notEqual(handback?.ticket.number, supertask.number);
        assert.match(handback?.comment ?? "", /blocking discovery/);
        const { tickets: backlog } = backlogIn(await ports.tracker.listOpenIssues(PILOT));
        assert.ok(!backlog.some((ticket) => ticket.number === specReview.number));
        assert.ok(report.standDown?.reason === "provider-failure");
        assert.equal(report.standDown.ticket.number, specReview.number);
        assert.ok(report.standDown.handedBack);
      });

      it("still routes a cut-off spec review's advisory discoveries onto the supertask, without handing either back", async () => {
        const ports = fakePorts();
        const { supertask, specReview } = await queuedSpecReviewWithSupertask(ports);
        ports.sandbox.specReviewResult = () => ({
          kind: "limit-refused",
          words: LIMIT_REFUSAL,
          tokensUsed: tokenCount(0),
          discoveries: [
            {
              kind: "clarification",
              title: "What #50 means",
              body: "Read as covering every sub-issue.",
            },
          ],
        });

        const report = await morningLoop(ports);

        assert.equal(report.iterations[0]?.kind, "limit-refused");
        assert.equal(ports.tracker.comments.length, 1);
        assert.equal(ports.tracker.comments[0]?.ticket.number, supertask.number);
        assert.deepEqual(ports.tracker.handbacks, []);
        const { tickets: backlog } = backlogIn(await ports.tracker.listOpenIssues(PILOT));
        assert.ok(backlog.some((ticket) => ticket.number === specReview.number));
        const limitRefusedIteration = report.iterations[0];
        assert.equal(
          limitRefusedIteration?.kind === "limit-refused"
            ? limitRefusedIteration.discoveryReport?.routing.filed.length
            : undefined,
          1,
        );
      });

      it("hands back the spec review for a gave-up run that also filed a correction, not as a gave-up run", async () => {
        const ports = fakePorts();
        const { specReview } = await queuedSpecReviewWithSupertask(ports);
        ports.sandbox.specReviewResult = () => ({
          kind: "gave-up",
          output: "I could not tell what to review",
          reason: "the checkout had no history",
          tokensUsed: tokenCount(1_000),
          discoveries: [
            {
              kind: "correction",
              title: "The supertask names the wrong repo",
              body: "It should review the pilot repo, not this one.",
            },
          ],
        });

        await morningLoop(ports);

        const handback = ports.tracker.handbacks.find(
          (entry) => entry.ticket.number === specReview.number,
        );
        assert.match(handback?.comment ?? "", /blocking discovery/);
        assert.doesNotMatch(handback?.comment ?? "", /the agent gave up/);
      });

      it("proceeds as normal for a clarification or a suggestion, filing them on the supertask and naming it as the spec-reviewed iteration's target", async () => {
        const ports = fakePorts();
        const { supertask } = await queuedSpecReviewWithSupertask(ports);
        ports.sandbox.specReviewResult = () => ({
          kind: "finished",
          output: "no drift found",
          tokensUsed: tokenCount(1_000),
          discoveries: [
            {
              kind: "clarification",
              title: "What #50 means",
              body: "Read as covering every sub-issue.",
            },
          ],
        });

        const report = await morningLoop(ports);

        assert.equal(ports.tracker.comments.length, 1);
        assert.equal(ports.tracker.comments[0]?.ticket.number, supertask.number);
        const [iteration] = report.iterations;
        assert.equal(iteration?.kind, "spec-reviewed");
        assert.equal(
          iteration?.kind === "spec-reviewed" ? iteration.discoveryReport?.crossTarget?.number : undefined,
          supertask.number,
        );
      });
    });
  });

  describe("an apply-review ticket, selected", () => {
    const PULL_REQUEST = pullRequestUrl(
      "https://github.com/nadav-alon/pilot/pull/12",
    );
    /** When the run's replies land: after it started, as every real one does. */
    const DURING_THE_RUN = new Date(FROZEN_NOW.getTime() + 60_000);

    /**
     * An apply-review ticket, eligible like any other, on a pull request with
     * `threads` open threads.
     */
    function queued(ports: FakePorts, threads = 1): ApplyReviewTicket {
      ports.store.register(PILOT);
      for (let opened = 0; opened < threads; opened++) {
        ports.repoHost.openApplyReviewThread(PULL_REQUEST);
      }
      return ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(43),
        title: "Apply the review on the draft pull request for #7",
        pullRequest: { kind: "apply-review", url: PULL_REQUEST },
      }) as ApplyReviewTicket;
    }

    /** A run that answers thread 0, 1, … with `verdicts` in turn, as the skill does, and finishes. */
    function answering(
      ports: FakePorts,
      verdicts: ("applied" | "declined")[],
      tokensUsed = tokenCount(0),
    ): void {
      ports.sandbox.applyReviewResult = () => {
        verdicts.forEach((verdict, index) => {
          ports.repoHost.answerApplyReviewThread(
            PULL_REQUEST,
            index,
            verdict,
            "the reason",
            DURING_THE_RUN,
          );
        });
        return { kind: "finished", output: "answered", tokensUsed };
      };
    }

    function waitingOn(ports: FakePorts): string {
      const body = ports.tracker.summaries[0]?.body ?? "";
      const at = body.indexOf("## Waiting on you");
      return at === -1 ? "" : body.slice(at);
    }

    it("runs the apply-review agent on the ticket and the project checkout, rather than an implementing or reviewing one", async () => {
      const ports = fakePorts();
      const ticket = queued(ports);
      answering(ports, ["applied"]);

      await morningLoop(ports);

      assert.deepEqual(ports.sandbox.applyReviews, [
        {
          ticket,
          checkout: `${FakeRepoHost.MANAGED_LOCATION}/${PILOT}`,
          spendCeiling: DEFAULT_BUDGET.spendCeiling,
        },
      ]);
      assert.equal(ports.sandbox.runs.length, 0);
      assert.equal(ports.sandbox.reviews.length, 0);
    });

    it("closes a finished run's ticket and marks its pull request ready, opening nothing and queueing no review", async () => {
      const ports = fakePorts();
      const ticket = queued(ports, 2);
      answering(ports, ["applied", "declined"]);

      const report = await morningLoop(ports);

      assert.equal(report.iterations[0]?.kind, "applied-review");
      assert.deepEqual(
        ports.tracker.closedApplyReviewTickets.map((closed) => closed.ticket),
        [ticket],
      );
      assert.deepEqual(ports.repoHost.readyMarked, [PULL_REQUEST]);
      assert.deepEqual(ports.tracker.handbacks, []);
      assert.equal(ports.repoHost.pullRequests.length, 0);
      assert.equal(ports.repoHost.discarded.length, 0);
      assert.equal(ports.tracker.reviewTickets.length, 0);
      const { tickets: backlog } = backlogIn(
        await ports.tracker.listOpenIssues(PILOT),
      );
      assert.deepEqual(backlog, []);
    });

    it("labels the pull request applied-review once a finished run's ticket closes", async () => {
      const ports = fakePorts();
      queued(ports, 1);
      answering(ports, ["applied"]);

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.labelled, [
        { pullRequest: PULL_REQUEST, label: APPLIED_REVIEW_LABEL },
      ]);
    });

    it("marks the pull request ready even when every thread was declined", async () => {
      const ports = fakePorts();
      queued(ports, 1);
      answering(ports, ["declined"]);

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.readyMarked, [PULL_REQUEST]);
      assert.equal(ports.tracker.closedApplyReviewTickets.length, 1);
    });

    it("closes the ticket with a comment naming the pull request and what was applied and declined", async () => {
      const ports = fakePorts();
      queued(ports, 2);
      answering(ports, ["applied", "declined"]);

      await morningLoop(ports);

      const comment = ports.tracker.closedApplyReviewTickets[0]?.comment ?? "";
      assert.ok(comment.includes(PULL_REQUEST));
      assert.match(comment, /1 applied, 1 declined/);
      assert.match(comment, /ready for review/);
    });

    it("counts only the replies the run posted, not an earlier pass's", async () => {
      const ports = fakePorts();
      queued(ports, 2);
      ports.repoHost.answerApplyReviewThread(
        PULL_REQUEST,
        0,
        "applied",
        "an earlier pass",
        new Date(FROZEN_NOW.getTime() - 60_000),
      );
      ports.sandbox.applyReviewResult = () => {
        ports.repoHost.answerApplyReviewThread(
          PULL_REQUEST,
          1,
          "declined",
          "the reason",
          DURING_THE_RUN,
        );
        return { kind: "finished", output: "", tokensUsed: tokenCount(0) };
      };

      const report = await morningLoop(ports);

      assert.match(report.message, /0 applied, 1 declined/);
    });

    it("closes a ticket whose pull request has no open thread without running anything, saying so, and marks it ready", async () => {
      const ports = fakePorts();
      const ticket = queued(ports, 0);

      const report = await morningLoop(ports);

      assert.equal(ports.sandbox.applyReviews.length, 0);
      assert.equal(report.iterations[0]?.kind, "applied-review");
      const [closed] = ports.tracker.closedApplyReviewTickets;
      assert.deepEqual(closed?.ticket, ticket);
      assert.match(closed?.comment ?? "", /nothing left to apply/i);
      assert.deepEqual(ports.repoHost.readyMarked, [PULL_REQUEST]);
      assert.equal(ports.repoHost.clones.length, 0);
      const state = await ports.store.loadState();
      assert.equal(state.projects.get(PILOT), undefined);
      assert.match(report.message, /nothing left to apply/i);
    });

    it("labels the pull request applied-review when no thread was open, so nothing ran", async () => {
      const ports = fakePorts();
      queued(ports, 0);

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.labelled, [
        { pullRequest: PULL_REQUEST, label: APPLIED_REVIEW_LABEL },
      ]);
    });

    it("hands back a finished run that left a thread unanswered, leaving the pull request a draft", async () => {
      const ports = fakePorts();
      const ticket = queued(ports, 2);
      answering(ports, ["applied"]);

      const report = await morningLoop(ports);
      const tomorrow = await morningLoop(ports);

      assert.equal(failureOf(report.iterations[0])?.kind, "gave-up");
      assert.equal(handedBackOf(report.iterations[0]), "handed-back");
      const [handback] = ports.tracker.handbacks;
      assert.equal(handback?.ticket.number, ticket.number);
      assert.match(handback?.comment ?? "", /1 thread left unanswered/);
      assert.ok(handback?.comment.includes(PULL_REQUEST));
      assert.deepEqual(ports.repoHost.readyMarked, []);
      assert.deepEqual(ports.tracker.closedApplyReviewTickets, []);
      assert.equal(tomorrow.outcome, "dry-queue");
    });

    it("adds no label to an apply-review whose agent gave up", async () => {
      const ports = fakePorts();
      queued(ports, 2);
      answering(ports, ["applied"]);

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.labelled, []);
    });

    it("hands back a run whose push was rejected because the branch moved, naming the moved head", async () => {
      const ports = fakePorts();
      const ticket = queued(ports);
      const moved = commitSha("a1".repeat(20));
      ports.sandbox.applyReviewResult = () => ({
        kind: "gave-up",
        output: `Branch moved: ${moved}`,
        reason: `The push was rejected: the pull request's branch had moved to ${moved}.`,
        movedHead: moved,
        tokensUsed: tokenCount(2_000),
      });

      const report = await morningLoop(ports);

      assert.equal(failureOf(report.iterations[0])?.kind, "gave-up");
      const [handback] = ports.tracker.handbacks;
      assert.equal(handback?.ticket.number, ticket.number);
      assert.match(handback?.comment ?? "", new RegExp(`moved to \`${moved}\``));
      assert.match(handback?.comment ?? "", /will not be retried/);
      assert.deepEqual(ports.repoHost.readyMarked, []);
      assert.deepEqual(ports.tracker.closedApplyReviewTickets, []);
    });

    it("carries the run's transcript into the failed iteration, rather than dropping it with the rest of the outcome", async () => {
      const ports = fakePorts();
      queued(ports);
      const transcript = transcriptPath("/home/node/.claude/projects/-repo/session.jsonl");
      ports.sandbox.applyReviewResult = () => ({
        kind: "gave-up",
        output: "I could not answer every thread",
        reason: "left a thread unanswered",
        tokensUsed: tokenCount(2_000),
        transcript,
      });

      const report = await morningLoop(ports);

      const iteration = report.iterations[0];
      assert.equal(
        iteration?.kind === "failed" ? iteration.transcript : undefined,
        transcript,
      );
    });

    it("names the run's transcript in the hand-back comment, when it left one", async () => {
      const ports = fakePorts();
      queued(ports);
      const transcript = transcriptPath("/home/node/.claude/projects/-repo/session.jsonl");
      ports.sandbox.applyReviewResult = () => ({
        kind: "gave-up",
        output: "I could not answer every thread",
        reason: "left a thread unanswered",
        tokensUsed: tokenCount(2_000),
        transcript,
      });

      await morningLoop(ports);

      assert.match(
        ports.tracker.handbacks[0]?.comment ?? "",
        endsWithTranscript(transcript),
      );
    });

    it("leaves the ticket eligible when the sandbox breaks, naming it under what is waiting on the developer", async (t) => {
      const ports = fakePorts();
      const ticket = queued(ports);
      t.mock.method(ports.sandbox, "applyReview", async () => {
        throw new Error("docker is not running");
      });

      const report = await morningLoop(ports);

      assert.equal(failureOf(report.iterations[0])?.kind, "infrastructure");
      assert.deepEqual(ports.tracker.handbacks, []);
      assert.deepEqual(ports.repoHost.readyMarked, []);
      assert.deepEqual(ports.tracker.closedApplyReviewTickets, []);
      assert.match(
        waitingOn(ports),
        new RegExp(`pilot#${ticket.number}: still ready-for-agent — the sandbox or checkout failed`),
      );
      const { tickets: backlog } = backlogIn(
        await ports.tracker.listOpenIssues(PILOT),
      );
      assert.deepEqual(backlog.map((listed) => listed.number), [ticket.number]);
    });

    it("leaves the ticket eligible, running nothing, when the pull request's threads cannot be read before the run", async (t) => {
      const ports = fakePorts();
      queued(ports);
      t.mock.method(ports.repoHost, "readApplyReviewAnswers", async () => {
        throw new Error("gh api rate limited");
      });

      const report = await morningLoop(ports);

      assert.equal(failureOf(report.iterations[0])?.kind, "infrastructure");
      assert.equal(ports.sandbox.applyReviews.length, 0);
      assert.deepEqual(ports.tracker.handbacks, []);
      assert.match(report.message, /gh api rate limited/);
    });

    it("stands down on a limit refusal, leaving the ticket exactly as it was", async () => {
      const ports = fakePorts();
      const ticket = queued(ports);
      ports.sandbox.applyReviewResult = () => ({
        kind: "limit-refused",
        words: LIMIT_REFUSAL,
        tokensUsed: tokenCount(0),
      });

      const report = await morningLoop(ports);

      assert.equal(report.iterations[0]?.kind, "limit-refused");
      assert.equal(report.standDown?.reason, "provider-limit");
      assert.deepEqual(ports.tracker.handbacks, []);
      assert.deepEqual(ports.repoHost.readyMarked, []);
      assert.deepEqual(ports.repoHost.labelled, []);
      const { tickets: backlog } = backlogIn(
        await ports.tracker.listOpenIssues(PILOT),
      );
      assert.deepEqual(backlog.map((listed) => listed.number), [ticket.number]);
    });

    it("stands down on a provider failure, leaving the ticket exactly as it was", async () => {
      const ports = fakePorts();
      const ticket = queued(ports);
      ports.sandbox.applyReviewResult = () => ({
        kind: "provider-failed",
        words: PROVIDER_FAILURE_PROSE,
        tokensUsed: tokenCount(0),
      });

      const report = await morningLoop(ports);

      assert.equal(report.iterations[0]?.kind, "provider-failed");
      assert.equal(report.standDown?.reason, "provider-failure");
      assert.deepEqual(ports.tracker.handbacks, []);
      assert.deepEqual(ports.repoHost.readyMarked, []);
      const { tickets: backlog } = backlogIn(
        await ports.tracker.listOpenIssues(PILOT),
      );
      assert.deepEqual(backlog.map((listed) => listed.number), [ticket.number]);
    });

    it("names the pull request and the applied and declined counts in the summary line", async () => {
      const ports = fakePorts();
      queued(ports, 3);
      answering(ports, ["applied", "applied", "declined"]);

      const report = await morningLoop(ports);

      assert.equal(report.outcome, "work-selected");
      assert.ok(
        report.message.includes(
          `Applied review on ${PILOT}#43: 2 applied, 1 declined on ${PULL_REQUEST}, now ready for review.`,
        ),
        report.message,
      );
      assert.ok(
        waitingOn(ports).includes(`- ${PILOT}: ${PULL_REQUEST} — ready for review`),
      );
    });

    it("records what the run cost", async () => {
      const ports = fakePorts();
      queued(ports);
      answering(ports, ["applied"], tokenCount(9_000));

      await morningLoop(ports);

      const state = await ports.store.loadState();
      assert.deepEqual(state.projects.get(PILOT)?.runs, [
        { at: FROZEN_NOW, tokensUsed: tokenCount(9_000) },
      ]);
    });

    it("reports a pull request whose answers cannot be read after the run, leaving the ticket open and the pull request a draft", async (t) => {
      const ports = fakePorts();
      const ticket = queued(ports);
      answering(ports, ["applied"]);
      const read = ports.repoHost.readApplyReviewAnswers.bind(ports.repoHost);
      let reads = 0;
      t.mock.method(
        ports.repoHost,
        "readApplyReviewAnswers",
        async (...args: Parameters<typeof read>) => {
          reads += 1;
          if (reads > 1) {
            throw new Error("gh api rate limited");
          }
          return read(...args);
        },
      );

      const report = await morningLoop(ports);

      assert.equal(report.iterations[0]?.kind, "applied-review");
      assert.notEqual(report.outcome, "invocation-failed");
      assert.match(report.message, /gh api rate limited/);
      assert.deepEqual(ports.tracker.closedApplyReviewTickets, []);
      assert.deepEqual(ports.tracker.handbacks, []);
      assert.deepEqual(ports.repoHost.readyMarked, []);
      assert.deepEqual(ports.repoHost.labelled, []);
      assert.match(
        waitingOn(ports),
        new RegExp(`pilot#${ticket.number}: still ready-for-agent`),
      );
    });

    it("leaves the ticket open when the pull request cannot be marked ready, rather than raising it", async (t) => {
      const ports = fakePorts();
      const ticket = queued(ports);
      answering(ports, ["applied"]);
      t.mock.method(ports.repoHost, "markPullRequestReady", async () => {
        throw new Error("pull request is closed");
      });

      const report = await morningLoop(ports);

      assert.equal(report.iterations[0]?.kind, "applied-review");
      assert.match(report.message, /pull request is closed/);
      assert.deepEqual(ports.tracker.closedApplyReviewTickets, []);
      assert.match(
        waitingOn(ports),
        new RegExp(`pilot#${ticket.number}: still ready-for-agent`),
      );
      assert.deepEqual(ports.repoHost.labelled, []);
    });

    it("reports a ticket that cannot be closed, rather than raising it", async (t) => {
      const ports = fakePorts();
      const ticket = queued(ports);
      answering(ports, ["applied"]);
      t.mock.method(ports.tracker, "closeApplyReviewTicket", async () => {
        throw new Error("issue is locked");
      });

      const report = await morningLoop(ports);

      assert.equal(report.iterations[0]?.kind, "applied-review");
      assert.deepEqual(ports.repoHost.readyMarked, [PULL_REQUEST]);
      assert.match(report.message, /issue is locked/);
      assert.match(report.message, /close it yourself/);
      assert.match(
        waitingOn(ports),
        new RegExp(`pilot#${ticket.number}: still ready-for-agent`),
      );
      assert.deepEqual(ports.repoHost.labelled, []);
    });

    it("reports a refused label without reopening a finished apply-review's ticket", async (t) => {
      const ports = fakePorts();
      const ticket = queued(ports);
      answering(ports, ["applied"]);
      t.mock.method(ports.repoHost, "labelPullRequest", async () => {
        throw new Error("label does not exist");
      });

      const report = await morningLoop(ports);

      assert.deepEqual(
        ports.tracker.closedApplyReviewTickets.map((closed) => closed.ticket),
        [ticket],
      );
      const outcome = report.iterations[0];
      assert.equal(outcome?.kind, "applied-review");
      assert.equal(
        outcome?.kind === "applied-review"
          ? outcome.notLabelled?.error
          : undefined,
        "label does not exist",
      );
      assert.equal(
        outcome?.kind === "applied-review" ? outcome.notClosed : undefined,
        undefined,
      );
    });

    it("closes an apply-review ticket whose pull request is already merged, without running anything", async () => {
      const ports = fakePorts();
      const ticket = queued(ports);
      ports.repoHost.setPullRequestState(PULL_REQUEST, "merged");

      const report = await morningLoop(ports);

      assert.equal(ports.sandbox.applyReviews.length, 0);
      assert.equal(ports.repoHost.clones.length, 0);
      assert.equal(report.iterations[0]?.kind, "pull-request-resolved");
      const [closed] = ports.tracker.closedApplyReviewTickets;
      assert.deepEqual(closed?.ticket, ticket);
      assert.match(closed?.comment ?? "", /already been merged/);
      assert.deepEqual(ports.repoHost.readyMarked, []);
      assert.match(report.message, /already merged/);
    });

    it("closes an apply-review ticket whose pull request is closed without merging, without running anything", async () => {
      const ports = fakePorts();
      const ticket = queued(ports);
      ports.repoHost.setPullRequestState(PULL_REQUEST, "closed");

      const report = await morningLoop(ports);

      assert.equal(ports.sandbox.applyReviews.length, 0);
      assert.equal(report.iterations[0]?.kind, "pull-request-resolved");
      const [closed] = ports.tracker.closedApplyReviewTickets;
      assert.deepEqual(closed?.ticket, ticket);
      assert.match(closed?.comment ?? "", /closed without merging/);
      assert.deepEqual(ports.repoHost.readyMarked, []);
      assert.match(report.message, /closed without merging/);
    });

    describe("the merge gate", () => {
      const IMPLEMENTATION = issueNumber(7);
      const RUN_STARTED = new Date(FROZEN_NOW.getTime() - 3_600_000);
      const RUN_ENDED = new Date(FROZEN_NOW.getTime() - 1_800_000);
      const GRANTED_IN_TIME = new Date(RUN_STARTED.getTime() - 60_000);

      /**
       * A turbo project's implementation ticket #7, turboable before its own
       * run started, and the apply-review ticket its pull request already
       * carries, linked to it as a sub-issue — the merge gate's own
       * precondition for even asking.
       */
      function queuedTurboable(
        ports: FakePorts,
        { threads = 0, turbo = true, grantedAt = GRANTED_IN_TIME } = {},
      ): Ticket {
        ports.store.register(PILOT, { turbo });
        for (let opened = 0; opened < threads; opened++) {
          ports.repoHost.openApplyReviewThread(PULL_REQUEST);
        }
        const implementation = ports.tracker.addEligibleTicket(PILOT, {
          number: IMPLEMENTATION,
          title: "Add the thing",
        });
        ports.store.markRunSpan(implementation, RUN_STARTED, RUN_ENDED);
        ports.tracker.recordTurboableEvent(implementation, "labeled", grantedAt);
        ports.tracker.addEligibleTicket(PILOT, {
          number: issueNumber(43),
          title: "Apply the review on the draft pull request for #7",
          pullRequest: { kind: "apply-review", url: PULL_REQUEST },
          parent: IMPLEMENTATION,
        });
        return implementation;
      }

      it("merges the pull request with a merge commit once a turboable ticket's apply-review finishes clean", async () => {
        const ports = fakePorts();
        const implementation = queuedTurboable(ports);

        const report = await morningLoop(ports);

        assert.deepEqual(ports.repoHost.merged, [PULL_REQUEST]);
        const outcome = report.iterations[0];
        assert.equal(outcome?.kind, "applied-review");
        assert.deepEqual(
          outcome?.kind === "applied-review" ? outcome.merge : undefined,
          { kind: "merged", implementationTicket: implementation },
        );
        assert.deepEqual(
          ports.repoHost.labelled.filter(
            (labelled) => labelled.label === READY_FOR_HUMAN_PULL_REQUEST_LABEL,
          ),
          [],
        );
      });

      it("labels the pull request ready-for-human instead of merging when the repo host refuses the merge, reporting rather than raising it", async (t) => {
        const ports = fakePorts();
        queuedTurboable(ports);
        t.mock.method(ports.repoHost, "mergePullRequest", async () => {
          throw new Error("Pull Request is not mergeable");
        });

        const report = await morningLoop(ports);

        assert.equal(report.outcome, "work-selected");
        assert.deepEqual(ports.repoHost.merged, []);
        assert.deepEqual(ports.repoHost.labelled, [
          { pullRequest: PULL_REQUEST, label: APPLIED_REVIEW_LABEL },
          { pullRequest: PULL_REQUEST, label: READY_FOR_HUMAN_PULL_REQUEST_LABEL },
        ]);
        const outcome = report.iterations[0];
        assert.deepEqual(
          outcome?.kind === "applied-review" ? outcome.merge : undefined,
          { kind: "left-for-human", reason: "Pull Request is not mergeable" },
        );
      });

      it("labels the pull request ready-for-human without attempting a merge when the run's own pass left a thread declined", async () => {
        const ports = fakePorts();
        queuedTurboable(ports, { threads: 1 });
        answering(ports, ["declined"]);

        const report = await morningLoop(ports);

        assert.deepEqual(ports.repoHost.merged, []);
        assert.deepEqual(
          ports.repoHost.labelled.filter(
            (labelled) => labelled.label === READY_FOR_HUMAN_PULL_REQUEST_LABEL,
          ),
          [{ pullRequest: PULL_REQUEST, label: READY_FOR_HUMAN_PULL_REQUEST_LABEL }],
        );
        const outcome = report.iterations[0];
        assert.deepEqual(
          outcome?.kind === "applied-review" ? outcome.merge : undefined,
          { kind: "left-for-human", reason: "1 declined thread" },
        );
      });

      it("never merges when the implementation ticket was not turboable before its own run started", async () => {
        const ports = fakePorts();
        queuedTurboable(ports, {
          grantedAt: new Date(RUN_STARTED.getTime() + 60_000),
        });

        const report = await morningLoop(ports);

        assert.deepEqual(ports.repoHost.merged, []);
        assert.deepEqual(
          ports.repoHost.labelled.filter(
            (labelled) => labelled.label === READY_FOR_HUMAN_PULL_REQUEST_LABEL,
          ),
          [],
        );
        const outcome = report.iterations[0];
        assert.deepEqual(
          outcome?.kind === "applied-review" ? outcome.merge : undefined,
          {
            kind: "not-turboable",
            reason: "not turboable before its own run started",
            declinedGrant: true,
          },
        );
      });

      it("never merges on a project that is not turbo, whatever the implementation ticket carries", async () => {
        const ports = fakePorts();
        queuedTurboable(ports, { turbo: false });

        const report = await morningLoop(ports);

        assert.deepEqual(ports.repoHost.merged, []);
        const outcome = report.iterations[0];
        assert.equal(
          outcome?.kind === "applied-review" ? outcome.merge : undefined,
          undefined,
        );
      });

      it("labels the pull request ready-for-human, without ever starting a run, when a thread was declined before this pass started", async () => {
        const ports = fakePorts();
        queuedTurboable(ports, { threads: 1 });
        ports.repoHost.answerApplyReviewThread(
          PULL_REQUEST,
          0,
          "declined",
          "out of scope",
          new Date(FROZEN_NOW.getTime() - 120_000),
        );

        const report = await morningLoop(ports);

        assert.deepEqual(ports.sandbox.applyReviews, []);
        assert.deepEqual(ports.repoHost.merged, []);
        const outcome = report.iterations[0];
        assert.deepEqual(
          outcome?.kind === "applied-review" ? outcome.merge : undefined,
          { kind: "left-for-human", reason: "1 declined thread" },
        );
      });

      it("closes the ticket as not-turboable, rather than raising, when the implementation ticket lookup fails", async (t) => {
        const ports = fakePorts();
        queuedTurboable(ports);
        let calls = 0;
        const original = ports.tracker.listOpenIssues.bind(ports.tracker);
        t.mock.method(
          ports.tracker,
          "listOpenIssues",
          async (...args: Parameters<typeof original>) => {
            calls++;
            if (calls > 1) {
              throw new Error("tracker unavailable");
            }
            return original(...args);
          },
        );

        const report = await morningLoop(ports);

        assert.deepEqual(ports.repoHost.merged, []);
        const outcome = report.iterations[0];
        assert.equal(outcome?.kind, "applied-review");
        assert.deepEqual(ports.tracker.closedApplyReviewTickets.length, 1);
        assert.deepEqual(
          outcome?.kind === "applied-review" ? outcome.merge : undefined,
          {
            kind: "not-turboable",
            reason: "could not find its implementation ticket",
            declinedGrant: false,
          },
        );
      });

      it("closes the ticket as timeline-unreadable, rather than raising, when reading its turboable timeline fails", async (t) => {
        const ports = fakePorts();
        queuedTurboable(ports);
        t.mock.method(ports.tracker, "wasTurboableAt", async () => {
          throw new Error("tracker unavailable");
        });

        const report = await morningLoop(ports);

        assert.deepEqual(ports.repoHost.merged, []);
        assert.deepEqual(
          ports.repoHost.labelled.filter(
            (labelled) => labelled.label === READY_FOR_HUMAN_PULL_REQUEST_LABEL,
          ),
          [],
        );
        const outcome = report.iterations[0];
        assert.equal(outcome?.kind, "applied-review");
        assert.deepEqual(ports.tracker.closedApplyReviewTickets.length, 1);
        assert.deepEqual(
          outcome?.kind === "applied-review" ? outcome.merge : undefined,
          { kind: "timeline-unreadable", error: "tracker unavailable" },
        );
      });

      it("labels the pull request ready-for-human instead of merging when its checks are still running", async () => {
        const ports = fakePorts();
        queuedTurboable(ports);
        ports.repoHost.checksStatus = () => "pending";

        const report = await morningLoop(ports);

        assert.deepEqual(ports.repoHost.merged, []);
        const outcome = report.iterations[0];
        assert.deepEqual(
          outcome?.kind === "applied-review" ? outcome.merge : undefined,
          { kind: "left-for-human", reason: "checks still running" },
        );
      });

      it("labels the pull request ready-for-human instead of merging when its checks are red", async () => {
        const ports = fakePorts();
        queuedTurboable(ports);
        ports.repoHost.checksStatus = () => "red";

        const report = await morningLoop(ports);

        assert.deepEqual(ports.repoHost.merged, []);
        const outcome = report.iterations[0];
        assert.deepEqual(
          outcome?.kind === "applied-review" ? outcome.merge : undefined,
          { kind: "left-for-human", reason: "checks failing" },
        );
      });
    });

    describe("a blocking discovery", () => {
      it("opens a discovered ticket that blocks the implementation ticket, and hands back the apply-review ticket, not the implementation ticket", async () => {
        const ports = fakePorts();
        const { implementation, pullRequestTicket: applyReview } = queuedWithImplementation(
          ports,
          "apply-review",
        );
        ports.sandbox.applyReviewResult = () => {
          ports.repoHost.answerApplyReviewThread(
            PULL_REQUEST,
            0,
            "applied",
            "the reason",
            DURING_THE_RUN,
          );
          return {
            kind: "finished",
            output: "answered",
            tokensUsed: tokenCount(0),
            discoveries: [
              {
                kind: "prerequisite",
                title: "Needs the widget port first",
                body: "There is no widget port to apply the review against yet.",
              },
            ],
          };
        };

        const report = await morningLoop(ports);

        assert.equal(ports.tracker.discoveredTickets.length, 1);
        assert.equal(ports.tracker.discoveredTickets[0]?.blocking, true);
        assert.deepEqual(ports.tracker.closedApplyReviewTickets, []);
        assert.deepEqual(ports.repoHost.readyMarked, []);
        const handback = ports.tracker.handbacks[0];
        assert.equal(handback?.ticket.number, applyReview.number);
        assert.notEqual(handback?.ticket.number, implementation.number);
        assert.match(handback?.comment ?? "", /implementation ticket, nadav-alon\/pilot#7/);
        assert.equal(report.iterations[0]?.kind, "discovery-blocked");
      });
    });
  });

  describe("a rebase ticket, selected", () => {
    const PULL_REQUEST = pullRequestUrl(
      "https://github.com/nadav-alon/pilot/pull/12",
    );

    /** A rebase ticket, eligible like any other, on a pull request that conflicts with its base. */
    function queued(ports: FakePorts): RebaseTicket {
      ports.store.register(PILOT);
      ports.repoHost.mergeStatus = () => "conflicting";
      return ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(44),
        title: "Rebase the draft pull request for #7",
        pullRequest: { kind: "rebase", url: PULL_REQUEST },
      }) as RebaseTicket;
    }

    /** A run that leaves the pull request `after`, as the repo host then reads it, and finishes. */
    function rebasing(
      ports: FakePorts,
      after: "clean" | "conflicting",
      tokensUsed = tokenCount(0),
    ): void {
      ports.sandbox.rebaseResult = () => {
        ports.repoHost.mergeStatus = () => after;
        return { kind: "finished", output: "rebased", tokensUsed };
      };
    }

    function waitingOn(ports: FakePorts): string {
      const body = ports.tracker.summaries[0]?.body ?? "";
      const at = body.indexOf("## Waiting on you");
      return at === -1 ? "" : body.slice(at);
    }

    function attempts(ports: FakePorts): string {
      const body = ports.tracker.summaries[0]?.body ?? "";
      const at = body.indexOf("## Attempts");
      const end = body.indexOf("## Waiting on you");
      return at === -1 ? "" : body.slice(at, end === -1 ? undefined : end);
    }

    it("works the rebase ticket of a project that also has an apply-review ticket", async () => {
      const ports = fakePorts();
      const ticket = queued(ports);
      ports.repoHost.openApplyReviewThread(PULL_REQUEST);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(43),
        title: "Apply the review on the draft pull request for #7",
        pullRequest: { kind: "apply-review", url: PULL_REQUEST },
      });
      rebasing(ports, "clean");
      ports.sandbox.applyReviewResult = () => {
        assert.equal(ports.sandbox.rebases.length, 1);
        return { kind: "gave-up", output: "", reason: "stop", tokensUsed: tokenCount(0) };
      };

      const report = await morningLoop(ports);

      assert.equal(report.iterations[0]?.ticket.number, ticket.number);
      assert.equal(report.iterations[0]?.kind, "rebased");
    });

    it("runs the rebase agent on the ticket and the project checkout, rather than any other", async () => {
      const ports = fakePorts();
      const ticket = queued(ports);
      rebasing(ports, "clean");

      await morningLoop(ports);

      assert.deepEqual(ports.sandbox.rebases, [
        {
          ticket,
          checkout: `${FakeRepoHost.MANAGED_LOCATION}/${PILOT}`,
          spendCeiling: DEFAULT_BUDGET.spendCeiling,
        },
      ]);
      assert.equal(ports.sandbox.runs.length, 0);
      assert.equal(ports.sandbox.reviews.length, 0);
      assert.equal(ports.sandbox.applyReviews.length, 0);
    });

    it("closes a ticket whose pull request needs no rebase without running anything, saying so", async () => {
      const ports = fakePorts();
      const ticket = queued(ports);
      ports.repoHost.mergeStatus = () => "clean";
      ports.repoHost.labelNeedsRebase(PULL_REQUEST);

      const report = await morningLoop(ports);

      assert.equal(ports.sandbox.rebases.length, 0);
      assert.equal(ports.repoHost.clones.length, 0);
      assert.equal(report.iterations[0]?.kind, "rebased");
      const [closed] = ports.tracker.closedRebaseTickets;
      assert.deepEqual(closed?.ticket, ticket);
      assert.ok(closed?.comment.includes(PULL_REQUEST));
      assert.match(closed?.comment ?? "", /already sits on its base/);
      assert.match(closed?.comment ?? "", /no longer carries needs-rebase/);
      assert.equal(ports.repoHost.hasNeedsRebaseLabel(PULL_REQUEST), false);
      assert.deepEqual(ports.repoHost.readyMarked, []);
      const state = await ports.store.loadState();
      assert.equal(state.projects.get(PILOT), undefined);
      assert.match(report.message, /already sits on its base/);
      assert.match(attempts(ports), /nothing run/);
    });

    it("closes a ticket whose pull request never carried needs-rebase, with no error", async () => {
      const ports = fakePorts();
      queued(ports);
      ports.repoHost.mergeStatus = () => "clean";

      const report = await morningLoop(ports);

      assert.equal(report.iterations[0]?.kind, "rebased");
      assert.equal(failureOf(report.iterations[0]), undefined);
      const [closed] = ports.tracker.closedRebaseTickets;
      assert.match(closed?.comment ?? "", /no longer carries needs-rebase/);
      assert.equal(ports.repoHost.hasNeedsRebaseLabel(PULL_REQUEST), false);
    });

    it("closes a finished run's ticket once its pull request no longer conflicts, leaving the pull request a draft", async () => {
      const ports = fakePorts();
      const ticket = queued(ports);
      ports.repoHost.labelNeedsRebase(PULL_REQUEST);
      rebasing(ports, "clean");

      const report = await morningLoop(ports);

      assert.equal(report.iterations[0]?.kind, "rebased");
      const [closed] = ports.tracker.closedRebaseTickets;
      assert.deepEqual(closed?.ticket, ticket);
      assert.ok(closed?.comment.includes(PULL_REQUEST));
      assert.match(closed?.comment ?? "", /no longer conflicts/);
      assert.match(closed?.comment ?? "", /no longer carries needs-rebase/);
      assert.match(closed?.comment ?? "", /draft state was left as it was/);
      assert.equal(ports.repoHost.hasNeedsRebaseLabel(PULL_REQUEST), false);
      assert.deepEqual(ports.repoHost.readyMarked, []);
      assert.deepEqual(ports.tracker.handbacks, []);
      assert.equal(ports.repoHost.pullRequests.length, 0);
      assert.equal(ports.repoHost.discarded.length, 0);
      assert.equal(ports.tracker.reviewTickets.length, 0);
      assert.deepEqual(ports.repoHost.labelled, []);
    });

    it("hands back a finished run whose pull request still conflicts, and does not close it", async () => {
      const ports = fakePorts();
      const ticket = queued(ports);
      ports.repoHost.labelNeedsRebase(PULL_REQUEST);
      rebasing(ports, "conflicting");

      const report = await morningLoop(ports);
      const tomorrow = await morningLoop(ports);

      assert.equal(failureOf(report.iterations[0])?.kind, "gave-up");
      assert.equal(handedBackOf(report.iterations[0]), "handed-back");
      const [handback] = ports.tracker.handbacks;
      assert.equal(handback?.ticket.number, ticket.number);
      assert.match(handback?.comment ?? "", /still conflicts/);
      assert.match(handback?.comment ?? "", /draft state was left as it was/);
      assert.doesNotMatch(handback?.comment ?? "", /is still a draft/);
      assert.ok(handback?.comment.includes(PULL_REQUEST));
      assert.deepEqual(ports.tracker.closedRebaseTickets, []);
      assert.deepEqual(ports.repoHost.readyMarked, []);
      assert.equal(ports.repoHost.hasNeedsRebaseLabel(PULL_REQUEST), true);
      assert.equal(tomorrow.outcome, "dry-queue");
    });

    it("hands back a run that gave up, naming a moved head, without closing it", async () => {
      const ports = fakePorts();
      const ticket = queued(ports);
      ports.repoHost.labelNeedsRebase(PULL_REQUEST);
      const moved = commitSha("b2".repeat(20));
      ports.sandbox.rebaseResult = () => ({
        kind: "gave-up",
        output: `Branch moved: ${moved}`,
        reason: `The force-push was rejected: the branch had moved to ${moved}.`,
        movedHead: moved,
        tokensUsed: tokenCount(2_000),
      });

      const report = await morningLoop(ports);

      assert.equal(failureOf(report.iterations[0])?.kind, "gave-up");
      const [handback] = ports.tracker.handbacks;
      assert.equal(handback?.ticket.number, ticket.number);
      assert.match(handback?.comment ?? "", new RegExp(`moved to \`${moved}\``));
      assert.match(handback?.comment ?? "", /will not be retried/);
      assert.deepEqual(ports.tracker.closedRebaseTickets, []);
      assert.deepEqual(ports.repoHost.readyMarked, []);
      assert.equal(ports.repoHost.hasNeedsRebaseLabel(PULL_REQUEST), true);
    });

    it("carries the run's transcript into the failed iteration, rather than dropping it with the rest of the outcome", async () => {
      const ports = fakePorts();
      queued(ports);
      const transcript = transcriptPath("/home/node/.claude/projects/-repo/session.jsonl");
      ports.sandbox.rebaseResult = () => ({
        kind: "gave-up",
        output: "I could not resolve the conflict",
        reason: "left the pull request still conflicting",
        tokensUsed: tokenCount(2_000),
        transcript,
      });

      const report = await morningLoop(ports);

      const iteration = report.iterations[0];
      assert.equal(
        iteration?.kind === "failed" ? iteration.transcript : undefined,
        transcript,
      );
    });

    it("names the run's transcript in the hand-back comment, when it left one", async () => {
      const ports = fakePorts();
      queued(ports);
      const transcript = transcriptPath("/home/node/.claude/projects/-repo/session.jsonl");
      ports.sandbox.rebaseResult = () => ({
        kind: "gave-up",
        output: "I could not resolve the conflict",
        reason: "left the pull request still conflicting",
        tokensUsed: tokenCount(2_000),
        transcript,
      });

      await morningLoop(ports);

      assert.match(
        ports.tracker.handbacks[0]?.comment ?? "",
        endsWithTranscript(transcript),
      );
    });

    it("stands down on a limit refusal, leaving the ticket exactly as it was", async () => {
      const ports = fakePorts();
      const ticket = queued(ports);
      ports.sandbox.rebaseResult = () => ({
        kind: "limit-refused",
        words: LIMIT_REFUSAL,
        tokensUsed: tokenCount(0),
      });

      const report = await morningLoop(ports);

      assert.equal(report.iterations[0]?.kind, "limit-refused");
      assert.equal(report.standDown?.reason, "provider-limit");
      assert.deepEqual(ports.tracker.handbacks, []);
      assert.deepEqual(ports.tracker.closedRebaseTickets, []);
      const { tickets: backlog } = backlogIn(
        await ports.tracker.listOpenIssues(PILOT),
      );
      assert.deepEqual(backlog.map((listed) => listed.number), [ticket.number]);
    });

    it("stands down on a provider failure, leaving the ticket exactly as it was", async () => {
      const ports = fakePorts();
      const ticket = queued(ports);
      ports.sandbox.rebaseResult = () => ({
        kind: "provider-failed",
        words: PROVIDER_FAILURE_PROSE,
        tokensUsed: tokenCount(0),
      });

      const report = await morningLoop(ports);

      assert.equal(report.iterations[0]?.kind, "provider-failed");
      assert.equal(report.standDown?.reason, "provider-failure");
      assert.deepEqual(ports.tracker.handbacks, []);
      assert.deepEqual(ports.tracker.closedRebaseTickets, []);
      const { tickets: backlog } = backlogIn(
        await ports.tracker.listOpenIssues(PILOT),
      );
      assert.deepEqual(backlog.map((listed) => listed.number), [ticket.number]);
    });

    it("hands back a ticket whose model is refused, naming the rebase model defaults", async () => {
      const ports = fakePorts();
      queued(ports);
      const haiku = modelName("haiku");
      ports.store.modelDefaults = { rebase: haiku };
      ports.sandbox.rebaseResult = () => ({
        kind: "model-refused",
        tokensUsed: tokenCount(0),
        refusal: { model: haiku, words: "refused model haiku" },
      });

      const report = await morningLoop(ports);

      assert.equal(failureOf(report.iterations[0])?.kind, "model-refused");
      const comment = ports.tracker.handbacks[0]?.comment ?? "";
      assert.match(comment, /haiku/);
      assert.match(comment, /model defaults for rebase tickets/);
      assert.deepEqual(ports.tracker.closedRebaseTickets, []);
    });

    it("leaves the ticket eligible, running nothing, when the pull request cannot be read before the run", async (t) => {
      const ports = fakePorts();
      queued(ports);
      t.mock.method(ports.repoHost, "needsRebase", async () => {
        throw new Error("gh api rate limited");
      });

      const report = await morningLoop(ports);

      assert.equal(failureOf(report.iterations[0])?.kind, "infrastructure");
      assert.equal(ports.sandbox.rebases.length, 0);
      assert.deepEqual(ports.tracker.handbacks, []);
      assert.match(report.message, /gh api rate limited/);
    });

    it("hands back, running nothing, a ticket whose pull request's mergeability never settles", async (t) => {
      const ports = fakePorts();
      const ticket = queued(ports);
      ports.repoHost.labelNeedsRebase(PULL_REQUEST);
      t.mock.method(ports.repoHost, "needsRebase", async () => {
        throw new MergeabilityUnknown(PULL_REQUEST, "unknown");
      });

      const report = await morningLoop(ports);
      const later = await morningLoop(ports);

      assert.equal(
        failureOf(report.iterations[0])?.kind,
        "unsettled-mergeability",
      );
      assert.equal(ports.sandbox.rebases.length, 0);
      assert.match(attempts(ports), /nothing run/);
      assert.doesNotMatch(attempts(ports), /gave up/);
      const [handback] = ports.tracker.handbacks;
      assert.equal(handback?.ticket.number, ticket.number);
      assert.match(handback?.comment ?? "", /did not run this ticket/);
      assert.match(handback?.comment ?? "", /never finished computing mergeability/);
      assert.deepEqual(ports.tracker.closedRebaseTickets, []);
      assert.equal(ports.repoHost.hasNeedsRebaseLabel(PULL_REQUEST), true);
      assert.equal(later.outcome, "dry-queue");
    });

    it("leaves the ticket eligible when the sandbox breaks", async (t) => {
      const ports = fakePorts();
      queued(ports);
      t.mock.method(ports.sandbox, "rebase", async () => {
        throw new Error("docker is not running");
      });

      const report = await morningLoop(ports);

      assert.equal(failureOf(report.iterations[0])?.kind, "infrastructure");
      assert.deepEqual(ports.tracker.handbacks, []);
      assert.deepEqual(ports.tracker.closedRebaseTickets, []);
    });

    it("records what the run cost, whatever it came to", async () => {
      const ports = fakePorts();
      queued(ports);
      rebasing(ports, "conflicting", tokenCount(9_000));

      await morningLoop(ports);

      const state = await ports.store.loadState();
      assert.deepEqual(state.projects.get(PILOT)?.runs, [
        { at: FROZEN_NOW, tokensUsed: tokenCount(9_000) },
      ]);
    });

    it("reports a pull request that cannot be read after the run, leaving the ticket open", async (t) => {
      const ports = fakePorts();
      const ticket = queued(ports);
      rebasing(ports, "clean");
      let reads = 0;
      t.mock.method(ports.repoHost, "needsRebase", async () => {
        reads += 1;
        if (reads > 1) {
          throw new Error("gh api rate limited");
        }
        return true;
      });

      const report = await morningLoop(ports);

      assert.equal(report.iterations[0]?.kind, "rebased");
      assert.notEqual(report.outcome, "invocation-failed");
      assert.match(report.message, /gh api rate limited/);
      assert.deepEqual(ports.tracker.closedRebaseTickets, []);
      assert.deepEqual(ports.tracker.handbacks, []);
      assert.match(
        waitingOn(ports),
        new RegExp(`pilot#${ticket.number}: still ready-for-agent`),
      );
    });

    it("reports a ticket that cannot be closed, leaving it open, rather than raising it", async (t) => {
      const ports = fakePorts();
      const ticket = queued(ports);
      rebasing(ports, "clean");
      t.mock.method(ports.tracker, "closeRebaseTicket", async () => {
        throw new Error("issue is locked");
      });

      const report = await morningLoop(ports);

      assert.equal(report.iterations[0]?.kind, "rebased");
      assert.notEqual(report.outcome, "invocation-failed");
      assert.match(report.message, /issue is locked/);
      assert.match(report.message, /close it yourself/);
      assert.deepEqual(ports.repoHost.readyMarked, []);
      assert.match(
        waitingOn(ports),
        new RegExp(`pilot#${ticket.number}: still ready-for-agent`),
      );
      const { tickets: backlog } = backlogIn(
        await ports.tracker.listOpenIssues(PILOT),
      );
      assert.deepEqual(backlog.map((listed) => listed.number), [ticket.number]);
    });

    it("reports a ticket whose needs-rebase label cannot be removed, leaving it open and the ticket unclosed", async (t) => {
      const ports = fakePorts();
      const ticket = queued(ports);
      ports.repoHost.labelNeedsRebase(PULL_REQUEST);
      rebasing(ports, "clean");
      t.mock.method(ports.repoHost, "removeNeedsRebaseLabel", async () => {
        throw new Error("label locked");
      });

      const report = await morningLoop(ports);

      assert.equal(report.iterations[0]?.kind, "rebased");
      assert.notEqual(report.outcome, "invocation-failed");
      assert.match(report.message, /label locked/);
      assert.match(report.message, /close the ticket yourself/);
      assert.deepEqual(ports.tracker.closedRebaseTickets, []);
      assert.deepEqual(ports.tracker.handbacks, []);
      assert.equal(ports.repoHost.hasNeedsRebaseLabel(PULL_REQUEST), true);
      assert.match(
        waitingOn(ports),
        new RegExp(`pilot#${ticket.number}: still ready-for-agent`),
      );
    });

    it("names the rebased pull request in the summary, distinctly from an applied review", async () => {
      const ports = fakePorts();
      queued(ports);
      rebasing(ports, "clean", tokenCount(1_000));

      const report = await morningLoop(ports);

      assert.equal(report.outcome, "work-selected");
      assert.ok(
        report.message.includes(
          `Rebased ${PULL_REQUEST} for ${PILOT}#44: it no longer conflicts with its base.`,
        ),
        report.message,
      );
      assert.ok(
        waitingOn(ports).includes(
          `- ${PILOT}: ${PULL_REQUEST} — rebased onto its base`,
        ),
        waitingOn(ports),
      );
      assert.doesNotMatch(waitingOn(ports), /ready for review/);
    });

    it("names a handed-back rebase ticket under attempts, distinctly from an apply-review ticket", async () => {
      const ports = fakePorts();
      queued(ports);
      rebasing(ports, "conflicting", tokenCount(1_000));

      await morningLoop(ports);

      assert.match(
        attempts(ports),
        new RegExp(`- Attempted a rebase of ${PULL_REQUEST} on ${PILOT}: the agent gave up on ${PILOT}#44: .*still conflicts`),
      );
    });

    it("closes a rebase ticket whose pull request is already merged, without checking mergeability or running anything", async (t) => {
      const ports = fakePorts();
      const ticket = queued(ports);
      ports.repoHost.setPullRequestState(PULL_REQUEST, "merged");
      const needsRebase = t.mock.method(ports.repoHost, "needsRebase");

      const report = await morningLoop(ports);

      assert.equal(needsRebase.mock.callCount(), 0);
      assert.equal(ports.sandbox.rebases.length, 0);
      assert.equal(ports.repoHost.clones.length, 0);
      assert.equal(report.iterations[0]?.kind, "pull-request-resolved");
      const [closed] = ports.tracker.closedRebaseTickets;
      assert.deepEqual(closed?.ticket, ticket);
      assert.match(closed?.comment ?? "", /already been merged/);
      assert.match(report.message, /already merged/);
    });

    it("closes a rebase ticket whose pull request is closed without merging, without running anything", async () => {
      const ports = fakePorts();
      const ticket = queued(ports);
      ports.repoHost.setPullRequestState(PULL_REQUEST, "closed");

      const report = await morningLoop(ports);

      assert.equal(ports.sandbox.rebases.length, 0);
      assert.equal(report.iterations[0]?.kind, "pull-request-resolved");
      const [closed] = ports.tracker.closedRebaseTickets;
      assert.deepEqual(closed?.ticket, ticket);
      assert.match(closed?.comment ?? "", /closed without merging/);
      assert.match(report.message, /closed without merging/);
    });

    describe("a blocking discovery", () => {
      it("opens a discovered ticket that blocks the implementation ticket, and hands back the rebase ticket, not the implementation ticket", async () => {
        const ports = fakePorts();
        const { implementation, pullRequestTicket: rebase } = queuedWithImplementation(
          ports,
          "rebase",
        );
        ports.sandbox.rebaseResult = () => {
          ports.repoHost.mergeStatus = () => "clean";
          return {
            kind: "finished",
            output: "rebased",
            tokensUsed: tokenCount(0),
            discoveries: [
              {
                kind: "prerequisite",
                title: "Needs the widget port first",
                body: "There is no widget port to rebase against yet.",
              },
            ],
          };
        };

        const report = await morningLoop(ports);

        assert.equal(ports.tracker.discoveredTickets.length, 1);
        assert.equal(ports.tracker.discoveredTickets[0]?.blocking, true);
        assert.deepEqual(ports.tracker.closedRebaseTickets, []);
        const handback = ports.tracker.handbacks[0];
        assert.equal(handback?.ticket.number, rebase.number);
        assert.notEqual(handback?.ticket.number, implementation.number);
        assert.match(handback?.comment ?? "", /implementation ticket, nadav-alon\/pilot#7/);
        assert.equal(report.iterations[0]?.kind, "discovery-blocked");
      });
    });
  });

  describe("a run that falls over", () => {
    const GAVE_UP = "the tests would not go green";
    const SAID = "I could not make the tests pass";
    const BROKE = "docker is not running";
    const FAILED_BRANCH = branch("issue-7-add-the-thing");

    /** A registered project with one eligible ticket waiting in it. */
    function readyToWork(): FakePorts {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      return ports;
    }

    /** The agent ran, committed something, and then gave up. */
    function agentGivesUp(ports: FakePorts): void {
      ports.sandbox.result = () => ({
        kind: "gave-up",
        branch: FAILED_BRANCH,
        commits: [commitSha("c0ffee1")],
        output: SAID,
        tokensUsed: tokenCount(42_000),
        reason: GAVE_UP,
      });
    }

    it("does not abort the invocation when the sandbox itself breaks", async (t) => {
      const ports = readyToWork();
      t.mock.method(ports.sandbox, "run", async () => {
        throw new Error(BROKE);
      });

      const report = await morningLoop(ports);

      assert.equal(failureOf(report.iterations[0])?.kind, "infrastructure");
      assert.match(report.message, new RegExp(BROKE));
    });

    it("still writes state back, since it still spent the morning", async (t) => {
      const ports = readyToWork();
      t.mock.method(ports.sandbox, "run", async () => {
        throw new Error(BROKE);
      });
      const saveState = t.mock.method(ports.store, "saveState");

      await morningLoop(ports);

      assert.equal(
        saveState.mock.callCount(),
        3,
        "once before the run, again after it broke, and again once the summary published and recorded today as announced",
      );
    });

    it("tells an agent that gave up apart from a sandbox that broke", async (t) => {
      const gaveUp = readyToWork();
      agentGivesUp(gaveUp);
      const broke = readyToWork();
      t.mock.method(broke.sandbox, "run", async () => {
        throw new Error(BROKE);
      });

      const gaveUpReport = await morningLoop(gaveUp);
      const brokeReport = await morningLoop(broke);
      assert.equal(failureOf(gaveUpReport.iterations[0])?.kind, "gave-up");
      assert.equal(failureOf(brokeReport.iterations[0])?.kind, "infrastructure");
    });

    it("counts a checkout that cannot be made as infrastructure, not the agent", async (t) => {
      const ports = readyToWork();
      t.mock.method(ports.repoHost, "clone", async () => {
        throw new Error("no such remote");
      });

      const report = await morningLoop(ports);

      assert.equal(failureOf(report.iterations[0])?.kind, "infrastructure");
      assert.equal(ports.sandbox.runs.length, 0);
    });

    it("records nothing against the project when the sandbox fails before the agent ran", async (t) => {
      const ports = readyToWork();
      t.mock.method(ports.sandbox, "run", async () => {
        throw new Error(BROKE);
      });

      await morningLoop(ports);

      const state = await ports.store.loadState();
      assert.equal(state.projects.get(PILOT)?.runs, undefined);
    });

    it("records what the agent spent, and leaves the ticket eligible rather than handing it back, when the sandbox fails after the agent ran", async () => {
      const ports = readyToWork();
      const reason = "git could not fetch the branch back into the checkout";
      ports.sandbox.result = () => ({
        kind: "sandbox-failed",
        reason,
        tokensUsed: tokenCount(42_000),
      });

      const report = await morningLoop(ports);

      const state = await ports.store.loadState();
      assert.deepEqual(state.projects.get(PILOT)?.runs, [
        { at: FROZEN_NOW, tokensUsed: tokenCount(42_000) },
      ]);
      assert.equal(failureOf(report.iterations[0])?.kind, "infrastructure");
      assert.equal(ports.tracker.handbacks.length, 0);
      assert.match(report.message, /still ready-for-agent/);
      assert.match(report.message, new RegExp(reason));
    });

    it("salvages a post-start infrastructure failure's branch when it had already reached the checkout, without raising the count", async () => {
      const ports = readyToWork();
      ports.store.markSalvaged(
        { repo: PILOT, number: issueNumber(7) },
        branch("issue-7-earlier-salvage"),
        1,
      );
      ports.sandbox.result = () => ({
        kind: "sandbox-failed",
        reason: "git could not read the ticket gist off the agent's output",
        tokensUsed: tokenCount(42_000),
        branch: FAILED_BRANCH,
        commits: [commitSha("c0ffee1")],
      });

      const report = await morningLoop(ports);

      assert.deepEqual(ports.repoHost.discarded, [
        {
          directory: checkout(`${FakeRepoHost.MANAGED_LOCATION}/${PILOT}`),
          branch: branch("issue-7-earlier-salvage"),
        },
      ]);
      const state = await ports.store.loadState();
      assert.deepEqual(state.salvages, [
        { repo: PILOT, number: issueNumber(7), branch: FAILED_BRANCH, stopShorts: 1 },
      ]);
      const failure = failureOf(report.iterations[0]);
      assert.equal(failure?.kind, "infrastructure");
      assert.deepEqual(
        failure?.kind === "infrastructure" ? failure.salvage : undefined,
        { branch: FAILED_BRANCH, stopShorts: 1 },
      );
    });

    it("records no salvage from a post-start infrastructure failure whose branch never reached the checkout", async () => {
      const ports = readyToWork();
      ports.sandbox.result = () => ({
        kind: "sandbox-failed",
        reason: "git could not fetch the branch back into the checkout",
        tokensUsed: tokenCount(42_000),
      });

      await morningLoop(ports);

      const state = await ports.store.loadState();
      assert.equal(state.salvages, undefined);
    });

    it("hands the ticket back", async () => {
      const ports = readyToWork();
      agentGivesUp(ports);

      await morningLoop(ports);

      const [handback] = ports.tracker.handbacks;
      assert.equal(handback?.ticket.number, 7);
    });

    describe("when the sandbox itself breaks", () => {
      it("leaves the ticket exactly as it was, since the setup is the problem", async (t) => {
        const ports = readyToWork();
        t.mock.method(ports.sandbox, "run", async () => {
          throw new Error(BROKE);
        });

        await morningLoop(ports);

        assert.deepEqual(ports.tracker.handbacks, []);
        const { tickets: backlog } = backlogIn(await ports.tracker.listOpenIssues(PILOT));
        assert.deepEqual(
          backlog.map((ticket) => ticket.number),
          [7],
        );
      });

      it("puts the error in the summary, naming the ticket it blocked", async (t) => {
        const ports = readyToWork();
        t.mock.method(ports.sandbox, "run", async () => {
          throw new Error(BROKE);
        });

        await morningLoop(ports);

        const body = ports.tracker.summaries[0]?.body ?? "";
        assert.ok(body.includes("## Attempts"));
        assert.ok(body.includes("## Waiting on you"));
        const attempts = body.slice(
          body.indexOf("## Attempts"),
          body.indexOf("## Waiting on you"),
        );
        assert.match(attempts, /#7/);
        assert.match(attempts, new RegExp(BROKE));
        const waiting = body.slice(body.indexOf("## Waiting on you"));
        assert.match(waiting, /pilot#7/);
        assert.match(waiting, new RegExp(BROKE));
        assert.doesNotMatch(body, /relabel it yourself/);
      });

      it("carries on past a review whose checkout cannot be made, leaving the review open", async (t) => {
        const ports = readyToWork();
        const review = ports.tracker.addEligibleTicket(PILOT, {
          number: issueNumber(42),
          title: "Review the draft pull request for #7",
          pullRequest: {
            kind: "review",
            url: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
          },
        });
        const clone = ports.repoHost.clone.bind(ports.repoHost);
        let clones = 0;
        t.mock.method(ports.repoHost, "clone", async (repo: typeof PILOT) => {
          clones += 1;
          if (clones === 1) {
            throw new Error("no such remote");
          }
          return clone(repo);
        });

        const report = await morningLoop(ports);

        assert.deepEqual(
          report.iterations.map((iteration) => [iteration.ticket.number, iteration.kind]),
          [
            [42, "failed"],
            [7, "finished"],
          ],
        );
        assert.equal(failureOf(report.iterations[0])?.kind, "infrastructure");
        assert.deepEqual(ports.tracker.closedReviewTickets, []);
        const { tickets: backlog } = backlogIn(await ports.tracker.listOpenIssues(PILOT));
        assert.ok(backlog.some((ticket) => ticket.number === review.number));
      });

      it("carries on to the next ticket", async (t) => {
        const ports = readyToWork();
        ports.tracker.addEligibleTicket(PILOT, {
          number: issueNumber(8),
          title: "Add another thing",
        });
        t.mock.method(ports.sandbox, "run", async (request: { ticket: Ticket }) => {
          if (request.ticket.number === 7) {
            throw new Error(BROKE);
          }
          return {
            kind: "finished",
            branch: branch("issue-8-add-another-thing"),
            commits: [],
            output: "",
            tokensUsed: tokenCount(0),
          };
        });

        const report = await morningLoop(ports);

        assert.deepEqual(
          report.iterations.map((iteration) => [iteration.ticket.number, iteration.kind]),
          [
            [7, "failed"],
            [8, "finished"],
          ],
        );
        assert.equal(report.standDown, undefined);
      });
    });

    it("relabels the ticket, so the next invocation cannot select it again", async () => {
      const ports = readyToWork();
      agentGivesUp(ports);

      await morningLoop(ports);
      const tomorrow = await morningLoop(ports);

      assert.equal(ports.tracker.handbacks.length, 1);
      assert.equal(ports.sandbox.runs.length, 1);
      assert.equal(tomorrow.outcome, "dry-queue");
    });

    it("discards the branch the failed run left behind", async () => {
      const ports = readyToWork();
      agentGivesUp(ports);

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.discarded, [
        {
          directory: checkout(`${FakeRepoHost.MANAGED_LOCATION}/${PILOT}`),
          branch: FAILED_BRANCH,
        },
      ]);
    });

    it("discards both the failed run's own branch and its ticket's earlier salvage, and clears the salvage record", async () => {
      const ports = readyToWork();
      ports.store.markSalvaged(
        { repo: PILOT, number: issueNumber(7) },
        branch("issue-7-earlier-salvage"),
        1,
      );
      agentGivesUp(ports);

      await morningLoop(ports);

      const directory = checkout(`${FakeRepoHost.MANAGED_LOCATION}/${PILOT}`);
      // The earlier salvage goes first: `handBack` discards the run's own
      // branch itself, after the stale one this iteration freed.
      assert.deepEqual(ports.repoHost.discarded, [
        { directory, branch: branch("issue-7-earlier-salvage") },
        { directory, branch: FAILED_BRANCH },
      ]);
      const state = await ports.store.loadState();
      assert.equal(state.salvages, undefined);
    });

    it("has no branch to discard when the sandbox never got as far as one", async (t) => {
      const ports = readyToWork();
      t.mock.method(ports.sandbox, "run", async () => {
        throw new Error(BROKE);
      });

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.discarded, []);
    });

    it("records what the failed run spent, since the tokens are gone either way", async () => {
      const ports = readyToWork();
      agentGivesUp(ports);

      await morningLoop(ports);

      const state = await ports.store.loadState();
      assert.deepEqual(state.projects.get(PILOT)?.runs, [
        { at: FROZEN_NOW, tokensUsed: tokenCount(42_000) },
      ]);
    });

    it("reports a tracker it could not hand the ticket back to, rather than throwing", async (t) => {
      const ports = readyToWork();
      agentGivesUp(ports);
      t.mock.method(ports.tracker, "handBack", async () => {
        throw new Error("gh is not logged in");
      });

      const report = await morningLoop(ports);

      assert.equal(failureOf(report.iterations[0])?.kind, "gave-up");
      assert.equal(handedBackOf(report.iterations[0]), "refused");
      assert.match(report.message, /gh is not logged in/);
      // The one morning the developer has to act on themselves: saying it was
      // handed back would be the opposite of what happened.
      assert.match(report.message, /still ready-for-agent/);
      assert.doesNotMatch(report.message, /Handed back for a human/);
    });

    it("hands the ticket back even when the branch will not delete", async (t) => {
      const ports = readyToWork();
      agentGivesUp(ports);
      t.mock.method(ports.repoHost, "discardBranch", async () => {
        throw new Error("used by worktree at /elsewhere");
      });

      const report = await morningLoop(ports);

      // Relabelling is the half that stops the ticket costing another
      // morning; a branch git will not delete must not take it down.
      assert.equal(handedBackOf(report.iterations[0]), "handed-back");
    });

    it("does not discard a branch when the agent committed nothing", async () => {
      const ports = readyToWork();
      ports.sandbox.result = () => ({
        kind: "gave-up",
        branch: FAILED_BRANCH,
        commits: [],
        output: SAID,
        tokensUsed: tokenCount(42_000),
        reason: GAVE_UP,
      });

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.discarded, []);
    });

    it("reports the run alongside the failure, so its commits are still visible", async () => {
      const ports = readyToWork();
      agentGivesUp(ports);

      const report = await morningLoop(ports);

      const run = ranWith(report.iterations[0]);
      assert.deepEqual(
        run?.kind === "gave-up" ? run.commits : undefined,
        [commitSha("c0ffee1")],
      );
      const failure = failureOf(report.iterations[0]);
      assert.equal(failure?.kind === "gave-up" ? failure.reason : undefined, GAVE_UP);
    });

    it("names the run's transcript in the hand-back comment, when it left one", async () => {
      const ports = readyToWork();
      const transcript = transcriptPath("/home/node/.claude/projects/-repo/session.jsonl");
      ports.sandbox.result = () => ({
        kind: "gave-up",
        branch: FAILED_BRANCH,
        commits: [commitSha("c0ffee1")],
        output: SAID,
        tokensUsed: tokenCount(42_000),
        reason: GAVE_UP,
        transcript,
      });

      await morningLoop(ports);

      assert.match(
        ports.tracker.handbacks[0]?.comment ?? "",
        endsWithTranscript(transcript),
      );
    });

    it("says nothing about a transcript in the hand-back comment, when the run left none", async () => {
      const ports = readyToWork();
      agentGivesUp(ports);

      await morningLoop(ports);

      assert.doesNotMatch(ports.tracker.handbacks[0]?.comment ?? "", /Transcript:/);
    });
  });

  describe("a run that finishes", () => {
    it("discards nothing, since a run that committed nothing left no branch behind", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });

      const report = await morningLoop(ports);

      assert.equal(failureOf(report.iterations[0]), undefined);
      assert.deepEqual(ports.repoHost.discarded, []);
    });

    it("clears a ticket's salvage record once its run finishes, discarding the earlier salvage's branch", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      ports.store.markSalvaged(
        { repo: PILOT, number: issueNumber(7) },
        branch("issue-7-earlier-salvage"),
        1,
      );
      ports.sandbox.result = () => ({
        kind: "finished",
        branch: branch("issue-7-add-the-thing"),
        commits: [commitSha("c0ffee1")],
        output: "done",
        tokensUsed: tokenCount(5_000),
      });

      await morningLoop(ports);

      assert.deepEqual(
        ports.repoHost.discarded.map((discard) => discard.branch),
        [branch("issue-7-earlier-salvage")],
      );
      const state = await ports.store.loadState();
      assert.equal(state.salvages, undefined);
    });

    it("hands the ticket back, with a comment saying it committed nothing", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      const ticket = ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });

      await morningLoop(ports);

      assert.equal(ports.tracker.handbacks.length, 1);
      assert.equal(ports.tracker.handbacks[0]?.ticket.number, ticket.number);
      assert.match(
        ports.tracker.handbacks[0]?.comment ?? "",
        /committed nothing/,
      );
      const { tickets: backlog } = backlogIn(await ports.tracker.listOpenIssues(PILOT));
      assert.deepEqual(backlog, []);
    });

    it("leaves a ticket alone when an overlapping run closed it before this one committed nothing", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      const ticket = ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      ports.sandbox.result = () => {
        // Stands in for an overlapping run finishing first: by the time this
        // run's own hand-back reaches the tracker, the ticket is already
        // closed.
        ports.tracker.closeOutOfBand(ticket);
        return {
          kind: "finished",
          branch: branch("issue-7-add-the-thing"),
          commits: [],
          output: "",
          tokensUsed: tokenCount(0),
        };
      };

      const report = await morningLoop(ports);

      assert.deepEqual(ports.tracker.handbacks, []);
      assert.equal(finished(report.iterations[0])?.handedBack.outcome, "already-closed");
      const [summary] = ports.tracker.summaries;
      assert.ok(summary);
      assert.doesNotMatch(summary.body, /relabelled/);
      assert.doesNotMatch(summary.body, /Waiting on you/);
    });

    it("takes the ticket out of the queue, so a later invocation does not select it again", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });

      await morningLoop(ports);
      const tomorrow = await morningLoop(ports);

      assert.equal(ports.sandbox.runs.length, 1);
      assert.equal(tomorrow.outcome, "dry-queue");
    });

    it("reports a tracker that refuses the relabel, rather than throwing", async (t) => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      t.mock.method(ports.tracker, "handBack", async () => {
        throw new Error("gh is not logged in");
      });

      const report = await morningLoop(ports);

      assert.equal(report.outcome, "work-selected");
      assert.match(report.message, /the hand-back itself failed/);
      assert.match(report.message, /gh is not logged in/);
    });
  });
  /**
   * The gate's own arithmetic, and how it reads the ledger and the state
   * document, are exercised directly in `budget-gate.test.ts`, against the
   * ledger and store fakes — no sandbox, no summary. What is pinned here is
   * only that the loop actually consults the gate before every run, and
   * actually stands down on a refusal.
   */
  describe("the budget gate", () => {
    /** A project with one thing to do, so the gate is the only question. */
    function readyToWork() {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      return ports;
    }

    it("starts a run while the gate says go", async () => {
      const ports = readyToWork();
      // Leaves room for the unsized ticket's own run estimate on top.
      ports.ledger.reports(
        spent({ weekly: SPENDABLE_THIS_WEEK - UNSIZED_ESTIMATE - 1 }),
      );

      const report = await morningLoop(ports);

      assert.equal(report.outcome, "work-selected");
      assert.equal(report.standDown, undefined);
      assert.equal(ports.sandbox.runs.length, 1);
    });

    /**
     * The two halves of the morning meet here: a gate that refused means no
     * run, and no run means nothing cloned, nothing recorded, and nothing to
     * hand over. A stand-down that still opened a pull request would be one
     * for a branch that was never worked.
     */
    it("stands down rather than spend a token of the reserve, starting and recording nothing", async () => {
      const ports = readyToWork();
      ports.ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK + 1 }));

      const report = await morningLoop(ports);

      assert.equal(report.outcome, "stood-down");
      assert.equal(report.standDown?.reason, "weekly-reserve");
      assert.deepEqual(ports.sandbox.runs, []);
      assert.deepEqual(ports.repoHost.clones, []);
      assert.deepEqual(ports.repoHost.pullRequests, []);
      assert.deepEqual(report.iterations, []);
      const state = await ports.store.loadState();
      assert.equal(state.projects.get(PILOT), undefined);
    });

    it("still writes state back on a morning it stood down", async (t) => {
      const ports = readyToWork();
      ports.ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK + 1 }));
      const saveState = t.mock.method(ports.store, "saveState");

      await morningLoop(ports);

      // Once for the invocation's own bookkeeping, and again once the
      // stand-down's summary — today's first — has published, to record
      // today as announced.
      assert.equal(saveState.mock.callCount(), 2);
    });

    describe("when the gate is asked", () => {
      it("tells the developer when the ledger refuses the reset they declared", async (t) => {
        const ports = readyToWork();
        t.mock.method(ports.ledger, "read", async () => {
          throw new Error(
            '"observedResetAt" is 2027-09-05T13:00:00.000Z, more than 5 hours after 2026-01-01T09:00:00.000Z',
          );
        });

        const report = await morningLoop(ports);

        // A refused instant must read like a bad budget document — described
        // in the summary, not lost to a rejected promise — because the
        // developer fixes it by editing the field the message names.
        assert.equal(report.outcome, "invocation-failed");
        assert.match(report.message, /observedResetAt/);
      });

      it("asks the gate first and the sandbox second, never the other way round", async (t) => {
        const ports = readyToWork();
        const order: string[] = [];
        t.mock.method(ports.ledger, "read", async () => {
          order.push("gate");
          return spent({});
        });
        t.mock.method(ports.sandbox, "run", async () => {
          order.push("run");
          return ports.sandbox.result({
            repo: PILOT,
            number: issueNumber(7),
            title: "Add the thing",
          });
        });

        await morningLoop(ports);

        assert.deepEqual(order, ["gate", "run"]);
      });

      it("does not read the ledger on a morning with nothing to run", async () => {
        const ports = fakePorts();
        ports.store.register(PILOT);

        const report = await morningLoop(ports);

        assert.equal(report.outcome, "dry-queue");
        assert.equal(ports.ledger.reads.length, 0);
      });

      it("asks again before a second run, standing down without starting it", async (t) => {
        const ports = readyToWork();
        ports.tracker.addEligibleTicket(PILOT, {
          number: issueNumber(8),
          title: "Add another thing",
        });
        let asked = 0;
        const read = t.mock.method(ports.ledger, "read", async () => {
          asked += 1;
          return asked === 1
            ? spent({})
            : spent({ weekly: SPENDABLE_THIS_WEEK + 1 });
        });

        const report = await morningLoop(ports);

        assert.equal(read.mock.callCount(), 2);
        assert.deepEqual(
          ports.sandbox.runs.map((run) => run.ticket.number),
          [7],
        );
        assert.equal(report.standDown?.reason, "weekly-reserve");
      });
    });

    describe("the run estimate charged", () => {
      it("carries the estimate the gate charged for the ticket, beside what the run spent", async () => {
        const ports = readyToWork();

        const report = await morningLoop(ports);

        assert.equal(finished(report.iterations[0])?.estimateCharged, UNSIZED_ESTIMATE);
      });

      it("charges a sized ticket its own size's estimate", async () => {
        const ports = fakePorts();
        ports.store.register(PILOT);
        const ticket = ports.tracker.addEligibleTicket(PILOT, {
          number: issueNumber(7),
          title: "Add the thing",
        });
        ports.tracker.addLabel(ticket, "size:L");

        const report = await morningLoop(ports);

        assert.equal(
          finished(report.iterations[0])?.estimateCharged,
          DEFAULT_BUDGET.sizes.L,
        );
      });

      it("is absent from a ticket handed back ahead of the gate, since the gate never charged one", async () => {
        const ports = fakePorts();
        ports.store.register(PILOT);
        const ticket = ports.tracker.addEligibleTicket(PILOT, {
          number: issueNumber(7),
          title: "Add the thing",
        });
        ports.tracker.addLabel(ticket, "model:opus");
        ports.tracker.addLabel(ticket, "model:haiku");

        const report = await morningLoop(ports);

        assert.equal(report.iterations[0]?.estimateCharged, undefined);
      });
    });
  });

  describe("the spend ceiling", () => {
    const PER_SIZE_CEILING = { S: usd(3), M: usd(5), L: usd(10), XL: usd(20) };

    it("gives the run the ceiling the budget declares", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      ports.store.budget = { ...DEFAULT_BUDGET, spendCeiling: usd(2.5) };

      await morningLoop(ports);

      assert.equal(ports.sandbox.runs[0]?.spendCeiling, 2.5);
    });

    it("gives a sized ticket its own size's ceiling, when spendCeiling is per size", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      const ticket = ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      ports.tracker.addLabel(ticket, "size:L");
      ports.store.budget = {
        ...DEFAULT_BUDGET,
        spendCeiling: PER_SIZE_CEILING,
      };

      await morningLoop(ports);

      assert.equal(ports.sandbox.runs[0]?.spendCeiling, 10);
    });

    it("gives an unsized ticket unsizedCountsAs's ceiling, when spendCeiling is per size", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      ports.store.budget = {
        ...DEFAULT_BUDGET,
        spendCeiling: PER_SIZE_CEILING,
        unsizedCountsAs: "S",
      };

      await morningLoop(ports);

      assert.equal(ports.sandbox.runs[0]?.spendCeiling, 3);
    });
  });

  describe("iterations in progress at once", () => {
    /** More of the week than the default budget leaves spendable. */
    const OVER_THE_RESERVE = 250_000_001;

    /** PILOT with `count` eligible tickets, numbered from 1, run up to `limit` at once. */
    function backlogOf(count: number, limit: number): FakePorts {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.store.budget = {
        ...DEFAULT_BUDGET,
        maxConcurrentIterations: iterationLimit(limit),
      };
      for (let number = 1; number <= count; number++) {
        const { repo, ...ticket } = ticketOf(number);
        ports.tracker.addEligibleTicket(repo, ticket);
      }
      return ports;
    }

    function ticketOf(number: number) {
      return {
        repo: PILOT,
        number: issueNumber(number),
        title: `Ticket ${number}`,
      } satisfies Ticket;
    }

    /** A costless, empty, finished run on `ticket`, but for what `overrides` sets. */
    function resultOf(
      ticket: Ticket,
      overrides: Partial<Omit<RunFinished, "kind">> = {},
    ): RunOutcome {
      return {
        kind: "finished",
        branch: branch(`issue-${ticket.number}`),
        commits: [],
        output: "",
        tokensUsed: tokenCount(0),
        ...overrides,
      };
    }

    /** A costless, empty run on `ticket` the provider limit refused. */
    function limitRefusedOn(ticket: Ticket): RunOutcome {
      return {
        kind: "limit-refused",
        branch: branch(`issue-${ticket.number}`),
        commits: [],
        words: LIMIT_REFUSAL,
        tokensUsed: tokenCount(0),
      };
    }

    /** A costless, empty run on `ticket` a provider failure cut off. */
    function providerFailedOn(ticket: Ticket): RunOutcome {
      return {
        kind: "provider-failed",
        branch: branch(`issue-${ticket.number}`),
        commits: [],
        words: PROVIDER_FAILURE_PROSE,
        tokensUsed: tokenCount(0),
      };
    }

    /** The numbers of `items`, each a ticket or something run on one. */
    function numbersOf(
      items: ({ number: number } | { ticket: { number: number } })[],
    ): number[] {
      return items.map((item) => ("ticket" in item ? item.ticket : item).number);
    }

    it("has up to the limit in progress, never more, and works every ticket", HANGS, async () => {
      const ports = backlogOf(5, 3);
      ports.sandbox.hold();

      const invocation = morningLoop(ports);
      await ports.sandbox.whenHeld(3);
      assert.deepEqual(numbersOf(ports.sandbox.held()), [1, 2, 3]);
      ports.sandbox.release(ticketOf(1));
      await ports.sandbox.whenHeld(3);
      ports.sandbox.release(ticketOf(2));
      await ports.sandbox.whenHeld(3);
      assert.deepEqual(numbersOf(ports.sandbox.held()), [3, 4, 5]);
      for (const number of [3, 4, 5]) {
        ports.sandbox.release(ticketOf(number));
      }
      const report = await invocation;

      assert.equal(ports.sandbox.mostInProgress, 3);
      assert.deepEqual(numbersOf(report.iterations), [1, 2, 3, 4, 5]);
    });

    it("starts no ticket twice in one invocation", async () => {
      const ports = backlogOf(4, 3);

      await morningLoop(ports);

      assert.deepEqual(
        ports.sandbox.runs.map((run) => run.ticket.number),
        [1, 2, 3, 4],
      );
    });

    it("starts no ticket its in-progress blocker still blocks", HANGS, async (t) => {
      const ports = backlogOf(1, 2);
      ports.tracker.addBlockedTicket(PILOT, { number: issueNumber(2), title: "Ticket 2" }, 1);
      ports.sandbox.hold();
      const list = ports.tracker.listOpenIssues.bind(ports.tracker);
      const rescanned = gate();
      let scans = 0;
      t.mock.method(ports.tracker, "listOpenIssues", async (repo: typeof PILOT) => {
        const backlog = await list(repo);
        if (++scans === 2) {
          rescanned.open();
        }
        return backlog;
      });

      const invocation = morningLoop(ports);
      await ports.sandbox.whenHeld(1);
      await rescanned.opened;
      assert.deepEqual(numbersOf(ports.sandbox.held()), [1]);
      ports.sandbox.release(ticketOf(1));
      await invocation;

      assert.deepEqual(numbersOf(ports.sandbox.runs), [1]);
    });

    it("stands down on the gate with two in progress, starting nothing further and reporting both", HANGS, async (t) => {
      const ports = backlogOf(3, 3);
      ports.sandbox.hold();
      const thirdAsked = gate();
      let asked = 0;
      t.mock.method(ports.ledger, "read", async () => {
        if (++asked < 3) {
          return spent({});
        }
        thirdAsked.open();
        return spent({ weekly: OVER_THE_RESERVE });
      });

      const invocation = morningLoop(ports);
      await ports.sandbox.whenHeld(2);
      await thirdAsked.opened;
      ports.sandbox.release(ticketOf(2));
      ports.sandbox.release(ticketOf(1));
      const report = await invocation;

      assert.deepEqual(numbersOf(ports.sandbox.runs), [1, 2]);
      assert.deepEqual(numbersOf(report.iterations), [1, 2]);
      assert.equal(report.standDown?.reason, "weekly-reserve");
      assert.equal(gateRefusal(report)?.refused, PILOT);
    });

    it("stands down on a limit refusal, letting the others in progress finish", HANGS, async () => {
      const ports = backlogOf(4, 3);
      ports.sandbox.result = (ticket) =>
        ticket.number === 2 ? limitRefusedOn(ticket) : resultOf(ticket);
      ports.sandbox.hold();

      const invocation = morningLoop(ports);
      await ports.sandbox.whenHeld(3);
      ports.sandbox.release(ticketOf(2));
      ports.sandbox.release(ticketOf(3));
      ports.sandbox.release(ticketOf(1));
      const report = await invocation;

      assert.deepEqual(numbersOf(ports.sandbox.runs), [1, 2, 3]);
      assert.deepEqual(
        report.iterations.map((i) => [i.ticket.number, i.kind]),
        [
          [1, "finished"],
          [2, "limit-refused"],
          [3, "finished"],
        ],
      );
      assert.equal(report.standDown?.reason, "provider-limit");
      assert.match(report.message, /pilot#2 is still ready-for-agent/);
    });

    it("stands down on the first limit refusal, not a later one", HANGS, async () => {
      const ports = backlogOf(4, 3);
      ports.sandbox.result = (ticket) =>
        ticket.number >= 2 ? limitRefusedOn(ticket) : resultOf(ticket);
      ports.sandbox.hold();

      const invocation = morningLoop(ports);
      await ports.sandbox.whenHeld(3);
      ports.sandbox.release(ticketOf(2));
      ports.sandbox.release(ticketOf(3));
      ports.sandbox.release(ticketOf(1));
      const report = await invocation;

      assert.deepEqual(numbersOf(ports.sandbox.runs), [1, 2, 3]);
      assert.ok(report.standDown?.reason === "provider-limit");
      assert.equal(report.standDown.ticket.number, 2);
    });

    it("stands down on a provider failure, letting the others in progress finish", HANGS, async () => {
      const ports = backlogOf(4, 3);
      ports.sandbox.result = (ticket) =>
        ticket.number === 2 ? providerFailedOn(ticket) : resultOf(ticket);
      ports.sandbox.hold();

      const invocation = morningLoop(ports);
      await ports.sandbox.whenHeld(3);
      ports.sandbox.release(ticketOf(2));
      ports.sandbox.release(ticketOf(3));
      ports.sandbox.release(ticketOf(1));
      const report = await invocation;

      assert.deepEqual(numbersOf(ports.sandbox.runs), [1, 2, 3]);
      assert.deepEqual(
        report.iterations.map((i) => [i.ticket.number, i.kind]),
        [
          [1, "finished"],
          [2, "provider-failed"],
          [3, "finished"],
        ],
      );
      assert.equal(report.standDown?.reason, "provider-failure");
      assert.match(report.message, /pilot#2 is still ready-for-agent/);
      assert.match(report.message, new RegExp(PROVIDER_FAILURE_PROSE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      const [summary] = ports.tracker.summaries;
      assert.ok(summary !== undefined);
      assert.doesNotMatch(summary.body, /## Waiting on you[\s\S]*#2\b/);
    });

    it("stands down on the first provider failure, not a later one", HANGS, async () => {
      const ports = backlogOf(4, 3);
      ports.sandbox.result = (ticket) =>
        ticket.number >= 2 ? providerFailedOn(ticket) : resultOf(ticket);
      ports.sandbox.hold();

      const invocation = morningLoop(ports);
      await ports.sandbox.whenHeld(3);
      ports.sandbox.release(ticketOf(2));
      ports.sandbox.release(ticketOf(3));
      ports.sandbox.release(ticketOf(1));
      const report = await invocation;

      assert.deepEqual(numbersOf(ports.sandbox.runs), [1, 2, 3]);
      assert.ok(report.standDown?.reason === "provider-failure");
      assert.equal(report.standDown.ticket.number, 2);
    });

    it("stands down for a limit-refused run that also filed a blocking discovery, and no further iteration starts", HANGS, async () => {
      const ports = backlogOf(4, 3);
      ports.sandbox.result = (ticket) =>
        ticket.number === 2
          ? {
              ...limitRefusedOn(ticket),
              discoveries: [
                {
                  kind: "correction",
                  title: "The ticket names the wrong file",
                  body: "It should touch src/widget.ts.",
                },
              ],
            }
          : resultOf(ticket);
      ports.sandbox.hold();

      const invocation = morningLoop(ports);
      await ports.sandbox.whenHeld(3);
      ports.sandbox.release(ticketOf(2));
      ports.sandbox.release(ticketOf(3));
      ports.sandbox.release(ticketOf(1));
      const report = await invocation;

      // Ticket 4 never starts: the discovery-blocked iteration on ticket 2
      // still stands the invocation down, exactly as a plain limit refusal
      // does.
      assert.deepEqual(numbersOf(ports.sandbox.runs), [1, 2, 3]);
      assert.deepEqual(
        report.iterations.map((i) => [i.ticket.number, i.kind]),
        [
          [1, "finished"],
          [2, "discovery-blocked"],
          [3, "finished"],
        ],
      );
      assert.ok(report.standDown?.reason === "provider-limit");
      assert.equal(report.standDown.ticket.number, 2);
      assert.ok(report.standDown.handedBack);
      const handback = ports.tracker.handbacks.find((entry) => entry.ticket.number === 2);
      assert.ok(handback, "ticket 2 should have been handed back");
      assert.match(report.message, /pilot#2 was handed back for the blocking discovery it filed/);
    });

    it("reports iterations in the order they started, not the order they finished", HANGS, async () => {
      const ports = backlogOf(2, 2);
      ports.sandbox.hold();

      const invocation = morningLoop(ports);
      await ports.sandbox.whenHeld(2);
      ports.sandbox.release(ticketOf(2));
      ports.sandbox.release(ticketOf(1));
      const report = await invocation;

      assert.deepEqual(numbersOf(report.iterations), [1, 2]);
    });

    it("saves every run's cost", HANGS, async () => {
      const ports = backlogOf(3, 3);
      ports.sandbox.result = (ticket) =>
        resultOf(ticket, { tokensUsed: tokenCount(ticket.number * 100) });
      ports.sandbox.hold();

      const invocation = morningLoop(ports);
      await ports.sandbox.whenHeld(3);
      for (const number of [3, 1, 2]) {
        ports.sandbox.release(ticketOf(number));
      }
      await invocation;

      const runs = (await ports.store.loadState()).projects.get(PILOT)?.runs ?? [];
      assert.deepEqual(
        runs.map((run) => run.tokensUsed).sort((a, b) => a - b),
        [100, 200, 300],
      );
    });

    it("lets the others in progress finish, and saves their cost, when one throws", HANGS, async () => {
      const ports = backlogOf(2, 2);
      ports.sandbox.result = (ticket) =>
        resultOf(ticket, {
          tokensUsed: tokenCount(ticket.number * 100),
          // Only #2 commits, so only #2 reaches the repo host below.
          ...(ticket.number === 2 && { commits: [commitSha("c0ffee2")] }),
        });
      // A repo host that throws rather than reporting how the opening went is
      // a port breaking its own contract.
      ports.repoHost.draftPullRequest = async () => {
        throw new Error("the repo host broke its contract");
      };
      ports.sandbox.hold();

      const invocation = morningLoop(ports);
      await ports.sandbox.whenHeld(2);
      ports.sandbox.release(ticketOf(2));
      ports.sandbox.release(ticketOf(1));
      const report = await invocation;

      assert.equal(report.outcome, "invocation-failed");
      assert.match(report.message, /the repo host broke its contract/);
      assert.deepEqual(
        report.iterations.map((i) => [i.ticket.number, i.kind]),
        [[1, "finished"]],
      );
      const runs = (await ports.store.loadState()).projects.get(PILOT)?.runs ?? [];
      assert.deepEqual(
        runs.map((run) => run.tokensUsed).sort((a, b) => a - b),
        [100, 200],
      );
    });
  });

  describe("a developer's stop", () => {
    /** PILOT with three eligible tickets, run up to two at once. */
    function threeTicketsTwoAtOnce(): FakePorts {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.store.budget = {
        ...DEFAULT_BUDGET,
        maxConcurrentIterations: iterationLimit(2),
      };
      for (const number of [1, 2, 3]) {
        ports.tracker.addEligibleTicket(PILOT, {
          number: issueNumber(number),
          title: `Ticket ${number}`,
        });
      }
      return ports;
    }

    /** Stops the invocation with two runs held in progress, then lets both finish. */
    async function stoppedWithTwoInProgress(
      ports: FakePorts,
    ): Promise<InvocationReport> {
      ports.sandbox.hold();
      const stop = new AbortController();

      const invocation = morningLoop(ports, { stop: stop.signal });
      await ports.sandbox.whenHeld(2);
      stop.abort();
      for (const ticket of ports.sandbox.held()) {
        ports.sandbox.release(ticket);
      }
      return invocation;
    }

    it("starts nothing further, and lets the runs in progress finish and be reported", HANGS, async () => {
      const ports = threeTicketsTwoAtOnce();

      const report = await stoppedWithTwoInProgress(ports);

      assert.deepEqual(
        ports.sandbox.runs.map((run) => run.ticket.number),
        [1, 2],
      );
      assert.deepEqual(
        report.iterations.map((i) => [i.ticket.number, i.kind]),
        [
          [1, "finished"],
          [2, "finished"],
        ],
      );
      assert.equal(report.standDown?.reason, "stopped");
      assert.equal(report.outcome, "work-selected");
    });

    it("still publishes the summary, saying it was stopped by hand", HANGS, async () => {
      const ports = threeTicketsTwoAtOnce();

      const report = await stoppedWithTwoInProgress(ports);

      assert.match(report.message, /stood down after that: stopped by hand/i);
      assert.equal(ports.tracker.summaries.length, 1);
      assert.match(ports.tracker.summaries[0]?.body ?? "", /stopped by hand/);
    });

    it("runs nothing when stopped before it starts", async () => {
      const ports = threeTicketsTwoAtOnce();
      const stop = new AbortController();
      stop.abort();

      const report = await morningLoop(ports, { stop: stop.signal });

      assert.equal(ports.sandbox.runs.length, 0);
      assert.equal(report.outcome, "stood-down");
      assert.match(report.message, /stood down: stopped by hand before any run started/i);
    });
  });

  describe("a limit refusal", () => {
    /** One project, three tickets: enough to see what the loop does after the limit. */
    function threeTickets(): FakePorts {
      const ports = fakePorts();
      ports.store.register(PILOT);
      for (const number of [1, 2, 3]) {
        ports.tracker.addEligibleTicket(PILOT, {
          number: issueNumber(number),
          title: `Ticket ${number}`,
        });
      }
      return ports;
    }

    /** Ticket 1 finishes; every run after it is refused by the limit. */
    function limitAfterTheFirstRun(ports: FakePorts): void {
      ports.sandbox.result = (ticket) =>
        ticket.number === 1
          ? {
              kind: "finished",
              branch: branch(`issue-${ticket.number}`),
              commits: [],
              output: "done",
              tokensUsed: tokenCount(5_000),
            }
          : {
              kind: "limit-refused",
              branch: branch(`issue-${ticket.number}`),
              commits: [],
              words: LIMIT_REFUSAL,
              tokensUsed: tokenCount(0),
            };
    }

    it("leaves the refused ticket exactly as it was, and runs nothing after it", async () => {
      const ports = threeTickets();
      limitAfterTheFirstRun(ports);

      const report = await morningLoop(ports);

      assert.deepEqual(
        ports.sandbox.runs.map((run) => run.ticket.number),
        [1, 2],
      );
      assert.deepEqual(
        ports.tracker.handbacks.map((handback) => handback.ticket.number),
        [1],
      );
      const { tickets: backlog } = backlogIn(await ports.tracker.listOpenIssues(PILOT));
      assert.deepEqual(
        backlog.map((ticket) => ticket.number),
        [2, 3],
      );
      assert.equal(report.standDown?.reason, "provider-limit");
    });

    it("says it stood down on the provider limit, naming the refused ticket and the reset", async () => {
      const ports = threeTickets();
      limitAfterTheFirstRun(ports);

      const report = await morningLoop(ports);

      assert.match(report.message, /stood down/i);
      assert.match(report.message, /nadav-alon\/pilot#2 is still ready-for-agent/);
      assert.match(report.message, /resets 1pm \(UTC\)/);
      const body = ports.tracker.summaries[0]?.body ?? "";
      assert.doesNotMatch(body, /pilot#2: relabelled/);
    });

    it("still records what the refused run spent", async () => {
      const ports = threeTickets();
      limitAfterTheFirstRun(ports);

      await morningLoop(ports);

      const runs = (await ports.store.loadState()).projects.get(PILOT)?.runs ?? [];
      assert.equal(runs.length, 2);
    });

    it("salvages a refused run's branch with commits, rather than discarding it, without handing the ticket back", async () => {
      const ports = threeTickets();
      ports.sandbox.result = (ticket) => ({
        kind: "limit-refused",
        branch: branch(`issue-${ticket.number}`),
        commits: [commitSha("c0ffee1")],
        words: LIMIT_REFUSAL,
        tokensUsed: tokenCount(0),
      });

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.discarded, []);
      assert.deepEqual(ports.tracker.handbacks, []);
      assert.equal(ports.repoHost.pullRequests.length, 0);
      const state = await ports.store.loadState();
      assert.deepEqual(state.salvages, [
        { repo: PILOT, number: issueNumber(1), branch: branch("issue-1"), stopShorts: 1 },
      ]);
    });

    it("still routes a refused run's advisory discoveries, without handing the ticket back", async () => {
      const ports = threeTickets();
      ports.sandbox.result = (ticket) => ({
        kind: "limit-refused",
        branch: branch(`issue-${ticket.number}`),
        commits: [],
        words: LIMIT_REFUSAL,
        tokensUsed: tokenCount(0),
        discoveries: [
          {
            kind: "clarification",
            title: "What 'the thing' means",
            body: "Read as the button.",
          },
        ],
      });

      const report = await morningLoop(ports);

      assert.equal(ports.tracker.comments.length, 1);
      assert.deepEqual(ports.tracker.handbacks, []);
      const limitRefusedIteration = report.iterations[0];
      assert.equal(
        limitRefusedIteration?.kind === "limit-refused"
          ? limitRefusedIteration.discoveryReport?.routing.filed.length
          : undefined,
        1,
      );
    });

    it("hands the ticket back for a blocking discovery a refused run filed, discarding its branch rather than salvaging it", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      const ticket = ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      ports.sandbox.result = () => ({
        kind: "limit-refused",
        branch: branch("issue-7"),
        commits: [commitSha("c0ffee1")],
        words: LIMIT_REFUSAL,
        tokensUsed: tokenCount(0),
        discoveries: [
          {
            kind: "correction",
            title: "The ticket names the wrong file",
            body: "It should touch src/widget.ts.",
          },
        ],
      });

      const report = await morningLoop(ports);

      assert.equal(report.iterations[0]?.kind, "discovery-blocked");
      assert.deepEqual(
        report.iterations[0]?.kind === "discovery-blocked" ? report.iterations[0].cutOff : undefined,
        { kind: "limit-refused", limitRefusal: LIMIT_REFUSAL },
      );
      const handback = ports.tracker.handbacks.find(
        (entry) => entry.ticket.number === ticket.number,
      );
      assert.ok(handback, "the ticket should have been handed back");
      assert.match(handback.comment, /blocking discovery/);
      assert.deepEqual(ports.repoHost.discarded, [
        { directory: checkout(`${FakeRepoHost.MANAGED_LOCATION}/${PILOT}`), branch: branch("issue-7") },
      ]);
      const state = await ports.store.loadState();
      assert.equal(state.salvages, undefined);
      assert.ok(report.standDown?.reason === "provider-limit");
      assert.equal(report.standDown.ticket.number, ticket.number);
      assert.ok(report.standDown.handedBack);
      assert.match(report.message, /pilot#7 was handed back for the blocking discovery it filed/);
    });

    it("discards a refused run's branch when it carries no commits, and leaves any existing salvage record unchanged", async () => {
      const ports = threeTickets();
      ports.store.markSalvaged(
        { repo: PILOT, number: issueNumber(1) },
        branch("issue-1-earlier-salvage"),
        1,
      );
      ports.sandbox.result = (ticket) => ({
        kind: "limit-refused",
        branch: branch(`issue-${ticket.number}`),
        commits: [],
        words: LIMIT_REFUSAL,
        tokensUsed: tokenCount(0),
      });

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.discarded, []);
      const state = await ports.store.loadState();
      assert.deepEqual(state.salvages, [
        {
          repo: PILOT,
          number: issueNumber(1),
          branch: branch("issue-1-earlier-salvage"),
          stopShorts: 1,
        },
      ]);
    });

    it("raises the count on a second limit refusal of the same ticket's salvage, keeping the same branch", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, { number: issueNumber(1), title: "Ticket 1" });
      const SALVAGED_BRANCH = branch("issue-1");
      ports.sandbox.result = () => ({
        kind: "limit-refused",
        branch: SALVAGED_BRANCH,
        commits: [commitSha("c0ffee1")],
        words: LIMIT_REFUSAL,
        tokensUsed: tokenCount(0),
      });

      await morningLoop(ports);
      const second = await morningLoop(ports);

      const state = await ports.store.loadState();
      assert.deepEqual(state.salvages, [
        { repo: PILOT, number: issueNumber(1), branch: SALVAGED_BRANCH, stopShorts: 2 },
      ]);
      assert.deepEqual(limitRefused(second.iterations[0])?.discard, {
        kind: "salvaged",
        branch: SALVAGED_BRANCH,
        stopShorts: 2,
      });
    });

    it("discards a ticket's earlier salvage branch when a second limit refusal salvages a different one", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, { number: issueNumber(1), title: "Ticket 1" });
      const branches = [branch("issue-1"), branch("issue-1-2")];
      ports.sandbox.result = () => ({
        kind: "limit-refused",
        branch: branches.shift() ?? branch("issue-1-2"),
        commits: [commitSha("c0ffee1")],
        words: LIMIT_REFUSAL,
        tokensUsed: tokenCount(0),
      });

      await morningLoop(ports);
      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.discarded, [
        {
          directory: checkout(`${FakeRepoHost.MANAGED_LOCATION}/${PILOT}`),
          branch: branch("issue-1"),
        },
      ]);
      const state = await ports.store.loadState();
      assert.deepEqual(state.salvages, [
        { repo: PILOT, number: issueNumber(1), branch: branch("issue-1-2"), stopShorts: 2 },
      ]);
    });

    it("carries the ticket's salvage branch on the next run request", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, { number: issueNumber(1), title: "Ticket 1" });
      const SALVAGED_BRANCH = branch("issue-1-salvage");
      ports.store.markSalvaged({ repo: PILOT, number: issueNumber(1) }, SALVAGED_BRANCH, 1);

      await morningLoop(ports);

      assert.equal(ports.sandbox.runs[0]?.salvageBranch, SALVAGED_BRANCH);
    });

    it("leaves the run request's salvage branch absent when the ticket carries no salvage record", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, { number: issueNumber(1), title: "Ticket 1" });

      await morningLoop(ports);

      assert.equal(ports.sandbox.runs[0]?.salvageBranch, undefined);
    });

    it("stands down just the same when it refuses a review, leaving the review open", async () => {
      const ports = threeTickets();
      const review = ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(42),
        title: "Review the draft pull request for #7",
        pullRequest: {
          kind: "review",
          url: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
        },
      });
      ports.sandbox.reviewResult = () => ({
        kind: "limit-refused",
        words: LIMIT_REFUSAL,
        tokensUsed: tokenCount(0),
      });

      const report = await morningLoop(ports);

      assert.equal(ports.sandbox.runs.length, 0);
      assert.deepEqual(ports.tracker.closedReviewTickets, []);
      const { tickets: backlog } = backlogIn(await ports.tracker.listOpenIssues(PILOT));
      assert.ok(backlog.some((ticket) => ticket.number === review.number));
      assert.equal(report.standDown?.reason, "provider-limit");
    });

    it("still routes a refused review's advisory discoveries onto its implementation ticket, without handing either back", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      const review = ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(42),
        title: "Review the draft pull request for #7",
        pullRequest: { kind: "review", url: PULL_REQUEST },
        parent: issueNumber(7),
      });
      ports.sandbox.reviewResult = () => ({
        kind: "limit-refused",
        words: LIMIT_REFUSAL,
        tokensUsed: tokenCount(0),
        discoveries: [
          {
            kind: "clarification",
            title: "What 'the thing' means",
            body: "Read as the button.",
          },
        ],
      });

      const report = await morningLoop(ports);

      assert.equal(ports.tracker.comments.length, 1);
      assert.equal(ports.tracker.comments[0]?.ticket.number, issueNumber(7));
      assert.deepEqual(ports.tracker.handbacks, []);
      const { tickets: backlog } = backlogIn(await ports.tracker.listOpenIssues(PILOT));
      assert.ok(backlog.some((ticket) => ticket.number === review.number));
      const limitRefusedIteration = report.iterations[0];
      assert.equal(
        limitRefusedIteration?.kind === "limit-refused"
          ? limitRefusedIteration.discoveryReport?.routing.filed.length
          : undefined,
        1,
      );
    });

    it("hands the review ticket back for a blocking discovery a refused review filed, not the implementation ticket", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      const review = ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(42),
        title: "Review the draft pull request for #7",
        pullRequest: { kind: "review", url: PULL_REQUEST },
        parent: issueNumber(7),
      });
      ports.sandbox.reviewResult = () => ({
        kind: "limit-refused",
        words: LIMIT_REFUSAL,
        tokensUsed: tokenCount(0),
        discoveries: [
          {
            kind: "correction",
            title: "The ticket names the wrong file",
            body: "It should touch src/widget.ts.",
          },
        ],
      });

      const report = await morningLoop(ports);

      assert.equal(report.iterations[0]?.kind, "discovery-blocked");
      const handback = ports.tracker.handbacks[0];
      assert.equal(handback?.ticket.number, review.number);
      assert.notEqual(handback?.ticket.number, issueNumber(7));
      assert.match(handback?.comment ?? "", /blocking discovery/);
      const { tickets: backlog } = backlogIn(await ports.tracker.listOpenIssues(PILOT));
      assert.ok(!backlog.some((ticket) => ticket.number === review.number));
      assert.ok(report.standDown?.reason === "provider-limit");
      assert.equal(report.standDown.ticket.number, review.number);
      assert.ok(report.standDown.handedBack);
    });

    it("hands the review ticket back for a blocking discovery a provider-failed review filed, and still stands down", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      const review = ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(42),
        title: "Review the draft pull request for #7",
        pullRequest: { kind: "review", url: PULL_REQUEST },
        parent: issueNumber(7),
      });
      ports.sandbox.reviewResult = () => ({
        kind: "provider-failed",
        words: PROVIDER_FAILURE_PROSE,
        tokensUsed: tokenCount(0),
        discoveries: [
          {
            kind: "prerequisite",
            title: "Needs the widget port first",
            body: "There is no widget port to build this against yet.",
          },
        ],
      });

      const report = await morningLoop(ports);

      assert.equal(report.iterations[0]?.kind, "discovery-blocked");
      assert.deepEqual(
        report.iterations[0]?.kind === "discovery-blocked" ? report.iterations[0].cutOff : undefined,
        { kind: "provider-failed", providerFailure: PROVIDER_FAILURE_PROSE },
      );
      const handback = ports.tracker.handbacks[0];
      assert.equal(handback?.ticket.number, review.number);
      assert.match(handback?.comment ?? "", /blocking discovery/);
      const { tickets: backlog } = backlogIn(await ports.tracker.listOpenIssues(PILOT));
      assert.ok(!backlog.some((ticket) => ticket.number === review.number));
      assert.ok(report.standDown?.reason === "provider-failure");
      assert.equal(report.standDown.ticket.number, review.number);
      assert.ok(report.standDown.handedBack);
    });

    it("still routes a refused apply-review's advisory discoveries onto its implementation ticket, without handing either back", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      const applyReview = ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(43),
        title: "Apply the review on the draft pull request for #7",
        pullRequest: { kind: "apply-review", url: PULL_REQUEST },
        parent: issueNumber(7),
      });
      ports.repoHost.openApplyReviewThread(PULL_REQUEST);
      ports.sandbox.applyReviewResult = () => ({
        kind: "limit-refused",
        words: LIMIT_REFUSAL,
        tokensUsed: tokenCount(0),
        discoveries: [
          {
            kind: "clarification",
            title: "What 'the thing' means",
            body: "Read as the button.",
          },
        ],
      });

      const report = await morningLoop(ports);

      assert.equal(ports.tracker.comments.length, 1);
      assert.equal(ports.tracker.comments[0]?.ticket.number, issueNumber(7));
      assert.deepEqual(ports.tracker.handbacks, []);
      const { tickets: backlog } = backlogIn(await ports.tracker.listOpenIssues(PILOT));
      assert.ok(backlog.some((ticket) => ticket.number === applyReview.number));
      const limitRefusedIteration = report.iterations[0];
      assert.equal(
        limitRefusedIteration?.kind === "limit-refused"
          ? limitRefusedIteration.discoveryReport?.routing.filed.length
          : undefined,
        1,
      );
    });

    it("hands the apply-review ticket back for a blocking discovery a refused run filed, not the implementation ticket", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      const applyReview = ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(43),
        title: "Apply the review on the draft pull request for #7",
        pullRequest: { kind: "apply-review", url: PULL_REQUEST },
        parent: issueNumber(7),
      });
      ports.repoHost.openApplyReviewThread(PULL_REQUEST);
      ports.sandbox.applyReviewResult = () => ({
        kind: "limit-refused",
        words: LIMIT_REFUSAL,
        tokensUsed: tokenCount(0),
        discoveries: [
          {
            kind: "correction",
            title: "The ticket names the wrong file",
            body: "It should touch src/widget.ts.",
          },
        ],
      });

      const report = await morningLoop(ports);

      assert.equal(report.iterations[0]?.kind, "discovery-blocked");
      const handback = ports.tracker.handbacks[0];
      assert.equal(handback?.ticket.number, applyReview.number);
      assert.notEqual(handback?.ticket.number, issueNumber(7));
      assert.match(handback?.comment ?? "", /blocking discovery/);
      const { tickets: backlog } = backlogIn(await ports.tracker.listOpenIssues(PILOT));
      assert.ok(!backlog.some((ticket) => ticket.number === applyReview.number));
    });

    it("still routes a refused rebase's advisory discoveries onto its implementation ticket, without handing either back", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      const rebase = ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(44),
        title: "Rebase the draft pull request for #7",
        pullRequest: { kind: "rebase", url: PULL_REQUEST },
        parent: issueNumber(7),
      });
      ports.repoHost.mergeStatus = () => "conflicting";
      ports.sandbox.rebaseResult = () => ({
        kind: "limit-refused",
        words: LIMIT_REFUSAL,
        tokensUsed: tokenCount(0),
        discoveries: [
          {
            kind: "clarification",
            title: "What 'the thing' means",
            body: "Read as the button.",
          },
        ],
      });

      const report = await morningLoop(ports);

      assert.equal(ports.tracker.comments.length, 1);
      assert.equal(ports.tracker.comments[0]?.ticket.number, issueNumber(7));
      assert.deepEqual(ports.tracker.handbacks, []);
      const { tickets: backlog } = backlogIn(await ports.tracker.listOpenIssues(PILOT));
      assert.ok(backlog.some((ticket) => ticket.number === rebase.number));
      const limitRefusedIteration = report.iterations[0];
      assert.equal(
        limitRefusedIteration?.kind === "limit-refused"
          ? limitRefusedIteration.discoveryReport?.routing.filed.length
          : undefined,
        1,
      );
    });

    it("hands the rebase ticket back for a blocking discovery a refused run filed, not the implementation ticket", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      const rebase = ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(44),
        title: "Rebase the draft pull request for #7",
        pullRequest: { kind: "rebase", url: PULL_REQUEST },
        parent: issueNumber(7),
      });
      ports.repoHost.mergeStatus = () => "conflicting";
      ports.sandbox.rebaseResult = () => ({
        kind: "limit-refused",
        words: LIMIT_REFUSAL,
        tokensUsed: tokenCount(0),
        discoveries: [
          {
            kind: "correction",
            title: "The ticket names the wrong file",
            body: "It should touch src/widget.ts.",
          },
        ],
      });

      const report = await morningLoop(ports);

      assert.equal(report.iterations[0]?.kind, "discovery-blocked");
      const handback = ports.tracker.handbacks[0];
      assert.equal(handback?.ticket.number, rebase.number);
      assert.notEqual(handback?.ticket.number, issueNumber(7));
      assert.match(handback?.comment ?? "", /blocking discovery/);
      const { tickets: backlog } = backlogIn(await ports.tracker.listOpenIssues(PILOT));
      assert.ok(!backlog.some((ticket) => ticket.number === rebase.number));
    });
  });

  describe("a spend-ceiling ending", () => {
    /**
     * Unlike a limit refusal or a provider failure, one run's own spend
     * ceiling says nothing about the next run's — a ticket needing more room
     * is not a sign every other ticket this morning would hit the same wall —
     * so it must never stand the invocation down.
     */
    it("does not stand the invocation down, and runs every ticket after it", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      for (const number of [1, 2, 3]) {
        ports.tracker.addEligibleTicket(PILOT, {
          number: issueNumber(number),
          title: `Ticket ${number}`,
        });
      }
      ports.sandbox.result = (ticket) =>
        ticket.number === 1
          ? {
              kind: "budget-exhausted",
              branch: branch(`issue-${ticket.number}`),
              commits: [],
              words: BUDGET_EXHAUSTED_JSON_RESULT,
              tokensUsed: tokenCount(0),
            }
          : {
              kind: "finished",
              branch: branch(`issue-${ticket.number}`),
              commits: [],
              output: "done",
              tokensUsed: tokenCount(5_000),
            };

      const report = await morningLoop(ports);

      assert.deepEqual(
        ports.sandbox.runs.map((run) => run.ticket.number),
        [1, 2, 3],
      );
      assert.equal(report.standDown, undefined);
    });

    it("salvages a budget-exhausted run's branch with commits, rather than discarding it, without handing the ticket back", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, { number: issueNumber(1), title: "Ticket 1" });
      ports.sandbox.result = (ticket) => ({
        kind: "budget-exhausted",
        branch: branch(`issue-${ticket.number}`),
        commits: [commitSha("c0ffee1")],
        words: BUDGET_EXHAUSTED_JSON_RESULT,
        tokensUsed: tokenCount(0),
      });

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.discarded, []);
      assert.deepEqual(ports.tracker.handbacks, []);
      assert.equal(ports.repoHost.pullRequests.length, 0);
      const state = await ports.store.loadState();
      assert.deepEqual(state.salvages, [
        { repo: PILOT, number: issueNumber(1), branch: branch("issue-1"), stopShorts: 1 },
      ]);
    });

    it("discards a budget-exhausted run's branch when it carries no commits, and leaves any existing salvage record unchanged", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, { number: issueNumber(1), title: "Ticket 1" });
      ports.store.markSalvaged(
        { repo: PILOT, number: issueNumber(1) },
        branch("issue-1-earlier-salvage"),
        1,
      );
      ports.sandbox.result = (ticket) => ({
        kind: "budget-exhausted",
        branch: branch(`issue-${ticket.number}`),
        commits: [],
        words: BUDGET_EXHAUSTED_JSON_RESULT,
        tokensUsed: tokenCount(0),
      });

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.discarded, []);
      const state = await ports.store.loadState();
      assert.deepEqual(state.salvages, [
        {
          repo: PILOT,
          number: issueNumber(1),
          branch: branch("issue-1-earlier-salvage"),
          stopShorts: 1,
        },
      ]);
    });

    it("raises the same salvage count a limit refusal would, when it follows one on the same ticket", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, { number: issueNumber(1), title: "Ticket 1" });
      const SALVAGED_BRANCH = branch("issue-1");
      ports.sandbox.result = () => ({
        kind: "limit-refused",
        branch: SALVAGED_BRANCH,
        commits: [commitSha("c0ffee1")],
        words: LIMIT_REFUSAL,
        tokensUsed: tokenCount(0),
      });

      await morningLoop(ports);
      ports.sandbox.result = () => ({
        kind: "budget-exhausted",
        branch: SALVAGED_BRANCH,
        commits: [commitSha("c0ffee2")],
        words: BUDGET_EXHAUSTED_JSON_RESULT,
        tokensUsed: tokenCount(0),
      });
      const second = await morningLoop(ports);

      const state = await ports.store.loadState();
      assert.deepEqual(state.salvages, [
        { repo: PILOT, number: issueNumber(1), branch: SALVAGED_BRANCH, stopShorts: 2 },
      ]);
      assert.deepEqual(budgetExhausted(second.iterations[0])?.discard, {
        kind: "salvaged",
        branch: SALVAGED_BRANCH,
        stopShorts: 2,
      });
    });

    it("stands down neither, when it stops a review's run, leaving the review open", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      const review = ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(42),
        title: "Review the draft pull request for #7",
        pullRequest: {
          kind: "review",
          url: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
        },
      });
      ports.sandbox.reviewResult = () => ({
        kind: "budget-exhausted",
        words: BUDGET_EXHAUSTED_JSON_RESULT,
        tokensUsed: tokenCount(0),
      });

      const report = await morningLoop(ports);

      assert.deepEqual(ports.tracker.closedReviewTickets, []);
      const { tickets: backlog } = backlogIn(await ports.tracker.listOpenIssues(PILOT));
      assert.ok(backlog.some((ticket) => ticket.number === review.number));
      assert.equal(report.standDown, undefined);
    });
  });

  describe("a provider failure", () => {
    it("discards any branch the cut-off run left, without handing the ticket back", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      const ticket = ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      ports.sandbox.result = () => ({
        kind: "provider-failed",
        branch: branch(`issue-${ticket.number}`),
        commits: [commitSha("c0ffee1")],
        words: PROVIDER_FAILURE_PROSE,
        tokensUsed: tokenCount(0),
      });

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.discarded, [
        {
          directory: checkout(`${FakeRepoHost.MANAGED_LOCATION}/${PILOT}`),
          branch: branch("issue-7"),
        },
      ]);
      assert.deepEqual(ports.tracker.handbacks, []);
      assert.equal(ports.repoHost.pullRequests.length, 0);
    });

    it("hands the ticket back for a blocking discovery a provider-failed run filed, instead of leaving it eligible", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      const ticket = ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      ports.sandbox.result = () => ({
        kind: "provider-failed",
        branch: branch("issue-7"),
        commits: [commitSha("c0ffee1")],
        words: PROVIDER_FAILURE_PROSE,
        tokensUsed: tokenCount(0),
        discoveries: [
          {
            kind: "prerequisite",
            title: "Needs the widget port first",
            body: "There is no widget port to build this against yet.",
          },
        ],
      });

      const report = await morningLoop(ports);

      assert.equal(report.iterations[0]?.kind, "discovery-blocked");
      assert.deepEqual(
        report.iterations[0]?.kind === "discovery-blocked" ? report.iterations[0].cutOff : undefined,
        { kind: "provider-failed", providerFailure: PROVIDER_FAILURE_PROSE },
      );
      const handback = ports.tracker.handbacks.find(
        (entry) => entry.ticket.number === ticket.number,
      );
      assert.ok(handback, "the ticket should have been handed back");
      assert.match(handback.comment, /blocking discovery/);
      assert.deepEqual(ports.repoHost.discarded, [
        { directory: checkout(`${FakeRepoHost.MANAGED_LOCATION}/${PILOT}`), branch: branch("issue-7") },
      ]);
      const state = await ports.store.loadState();
      assert.equal(state.salvages, undefined);
      assert.ok(report.standDown?.reason === "provider-failure");
      assert.equal(report.standDown.ticket.number, ticket.number);
      assert.ok(report.standDown.handedBack);
      assert.match(report.message, /pilot#7 was handed back for the blocking discovery it filed/);
    });
  });

  describe("the model a run uses", () => {
    const OPUS = modelName("opus");
    const HAIKU = modelName("haiku");

    /** One project with one implementation ticket, #7. */
    function oneTicket(): { ports: FakePorts; ticket: Ticket } {
      const ports = fakePorts();
      ports.store.register(PILOT);
      const ticket = ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      return { ports, ticket };
    }

    it("asks the sandbox for no model when the ticket has no model label and there are no model defaults", async () => {
      const { ports } = oneTicket();

      await morningLoop(ports);

      assert.equal(ports.sandbox.runs.length, 1);
      assert.equal(ports.sandbox.runs[0]?.model, undefined);
    });

    it("reads the model defaults once per invocation, however many tickets it works", async () => {
      const { ports } = oneTicket();
      ports.tracker.addEligibleTicket(PILOT, { number: issueNumber(8), title: "Next" });
      ports.tracker.addEligibleTicket(PILOT, { number: issueNumber(9), title: "After" });
      ports.store.modelDefaults = { implementation: OPUS };
      let reads = 0;
      const load = ports.store.loadModelDefaults.bind(ports.store);
      ports.store.loadModelDefaults = async () => {
        reads += 1;
        return load();
      };

      await morningLoop(ports);

      assert.equal(ports.sandbox.runs.length, 3);
      assert.equal(reads, 1);
    });

    it("runs an implementation ticket without a model label on the implementation default", async () => {
      const { ports } = oneTicket();
      ports.store.modelDefaults = { implementation: OPUS };

      await morningLoop(ports);

      assert.equal(ports.sandbox.runs[0]?.model, OPUS);
    });

    it("runs a review on the review default, and an implementation ticket not", async () => {
      const { ports } = oneTicket();
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(42),
        title: reviewTitle({ repo: PILOT, number: issueNumber(6), title: "Earlier" }),
        pullRequest: {
          kind: "review",
          url: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
        },
      });
      ports.store.modelDefaults = { review: HAIKU };

      await morningLoop(ports);

      assert.equal(ports.sandbox.reviews[0]?.model, HAIKU);
      assert.equal(ports.sandbox.runs.length, 1);
      assert.equal(ports.sandbox.runs[0]?.model, undefined);
    });

    it("runs an apply-review ticket on the apply-review default, and an implementation ticket not", async () => {
      const { ports } = oneTicket();
      const pullRequest = pullRequestUrl(
        "https://github.com/nadav-alon/pilot/pull/12",
      );
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(42),
        title: `Apply the review on ${pullRequest}`,
        pullRequest: { kind: "apply-review", url: pullRequest },
      });
      // A pull request with nothing open to apply runs nothing at all.
      ports.repoHost.openApplyReviewThread(pullRequest);
      ports.store.modelDefaults = { "apply-review": HAIKU };

      await morningLoop(ports);

      assert.equal(ports.sandbox.applyReviews[0]?.model, HAIKU);
      assert.equal(ports.sandbox.runs.length, 1);
      assert.equal(ports.sandbox.runs[0]?.model, undefined);
    });

    it("runs a ticket on its model label rather than the default for its kind", async () => {
      const { ports, ticket } = oneTicket();
      ports.tracker.addLabel(ticket, "model:opus");
      ports.store.modelDefaults = { implementation: HAIKU };

      await morningLoop(ports);

      assert.equal(ports.sandbox.runs[0]?.model, OPUS);
    });

    it("never runs a review ticket on its parent's model label", async () => {
      const { ports, ticket } = oneTicket();
      ports.tracker.addLabel(ticket, "model:opus");
      ports.sandbox.result = () => ({
        kind: "finished",
        branch: branch("issue-7-add-the-thing"),
        commits: [commitSha("c0ffee1")],
        output: "",
        tokensUsed: tokenCount(1_000),
      });

      await morningLoop(ports);

      assert.equal(ports.sandbox.runs[0]?.model, OPUS);
      assert.equal(ports.sandbox.reviews.length, 1);
      assert.equal(ports.sandbox.reviews[0]?.model, undefined);
      assert.equal(ports.sandbox.reviews[0]?.ticket.modelLabel, undefined);
    });

    describe("a ticket carrying two model labels", () => {
      it("is handed back naming both and saying to keep one, and never run", async () => {
        const { ports, ticket } = oneTicket();
        ports.tracker.addLabel(ticket, "model:opus");
        ports.tracker.addLabel(ticket, "model:haiku");

        const report = await morningLoop(ports);

        assert.deepEqual(ports.sandbox.runs, []);
        assert.deepEqual(ports.repoHost.clones, []);
        // The comment's own wording is covered by hand-back.test.ts; here it
        // is enough that the hand back happened, without a run.
        assert.equal(ports.tracker.handbacks.length, 1);
        assert.deepEqual(backlogIn(await ports.tracker.listOpenIssues(PILOT)).tickets, []);
        assert.equal(failureOf(report.iterations[0])?.kind, "conflicting-model-labels");
      });

      it("spends nothing, and the invocation carries on to the next ticket", async () => {
        const { ports, ticket } = oneTicket();
        ports.tracker.addLabel(ticket, "model:opus");
        ports.tracker.addLabel(ticket, "model:haiku");
        ports.tracker.addEligibleTicket(PILOT, { number: issueNumber(8), title: "Next" });

        await morningLoop(ports);

        assert.deepEqual(
          ports.sandbox.runs.map((run) => run.ticket.number),
          [8],
        );
        const runs = (await ports.store.loadState()).projects.get(PILOT)?.runs ?? [];
        assert.equal(runs.length, 1);
      });

      it("is handed back even when the gate then stands the morning down, which still reads as a stand-down", async () => {
        const { ports, ticket } = oneTicket();
        ports.tracker.addLabel(ticket, "model:opus");
        ports.tracker.addLabel(ticket, "model:haiku");
        ports.tracker.addEligibleTicket(PILOT, { number: issueNumber(8), title: "Next" });
        ports.ledger.reports(spent({ weekly: DEFAULT_BUDGET.weeklyAllowance }));

        const report = await morningLoop(ports);

        assert.equal(ports.tracker.handbacks.length, 1);
        assert.deepEqual(ports.sandbox.runs, []);
        assert.equal(report.outcome, "stood-down");
      });
    });

    it("hands back a ticket whose model label names no usable model, and never runs it", async () => {
      const { ports, ticket } = oneTicket();
      ports.tracker.addLabel(ticket, "model:");

      await morningLoop(ports);

      assert.deepEqual(ports.sandbox.runs, []);
      // The comment's own wording is covered by hand-back.test.ts.
      assert.equal(ports.tracker.handbacks.length, 1);
    });

    describe("a ticket whose size label names no size the budget document knows", () => {
      /**
       * Runs the invocation, returning the state as it was saved the instant
       * the ticket's hand-back comment was posted — the sibling of
       * `savedWhenRunStarted` above, for the ahead-of-gate path. Unlike
       * `Sandbox.run`, `IssueTracker.handBack` (`ports/issue-tracker.ts:722`)
       * carries a single signature, so the mock can bind straight through to
       * the original rather than reimplementing it.
       */
      async function savedWhenHandedBack(
        ports: FakePorts,
        t: TestContext,
      ): Promise<State | undefined> {
        let saved: State | undefined;
        const original = ports.tracker.handBack.bind(ports.tracker);
        t.mock.method(
          ports.tracker,
          "handBack",
          async (handedBackTicket: Ticket, comment: string) => {
            saved = await ports.store.loadState();
            return original(handedBackTicket, comment);
          },
        );
        await morningLoop(ports);
        return saved;
      }

      it("is handed back before the gate, and never run", async () => {
        const { ports, ticket } = oneTicket();
        ports.tracker.addLabel(ticket, "size:XXL");

        const report = await morningLoop(ports);

        assert.deepEqual(ports.sandbox.runs, []);
        assert.deepEqual(ports.repoHost.clones, []);
        // The comment's exact wording is covered by hand-back.test.ts; here
        // it is enough that it quotes the offending label.
        assert.equal(ports.tracker.handbacks.length, 1);
        assert.match(ports.tracker.handbacks[0]?.comment ?? "", /size:XXL/);
        assert.deepEqual(backlogIn(await ports.tracker.listOpenIssues(PILOT)).tickets, []);
        assert.equal(failureOf(report.iterations[0])?.kind, "unusable-size-label");
      });

      it("is recorded as worked today, so a later firing the same day does not select it again", async () => {
        const { ports, ticket } = oneTicket();
        ports.tracker.addLabel(ticket, "size:XXL");
        ports.tracker.addEligibleTicket(PILOT, { number: issueNumber(8), title: "Next" });

        await morningLoop(ports);

        assert.deepEqual(
          ports.sandbox.runs.map((run) => run.ticket.number),
          [8],
        );
      });

      it("saves the worked-today record before the hand-back is posted, so a process stopped mid-post still leaves it recorded", async (t) => {
        const { ports, ticket } = oneTicket();
        ports.tracker.addLabel(ticket, "size:XXL");

        const saved = await savedWhenHandedBack(ports, t);

        assert.deepEqual(saved?.workedToday, {
          day: localDay(FROZEN_NOW),
          tickets: [{ repo: PILOT, number: issueNumber(7) }],
        });
      });

      it("is handed back even when the gate then stands the morning down, which still reads as a stand-down", async () => {
        const { ports, ticket } = oneTicket();
        ports.tracker.addLabel(ticket, "size:XXL");
        ports.tracker.addEligibleTicket(PILOT, { number: issueNumber(8), title: "Next" });
        ports.ledger.reports(spent({ weekly: DEFAULT_BUDGET.weeklyAllowance }));

        const report = await morningLoop(ports);

        assert.equal(ports.tracker.handbacks.length, 1);
        assert.deepEqual(ports.sandbox.runs, []);
        assert.equal(report.outcome, "stood-down");
      });

      it("never hands back a pull request ticket over one, since runEstimate ignores its size label", async () => {
        const ports = fakePorts();
        ports.store.register(PILOT);
        const review = ports.tracker.addEligibleTicket(PILOT, {
          number: issueNumber(42),
          title: reviewTitle({ repo: PILOT, number: issueNumber(6), title: "Earlier" }),
          pullRequest: {
            kind: "review",
            url: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
          },
        });
        ports.tracker.addLabel(review, "size:XXL");

        await morningLoop(ports);

        // Ahead of the gate is caught before the sandbox is ever asked to
        // run anything, so reaching the sandbox proves it was not caught.
        assert.equal(ports.sandbox.reviews.length, 1);
      });
    });

    describe("a model the agent CLI refuses", () => {
      it("hands the ticket back naming the model, its model label, and the CLI's words", async () => {
        const { ports, ticket } = oneTicket();
        ports.tracker.addLabel(ticket, "model:opus");
        ports.sandbox.result = () => ({
          kind: "model-refused",
          branch: branch(`fake/${PILOT}/7`),
          commits: [],
          tokensUsed: tokenCount(0),
          refusal: { model: OPUS, words: "refused model opus" },
        });

        const report = await morningLoop(ports);

        // The comment's own wording is covered by hand-back.test.ts; here it
        // is enough that the hand back happened, for the failure this
        // iteration reports.
        assert.equal(ports.tracker.handbacks.length, 1);
        assert.equal(failureOf(report.iterations[0])?.kind, "model-refused");
        assert.deepEqual(backlogIn(await ports.tracker.listOpenIssues(PILOT)).tickets, []);
      });

      it("says the model came from the model defaults when it did", async () => {
        const { ports } = oneTicket();
        ports.store.modelDefaults = { implementation: OPUS };
        ports.sandbox.result = () => ({
          kind: "model-refused",
          branch: branch(`fake/${PILOT}/7`),
          commits: [],
          tokensUsed: tokenCount(0),
          refusal: { model: OPUS, words: "refused model opus" },
        });

        await morningLoop(ports);

        const comment = ports.tracker.handbacks[0]?.comment ?? "";
        assert.match(comment, /model defaults/);
        assert.match(comment, /fix the implementation model in `models\.json`/);
      });

      it("hands back a review ticket whose model is refused, rather than leaving it to come round again", async () => {
        const ports = fakePorts();
        ports.store.register(PILOT);
        ports.tracker.addEligibleTicket(PILOT, {
          number: issueNumber(42),
          title: reviewTitle({ repo: PILOT, number: issueNumber(6), title: "Earlier" }),
          pullRequest: {
            kind: "review",
            url: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
          },
        });
        ports.store.modelDefaults = { review: HAIKU };
        ports.sandbox.reviewResult = () => ({
          kind: "model-refused",
          tokensUsed: tokenCount(0),
          refusal: { model: HAIKU, words: "refused model haiku" },
        });

        const report = await morningLoop(ports);

        assert.equal(ports.tracker.handbacks.length, 1);
        assert.match(ports.tracker.handbacks[0]?.comment ?? "", /haiku/);
        assert.deepEqual(ports.tracker.closedReviewTickets, []);
        assert.equal(failureOf(report.iterations[0])?.kind, "model-refused");
        assert.deepEqual(ports.repoHost.labelled, []);
      });

      it("hands back an apply-review ticket whose model is refused, naming the apply-review model defaults", async () => {
        const ports = fakePorts();
        ports.store.register(PILOT);
        const pullRequest = pullRequestUrl(
          "https://github.com/nadav-alon/pilot/pull/12",
        );
        ports.tracker.addEligibleTicket(PILOT, {
          number: issueNumber(42),
          title: `Apply the review on ${pullRequest}`,
          pullRequest: { kind: "apply-review", url: pullRequest },
        });
        ports.repoHost.openApplyReviewThread(pullRequest);
        ports.store.modelDefaults = { "apply-review": HAIKU };
        ports.sandbox.applyReviewResult = () => ({
          kind: "model-refused",
          tokensUsed: tokenCount(0),
          refusal: { model: HAIKU, words: "refused model haiku" },
        });

        const report = await morningLoop(ports);

        assert.equal(ports.tracker.handbacks.length, 1);
        const comment = ports.tracker.handbacks[0]?.comment ?? "";
        assert.match(comment, /haiku/);
        assert.match(comment, /model defaults for apply-review tickets/);
        assert.match(comment, /fix the apply-review model in `models\.json`/);
        assert.equal(failureOf(report.iterations[0])?.kind, "model-refused");
        assert.deepEqual(ports.repoHost.labelled, []);
      });

      it("discards any branch the refused run left, and says so", async () => {
        const { ports, ticket } = oneTicket();
        ports.tracker.addLabel(ticket, "model:opus");
        const left = branch("issue-7-add-the-thing");
        ports.sandbox.result = () => ({
          kind: "model-refused",
          branch: left,
          commits: [commitSha("c0ffee1")],
          tokensUsed: tokenCount(0),
          refusal: { model: OPUS, words: "refused model opus" },
        });

        await morningLoop(ports);

        assert.deepEqual(
          ports.repoHost.discarded.map((discard) => discard.branch),
          [left],
        );
        assert.match(
          ports.tracker.handbacks[0]?.comment ?? "",
          /has been discarded/,
        );
      });

      it("clears a salvaged ticket's record when its resumed run has its model refused, discarding the earlier salvage's branch", async () => {
        const { ports, ticket } = oneTicket();
        ports.tracker.addLabel(ticket, "model:opus");
        ports.store.markSalvaged(
          { repo: PILOT, number: issueNumber(7) },
          branch("issue-7-earlier-salvage"),
          1,
        );
        ports.sandbox.result = () => ({
          kind: "model-refused",
          branch: branch("issue-7-add-the-thing"),
          commits: [commitSha("c0ffee1")],
          tokensUsed: tokenCount(0),
          refusal: { model: OPUS, words: "refused model opus" },
        });

        await morningLoop(ports);

        assert.deepEqual(
          ports.repoHost.discarded.map((discard) => discard.branch).sort(),
          [branch("issue-7-add-the-thing"), branch("issue-7-earlier-salvage")].sort(),
        );
        const state = await ports.store.loadState();
        assert.equal(state.salvages, undefined);
      });

      it("reports it apart from an agent that gave up and from an infrastructure failure", async () => {
        const { ports, ticket } = oneTicket();
        ports.tracker.addLabel(ticket, "model:opus");
        ports.sandbox.result = () => ({
          kind: "model-refused",
          branch: branch(`fake/${PILOT}/7`),
          commits: [],
          tokensUsed: tokenCount(0),
          refusal: { model: OPUS, words: "refused model opus" },
        });

        const report = await morningLoop(ports);

        const infrastructure = /would not start|fix the setup|sandbox or checkout failed/;
        assert.doesNotMatch(report.message, /gave up/);
        assert.doesNotMatch(report.message, infrastructure);
        assert.match(report.message, /refused the model `opus`/);
        const body = ports.tracker.summaries[0]?.body ?? "";
        assert.doesNotMatch(body, /gave up/);
        assert.doesNotMatch(body, infrastructure);
        assert.match(body, /Waiting on you/);
        assert.match(body, /pilot#7: relabelled ready-for-human — the agent CLI refused the model/);
      });
    });

    it("names the model each run used in the summary", async () => {
      const { ports, ticket } = oneTicket();
      ports.tracker.addLabel(ticket, "model:opus");
      ports.tracker.addEligibleTicket(PILOT, { number: issueNumber(8), title: "Next" });

      await morningLoop(ports);

      // Oldest first: #7 on its label, then #8 on the image's pin.
      const body = ports.tracker.summaries[0]?.body ?? "";
      assert.match(body, /tokens on opus\n- .*tokens on the image's model/);
    });

    it("names a model from the model defaults in the summary", async () => {
      const { ports } = oneTicket();
      ports.store.modelDefaults = { implementation: HAIKU };

      await morningLoop(ports);

      const body = ports.tracker.summaries[0]?.body ?? "";
      assert.match(body, /## Attempts\n- .*tokens on haiku/);
    });
  });

  describe("the summary issue", () => {
    it("is published exactly once on a dry queue", async () => {
      const ports = fakePorts();

      await morningLoop(ports);

      assert.equal(ports.tracker.summaries.length, 1);
      assert.match(ports.tracker.summaries[0]?.body ?? "", /nothing to do/i);
    });

    it("is published exactly once when the gate stands down", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
      ports.ledger.reports(spent({ weekly: DEFAULT_BUDGET.weeklyAllowance }));

      const report = await morningLoop(ports);

      assert.equal(report.outcome, "stood-down");
      assert.equal(ports.tracker.summaries.length, 1);
      assert.match(
        ports.tracker.summaries[0]?.body ?? "",
        /stood down/i,
      );
    });

    it("is published exactly once after a morning that worked something", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
      ports.sandbox.result = () => ({
        kind: "finished",
        branch: branch("issue-7-add-the-thing"),
        commits: [commitSha("c0ffee1")],
        output: "",
        tokensUsed: tokenCount(42_000),
      });
      ports.sandbox.reviewResult = () => ({
        kind: "finished",
        output: "",
        tokensUsed: tokenCount(3_000),
      });

      await morningLoop(ports);

      assert.equal(ports.tracker.summaries.length, 1);
    });

    it("lists each run attempted, its outcome, and what it cost", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
      ports.sandbox.result = () => ({
        kind: "finished",
        branch: branch("issue-7-add-the-thing"),
        commits: [commitSha("c0ffee1")],
        output: "",
        tokensUsed: tokenCount(42_000),
      });
      ports.sandbox.reviewResult = () => ({
        kind: "finished",
        output: "",
        tokensUsed: tokenCount(3_000),
      });

      await morningLoop(ports);

      const body = ports.tracker.summaries[0]?.body ?? "";
      const estimate = UNSIZED_ESTIMATE.toLocaleString("en-US");
      assert.match(body, new RegExp(`42,000 / ${estimate} tokens`));
      assert.match(body, new RegExp(`3,000 / ${estimate} tokens`));
    });

    it("lists a queued review as waiting on the developer", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
      ports.sandbox.result = () => ({
        kind: "finished",
        branch: branch("issue-7-add-the-thing"),
        commits: [commitSha("c0ffee1")],
        output: "",
        tokensUsed: tokenCount(42_000),
      });
      // Room for the implementation ticket's own run estimate, plus just
      // under the run's actual cost: the gate lets the implementation start
      // against an empty state, but refuses the review it queues — its own
      // estimate on top of the 42,000 already spent — before a second
      // iteration can work it, so the review stays queued, which is the
      // thing being tested.
      ports.store.budget = {
        ...DEFAULT_BUDGET,
        weeklyAllowance: tokenCount(UNSIZED_ESTIMATE + 40_000),
        reserveFraction: reserveFraction(0),
      };

      const report = await morningLoop(ports);

      const review = reviewTicketOf(report.iterations[0]);
      assert.ok(review, "the first run should have queued a review");
      const body = ports.tracker.summaries[0]?.body ?? "";
      assert.match(body, /Waiting on you/);
      assert.match(body, new RegExp(`#${review.number}`));
    });

    it("lists a handed-back ticket as waiting on the developer", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
      ports.sandbox.result = () => ({
        kind: "gave-up",
        branch: branch("issue-7-add-the-thing"),
        commits: [],
        output: "the tests are red",
        tokensUsed: tokenCount(1_000),
        reason: "the tests are red",
      });

      await morningLoop(ports);

      const body = ports.tracker.summaries[0]?.body ?? "";
      assert.match(body, /Waiting on you/);
      assert.match(body, /pilot#7/);
      assert.match(body, /ready-for-human/);
    });

    it("lists a ticket the hand-back itself failed on, still eligible", async (t) => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
      ports.sandbox.result = () => ({
        kind: "gave-up",
        branch: branch("issue-7-add-the-thing"),
        commits: [],
        output: "the tests are red",
        tokensUsed: tokenCount(1_000),
        reason: "the tests are red",
      });
      t.mock.method(ports.tracker, "handBack", async () => {
        throw new Error("gh is not logged in");
      });

      await morningLoop(ports);

      // Still ready-for-agent, not relabelled: this is the one failure that
      // is the developer's alone to notice, so it belongs in the curated
      // list even though it never reached ready-for-human.
      const body = ports.tracker.summaries[0]?.body ?? "";
      assert.match(body, /Waiting on you/);
      assert.match(body, /pilot#7/);
      assert.match(body, /still ready-for-agent/);
      assert.match(body, /relabel it yourself/);
    });

    it("never rejects when the summary issue itself cannot be published", async (t) => {
      const ports = fakePorts();
      t.mock.method(ports.tracker, "publishSummary", async () => {
        throw new Error("rate limited");
      });

      const report = await morningLoop(ports);

      // The developer still reads what the morning did — losing that to the
      // one write meant to carry it would be exactly the failure this write
      // exists to prevent.
      assert.equal(report.outcome, "dry-queue");
      assert.match(report.message, /nothing to do/i);
      assert.match(
        report.message,
        /summary issue could not be published: rate limited/,
      );
    });

    it("carries a summary that could not be published as a structured field, body and all", async (t) => {
      const ports = fakePorts();
      t.mock.method(ports.tracker, "publishSummary", async () => {
        throw new Error("rate limited");
      });

      const report = await morningLoop(ports);

      assert.equal(report.summaryFailure?.reason, "rate limited");
      assert.match(report.summaryFailure?.body ?? "", /nothing to do/i);
      assert.equal(report.summaryLocation, undefined);
    });

    it("records where a published summary landed, without changing the message", async () => {
      const ports = fakePorts();

      const report = await morningLoop(ports);

      assert.equal(report.summaryLocation, ports.tracker.summaries[0]?.url);
      assert.equal(report.summaryFailure, undefined);
      assert.match(report.message, /nothing to do/i);
    });

    it("is still published when the loop itself breaks before a run", async (t) => {
      const ports = fakePorts();
      t.mock.method(ports.store, "loadRegistry", async () => {
        throw new Error('registry.json: project 1: "repo" must be a repo slug');
      });

      const report = await morningLoop(ports);

      // Nothing ran, so there is no run to blame — the loop's own plumbing
      // broke, and the developer still needs to be told that, not just left
      // with a rejected promise nobody wrote down.
      assert.equal(report.outcome, "invocation-failed");
      assert.deepEqual(report.iterations, []);
      assert.match(report.message, /registry\.json.*repo slug/);
      assert.equal(ports.tracker.summaries.length, 1);
      assert.match(
        ports.tracker.summaries[0]?.body ?? "",
        /registry\.json.*repo slug/,
      );
    });

    describe("announcing once a day", () => {
      const TODAY = localDay(FROZEN_NOW);

      it("publishes a run that worked something even when today is already announced", async () => {
        const ports = fakePorts();
        ports.store.markAnnouncedOn(TODAY);
        ports.store.register(PILOT);
        ports.tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
        ports.sandbox.result = () => ({
          kind: "finished",
          branch: branch("issue-7-add-the-thing"),
          commits: [commitSha("c0ffee1")],
          output: "",
          tokensUsed: tokenCount(42_000),
        });
        ports.sandbox.reviewResult = () => ({
          kind: "finished",
          output: "",
          tokensUsed: tokenCount(3_000),
        });

        const report = await morningLoop(ports);

        assert.equal(report.outcome, "work-selected");
        assert.equal(ports.tracker.summaries.length, 1);
      });

      it("publishes a dry queue only when today is not yet announced", async () => {
        const notYetAnnounced = fakePorts();

        const first = await morningLoop(notYetAnnounced);

        assert.equal(first.outcome, "dry-queue");
        assert.equal(notYetAnnounced.tracker.summaries.length, 1);

        const alreadyAnnounced = fakePorts();
        alreadyAnnounced.store.markAnnouncedOn(TODAY);

        const second = await morningLoop(alreadyAnnounced);

        assert.equal(second.outcome, "dry-queue");
        assert.equal(alreadyAnnounced.tracker.summaries.length, 0);
      });

      it("publishes a stand-down only when today is not yet announced", async () => {
        function stoodDownPorts(): FakePorts {
          const ports = fakePorts();
          ports.store.register(PILOT);
          ports.tracker.addEligibleTicket(PILOT, {
            number: issueNumber(7),
            title: "Add the thing",
          });
          ports.ledger.reports(
            spent({ weekly: DEFAULT_BUDGET.weeklyAllowance }),
          );
          return ports;
        }

        const notYetAnnounced = stoodDownPorts();

        const first = await morningLoop(notYetAnnounced);

        assert.equal(first.outcome, "stood-down");
        assert.equal(notYetAnnounced.tracker.summaries.length, 1);

        const alreadyAnnounced = stoodDownPorts();
        alreadyAnnounced.store.markAnnouncedOn(TODAY);

        const second = await morningLoop(alreadyAnnounced);

        assert.equal(second.outcome, "stood-down");
        assert.equal(alreadyAnnounced.tracker.summaries.length, 0);
      });

      it("publishes an invocation failure only when today is not yet announced", async (t) => {
        function brokenPorts(): FakePorts {
          const ports = fakePorts();
          t.mock.method(ports.store, "loadRegistry", async () => {
            throw new Error("registry.json is not valid JSON");
          });
          return ports;
        }

        const notYetAnnounced = brokenPorts();

        const first = await morningLoop(notYetAnnounced);

        assert.equal(first.outcome, "invocation-failed");
        assert.equal(notYetAnnounced.tracker.summaries.length, 1);

        const alreadyAnnounced = brokenPorts();
        alreadyAnnounced.store.markAnnouncedOn(TODAY);

        const second = await morningLoop(alreadyAnnounced);

        assert.equal(second.outcome, "invocation-failed");
        assert.equal(alreadyAnnounced.tracker.summaries.length, 0);
      });

      it("returns its one-line message even on an invocation that did not publish", async () => {
        const ports = fakePorts();
        ports.store.markAnnouncedOn(TODAY);

        const report = await morningLoop(ports);

        assert.equal(ports.tracker.summaries.length, 0);
        assert.match(report.message, /nothing to do/i);
      });

      it("records today as announced only once a publish succeeds", async () => {
        const ports = fakePorts();

        await morningLoop(ports);

        assert.equal((await ports.store.loadState()).announcedOn, TODAY);
      });

      it("leaves the day unannounced when the publish itself fails", async (t) => {
        const ports = fakePorts();
        t.mock.method(ports.tracker, "publishSummary", async () => {
          throw new Error("rate limited");
        });

        await morningLoop(ports);

        assert.equal((await ports.store.loadState()).announcedOn, undefined);
      });

      it("carries the local time to the minute in the summary title", async () => {
        const ports = fakePorts();
        const startedAt = new Date("2026-03-05T14:37:00.000Z");
        ports.clock = new FakeClock(startedAt);

        await morningLoop(ports);

        const local = Object.fromEntries(
          new Intl.DateTimeFormat("en-CA", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          })
            .formatToParts(startedAt)
            .map((part) => [part.type, part.value]),
        );
        assert.equal(
          ports.tracker.summaries[0]?.title,
          `Morning loop summary — ${local.year}-${local.month}-${local.day} ${local.hour}:${local.minute}`,
        );
      });
    });
  });

  describe("the conflict sweep", () => {
    const PULL_REQUEST = pullRequestUrl("https://github.com/nadav-alon/pilot/pull/7");

    it("labels a conflicting pull request of a non-paused project before selecting", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.repoHost.setOpenPullRequests(PILOT, [
        { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
      ]);
      ports.repoHost.mergeStatus = () => "conflicting";

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.labelled, [
        { pullRequest: PULL_REQUEST, label: NEEDS_REBASE },
      ]);
    });

    it("never sweeps a paused project", async (t) => {
      const ports = fakePorts();
      ports.store.register(PILOT, { paused: true });
      const listOpenPullRequests = t.mock.method(ports.repoHost, "listOpenPullRequests");

      await morningLoop(ports);

      assert.equal(listOpenPullRequests.mock.callCount(), 0);
    });

    it("still sweeps once on an invocation in which nothing is eligible", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.repoHost.setOpenPullRequests(PILOT, [
        { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
      ]);
      ports.repoHost.mergeStatus = () => "conflicting";

      const report = await morningLoop(ports);

      assert.equal(report.outcome, "dry-queue");
      assert.deepEqual(ports.repoHost.labelled, [
        { pullRequest: PULL_REQUEST, label: NEEDS_REBASE },
      ]);
    });

    it("tells a turbo project's sweep it is turbo", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT, { turbo: true });
      ports.repoHost.setOpenPullRequests(PILOT, [
        { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
      ]);
      ports.repoHost.mergeStatus = () => "conflicting";

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.comments, [
        { pullRequest: PULL_REQUEST, body: REBASE_COMMENT },
      ]);
    });

    it("does not tell a plain project's sweep it is turbo", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.repoHost.setOpenPullRequests(PILOT, [
        { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
      ]);
      ports.repoHost.mergeStatus = () => "conflicting";

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.comments, []);
    });

    it("a sweep's refusal does not stop selection or fail the invocation", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, { number: issueNumber(7), title: "Add the thing" });
      ports.repoHost.listOpenPullRequests = async () => {
        throw new Error("host unreachable");
      };

      const report = await morningLoop(ports);

      assert.equal(report.outcome, "work-selected");
      assert.deepEqual(
        report.iterations.map((iteration) => iteration.ticket.number),
        [7],
      );
    });

    it("carries every sweep outcome into the summary", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.repoHost.setOpenPullRequests(PILOT, [
        { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
      ]);
      ports.repoHost.mergeStatus = () => "conflicting";

      await morningLoop(ports);

      const body = ports.tracker.summaries[0]?.body ?? "";
      assert.match(body, /## Conflict sweeps/);
      assert.match(
        body,
        new RegExp(`- ${PILOT}: labelled needs-rebase on ${PULL_REQUEST}`),
      );
    });

    it("sweeps and labels a conflicting pull request even though the gate refuses the invocation's first ticket", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
      ports.repoHost.setOpenPullRequests(PILOT, [
        { url: PULL_REQUEST, labels: [], closes: issueNumber(1) },
      ]);
      ports.repoHost.mergeStatus = () => "conflicting";
      ports.ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK + 1 }));

      const report = await morningLoop(ports);

      assert.equal(report.outcome, "stood-down");
      assert.deepEqual(ports.repoHost.labelled, [
        { pullRequest: PULL_REQUEST, label: NEEDS_REBASE },
      ]);
      const body = ports.tracker.summaries[0]?.body ?? "";
      assert.match(body, /## Conflict sweeps/);
    });

    it(
      "never runs two sweeps of the same project at the same time, even with iterations in progress",
      HANGS,
      async (t) => {
        const ports = fakePorts();
        ports.store.register(PILOT);
        ports.store.budget = {
          ...DEFAULT_BUDGET,
          maxConcurrentIterations: iterationLimit(2),
        };
        const ticket1 = ports.tracker.addEligibleTicket(PILOT, {
          number: issueNumber(1),
          title: "Ticket 1",
        });
        const ticket2 = ports.tracker.addEligibleTicket(PILOT, {
          number: issueNumber(2),
          title: "Ticket 2",
        });
        ports.sandbox.hold();

        let inFlight = 0;
        let overlapped = false;
        const list = ports.repoHost.listOpenPullRequests.bind(ports.repoHost);
        t.mock.method(
          ports.repoHost,
          "listOpenPullRequests",
          async (repo: typeof PILOT) => {
            if (inFlight > 0) {
              overlapped = true;
            }
            inFlight++;
            try {
              return await list(repo);
            } finally {
              inFlight--;
            }
          },
        );

        const invocation = morningLoop(ports);
        await ports.sandbox.whenHeld(2);
        ports.sandbox.release(ticket1);
        ports.sandbox.release(ticket2);
        await invocation;

        assert.equal(overlapped, false);
      },
    );
  });

  /**
   * `fakePorts()` defaults `progress` to the no-op adapter, so every test
   * above this one exercises the loop having said nothing about itself in
   * between. These are the only tests that swap in `FakeProgress` to see
   * what the loop narrated.
   */
  describe("progress", () => {
    /** A project with one thing to do, so the run itself is the only question. */
    function readyToWork(ports: FakePorts): void {
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: issueNumber(7),
        title: "Add the thing",
      });
    }

    it("announces the project and ticket it selected", async () => {
      const ports = fakePorts();
      readyToWork(ports);
      const progress = new FakeProgress();
      ports.progress = progress;

      await morningLoop(ports);

      const selected = progress.events.find(
        (event) => event.kind === "iteration-selected",
      );
      assert.equal(selected?.ticket.repo, PILOT);
      assert.equal(selected?.ticket.number, 7);
    });

    /**
     * Pinned at the moment the sandbox is entered, not inferred from the
     * final event order: a line printed after the container exits is the
     * silence this port exists to fix.
     */
    it("announces the selection and the starting container before the sandbox is ever invoked", async () => {
      const ports = fakePorts();
      readyToWork(ports);
      const progress = new FakeProgress();
      ports.progress = progress;
      let seenBeforeRun: string[] | undefined;
      ports.sandbox.result = (ticket) => {
        seenBeforeRun = progress.events.map((event) => event.kind);
        return {
          kind: "finished",
          branch: branch(`fake/${ticket.repo}/${ticket.number}`),
          commits: [],
          output: "",
          tokensUsed: tokenCount(0),
        };
      };

      await morningLoop(ports);

      assert.deepEqual(seenBeforeRun, [
        "iteration-selected",
        "container-started",
      ]);
    });

    it("names the spend ceiling the container was given", async () => {
      const ports = fakePorts();
      readyToWork(ports);
      ports.store.budget = { ...DEFAULT_BUDGET, spendCeiling: usd(3) };
      const progress = new FakeProgress();
      ports.progress = progress;

      await morningLoop(ports);

      const started = progress.events.find(
        (event) => event.kind === "container-started",
      );
      assert.equal(started?.spendCeiling, 3);
    });

    it("names the throwaway clone a starting container runs against", async () => {
      const ports = fakePorts();
      readyToWork(ports);
      const progress = new FakeProgress();
      ports.progress = progress;

      await morningLoop(ports);

      const started = progress.events.find(
        (event) => event.kind === "container-started",
      );
      assert.equal(started?.checkout, await ports.repoHost.clone(PILOT));
    });

    it("announces what a run cost once it ends", async () => {
      const ports = fakePorts();
      readyToWork(ports);
      ports.sandbox.result = (ticket) => ({
        kind: "finished",
        branch: branch(`fake/${ticket.repo}/${ticket.number}`),
        commits: [],
        output: "",
        tokensUsed: tokenCount(4242),
      });
      const progress = new FakeProgress();
      ports.progress = progress;

      await morningLoop(ports);

      const ended = progress.events.find((event) => event.kind === "run-ended");
      assert.equal(ended?.tokensUsed, 4242);
    });

    it("announces the gate's refusal the instant it refuses, before the invocation ends", async () => {
      const ports = fakePorts();
      readyToWork(ports);
      ports.ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK + 1 }));
      const progress = new FakeProgress();
      ports.progress = progress;

      await morningLoop(ports);

      assert.deepEqual(
        progress.events.map((event) => event.kind),
        ["iteration-selected", "stood-down"],
      );
      const stoodDown = progress.events.find(
        (event) => event.kind === "stood-down",
      );
      assert.equal(stoodDown?.reason, "weekly-reserve");
    });

    it("announces a provider-limit stand-down the instant a run is refused, not only when the invocation ends", async () => {
      const ports = fakePorts();
      readyToWork(ports);
      ports.sandbox.result = (ticket) => ({
        kind: "limit-refused",
        branch: branch(`fake/${ticket.repo}/${ticket.number}`),
        commits: [],
        words: LIMIT_REFUSAL,
        tokensUsed: tokenCount(0),
      });
      const progress = new FakeProgress();
      ports.progress = progress;

      const report = await morningLoop(ports);

      assert.equal(report.standDown?.reason, "provider-limit");
      assert.deepEqual(
        progress.events.map((event) => event.kind),
        [
          "iteration-selected",
          "container-started",
          "run-ended",
          "provider-limited",
        ],
      );
      const limited = progress.events.find(
        (event) => event.kind === "provider-limited",
      );
      assert.equal(limited?.limitRefusal, LIMIT_REFUSAL);
    });

    it("announces the run ended, spending nothing, when the sandbox rejects after the container started", async (t) => {
      const ports = fakePorts();
      readyToWork(ports);
      t.mock.method(ports.sandbox, "run", async () => {
        throw new Error("docker is not running");
      });
      const progress = new FakeProgress();
      ports.progress = progress;

      await morningLoop(ports);

      assert.deepEqual(
        progress.events.map((event) => event.kind),
        ["iteration-selected", "container-started", "run-ended"],
      );
      const ended = progress.events.find((event) => event.kind === "run-ended");
      assert.equal(ended?.tokensUsed, 0);
    });

    it("never announces a container started, or a run ended, when the checkout cannot be made", async (t) => {
      const ports = fakePorts();
      readyToWork(ports);
      t.mock.method(ports.repoHost, "clone", async () => {
        throw new Error("no such remote");
      });
      const progress = new FakeProgress();
      ports.progress = progress;

      await morningLoop(ports);

      assert.deepEqual(
        progress.events.map((event) => event.kind),
        ["iteration-selected"],
      );
    });

    it("never fails the invocation, or changes its exit-worthy outcome, when a progress write throws", async () => {
      const ports = fakePorts();
      readyToWork(ports);
      ports.progress = {
        note: () => {
          throw new Error("the terminal hung up");
        },
      };

      const report = await morningLoop(ports);

      assert.equal(report.outcome, "work-selected");
      assert.equal(ports.sandbox.runs.length, 1);
    });
  });
});
