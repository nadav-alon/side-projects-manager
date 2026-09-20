import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";

import { failureOf, handedBackFailure, type IterationOutcome } from "./iteration-outcome.ts";
import { morningLoop, type InvocationReport } from "./morning-run.ts";
import {
  APPLIED_REVIEW_LABEL,
  DEFAULT_BUDGET,
  MergeabilityUnknown,
  READY_FOR_HUMAN_LABEL,
  REVIEWED_LABEL,
  backlogIn,
  branch,
  checkout,
  commitSha,
  iterationLimit,
  issueNumber,
  localDay,
  modelName,
  pullRequestUrl,
  reserveFraction,
  reviewTitle,
  ticketGist,
  tokenCount,
  transcriptPath,
  usd,
  type ApplyReviewTicket,
  type CommitSha,
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
  FakeClock,
  FakeProgress,
  FakeRepoHost,
  HANGS,
  LIMIT_REFUSAL,
  PROVIDER_FAILURE_PROSE,
  gate,
  type FakePorts,
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
    iteration.kind === "pull-request-resolved"
    ? undefined
    : iteration.run;
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

  it("selects a sibling ticket instead, when one in the same backlog is broken out", async () => {
    const ports = fakePorts();
    ports.store.register(PILOT);
    ports.tracker.addBrokenOutTicket(
      PILOT,
      { number: issueNumber(66), title: "Too big for one run" },
      7,
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
    assert.match(report.message, /#66 broken out into sub-issues/);
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

  describe("a truncated backlog", () => {
    it("names the truncated project in the waiting section, even when nothing else is waiting", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addBrokenOutTicket(
        PILOT,
        { number: issueNumber(66), title: "Too big for one run" },
        7,
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
      ports.tracker.addBrokenOutTicket(
        MANAGER,
        { number: issueNumber(66), title: "Too big for one run" },
        7,
      );
      ports.tracker.truncateBacklog(MANAGER);
      ports.store.register(PILOT);
      ports.tracker.addBrokenOutTicket(
        PILOT,
        { number: issueNumber(67), title: "Also too big" },
        8,
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
      ports.tracker.addBrokenOutTicket(
        PILOT,
        { number: issueNumber(66), title: "Too big for one run" },
        7,
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
            }
          : {
              kind: "gave-up",
              branch: BRANCH,
              commits: run.commits ?? [commitSha("c0ffee1")],
              output: "",
              reason: run.failure,
              tokensUsed: tokenCount(42_000),
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
    const PULL_REQUEST = pullRequestUrl(
      "https://github.com/nadav-alon/pilot/pull/12",
    );

    /** A review ticket, eligible like any other, naming the pull request it asks about. */
    function queued(ports: FakePorts): ReviewTicket {
      ports.store.register(PILOT);
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
      assert.match(waiting, new RegExp(`pilot #${ticket.number}`));
      const state = await ports.store.loadState();
      assert.deepEqual(state.projects.get(PILOT)?.runs[0], {
        at: FROZEN_NOW,
        tokensUsed: tokenCount(9_000),
      });
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
        new RegExp(`## Waiting on you[\\s\\S]*pilot #${ticket.number}`),
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
      const which = `#${ticket.number}`;
      assert.match(gaveUpBody, new RegExp(`gave up on ${which}`));
      assert.match(gaveUpBody, new RegExp(`pilot ${which}: relabelled ready-for-human`));
      assert.doesNotMatch(gaveUpBody, /fix the setup/);
      assert.match(
        brokeBody,
        new RegExp(`pilot ${which}: still ready-for-agent — the sandbox or checkout failed`),
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
      assert.match(report.message, /Reviewed nadav-alon\/pilot #42/);
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
        new RegExp(`the agent gave up on #${ticket.number}: the agent gave up`, "i"),
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
        new RegExp(`## Waiting on you[\\s\\S]*pilot #${ticket.number}`),
      );
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
        new RegExp(`pilot #${ticket.number}: still ready-for-agent — the sandbox or checkout failed`),
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
          `Applied review on ${PILOT} #43: 2 applied, 1 declined on ${PULL_REQUEST}, now ready for review.`,
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
        new RegExp(`pilot #${ticket.number}: still ready-for-agent`),
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
        new RegExp(`pilot #${ticket.number}: still ready-for-agent`),
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
        new RegExp(`pilot #${ticket.number}: still ready-for-agent`),
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
        new RegExp(`pilot #${ticket.number}: still ready-for-agent`),
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
        new RegExp(`pilot #${ticket.number}: still ready-for-agent`),
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
        new RegExp(`pilot #${ticket.number}: still ready-for-agent`),
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
          `Rebased ${PULL_REQUEST} for ${PILOT} #44: it no longer conflicts with its base.`,
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
        new RegExp(`- Attempted a rebase of ${PULL_REQUEST} on ${PILOT}: the agent gave up on #44: .*still conflicts`),
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
        assert.match(waiting, /pilot #7/);
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
      assert.equal(failureOf(report.iterations[0])?.reason, GAVE_UP);
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
  });

  describe("the spend ceiling", () => {
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
      assert.match(report.message, /pilot #2 is still ready-for-agent/);
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
      assert.match(report.message, /pilot #2 is still ready-for-agent/);
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
      assert.match(report.message, /nadav-alon\/pilot #2 is still ready-for-agent/);
      assert.match(report.message, /resets 1pm \(UTC\)/);
      const body = ports.tracker.summaries[0]?.body ?? "";
      assert.doesNotMatch(body, /pilot #2: relabelled/);
    });

    it("still records what the refused run spent", async () => {
      const ports = threeTickets();
      limitAfterTheFirstRun(ports);

      await morningLoop(ports);

      const runs = (await ports.store.loadState()).projects.get(PILOT)?.runs ?? [];
      assert.equal(runs.length, 2);
    });

    it("discards any branch the refused run left, without handing the ticket back", async () => {
      const ports = threeTickets();
      ports.sandbox.result = (ticket) => ({
        kind: "limit-refused",
        branch: branch(`issue-${ticket.number}`),
        commits: [commitSha("c0ffee1")],
        words: LIMIT_REFUSAL,
        tokensUsed: tokenCount(0),
      });

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.discarded, [
        {
          directory: checkout(`${FakeRepoHost.MANAGED_LOCATION}/${PILOT}`),
          branch: branch("issue-1"),
        },
      ]);
      assert.deepEqual(ports.tracker.handbacks, []);
      assert.equal(ports.repoHost.pullRequests.length, 0);
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
        assert.match(report.message, /refused the model opus/);
        const body = ports.tracker.summaries[0]?.body ?? "";
        assert.doesNotMatch(body, /gave up/);
        assert.doesNotMatch(body, infrastructure);
        assert.match(body, /Waiting on you/);
        assert.match(body, /pilot #7: relabelled ready-for-human — the model opus/);
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
      assert.match(body, /42,000 tokens/);
      assert.match(body, /3,000 tokens/);
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
      assert.match(body, /pilot #7/);
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
      assert.match(body, /pilot #7/);
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
