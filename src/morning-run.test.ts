import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { failureOf, type IterationOutcome } from "./iteration-outcome.ts";
import {
  morningLoop,
  type InvocationReport,
  type ProjectOutcome,
} from "./morning-run.ts";
import {
  DEFAULT_BUDGET,
  branch,
  checkout,
  commitSha,
  localDay,
  modelName,
  priority,
  pullRequestUrl,
  repoSlug,
  reserveFraction,
  reviewTitle,
  ticketPriority,
  tokenCount,
  usd,
  type CommitSha,
  type ReviewTicket,
  type RunRequest,
  type State,
  type Ticket,
} from "./ports/index.ts";
import {
  FROZEN_NOW,
  FakeClock,
  FakeRepoHost,
  LIMIT_REFUSAL,
  type FakePorts,
  fakePorts,
  spent,
} from "./testing/index.ts";

const MANAGER = repoSlug("nadav-alon/side-projects-manager");
const PILOT = repoSlug("nadav-alon/pilot");

const YESTERDAY = new Date("2025-12-31T06:00:00.000Z");
/** Before the weekly window the fakes are anchored in opened. */
const LAST_WEEK = new Date("2025-12-20T06:00:00.000Z");

/** What the report says happened, without the timestamps a test didn't set. */
function verdicts(projects: ProjectOutcome[]): [string, string][] {
  return projects.map((project) => [project.repo, project.verdict]);
}

/** The finished half of an iteration outcome — undefined if it ended any other way. */
function finished(iteration: IterationOutcome | undefined) {
  return iteration?.kind === "finished" ? iteration : undefined;
}

/** Why the gate refused — undefined if it never did, or the provider's limit stood the morning down instead. */
function gateRefusal(report: InvocationReport) {
  return report.standDown?.reason === "provider-limit"
    ? undefined
    : report.standDown;
}

/** Whether an agent that gave up had its ticket handed back — undefined for any other outcome. */
function handedBackOf(iteration: IterationOutcome | undefined) {
  const failure = failureOf(iteration);
  return failure?.kind === "gave-up" ? failure.handedBack : undefined;
}

function pullRequestOf(iteration: IterationOutcome | undefined) {
  return finished(iteration)?.handover?.pullRequest;
}

function reviewTicketOf(iteration: IterationOutcome | undefined) {
  return finished(iteration)?.handover?.reviewTicket;
}

/** The sandbox run an iteration made — absent for a review, or a run that never started. */
function ranWith(iteration: IterationOutcome | undefined) {
  return iteration === undefined || iteration.kind === "reviewed"
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

  it("asks the tracker about every registered project", async (t) => {
    const ports = fakePorts();
    ports.store.register(MANAGER);
    ports.store.register(PILOT);
    const listEligibleTickets = t.mock.method(
      ports.tracker,
      "listEligibleTickets",
    );

    await morningLoop(ports);

    assert.equal(listEligibleTickets.mock.callCount(), 2);
    assert.deepEqual(
      listEligibleTickets.mock.calls.map((call) => call.arguments[0]),
      [MANAGER, PILOT],
    );
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
      number: 7,
      title: "Add the thing",
    });

    const report = await morningLoop(ports);

    assert.equal(report.outcome, "work-selected");
    assert.deepEqual(verdicts(report.projects), [[PILOT, "selected"]]);
    assert.match(report.message, /nadav-alon\/pilot/);
  });

  it("asks every non-paused project even once one has work, since priority can still send the mornings elsewhere", async (t) => {
    const ports = fakePorts();
    ports.store.register(PILOT);
    ports.store.register(MANAGER);
    ports.tracker.addEligibleTicket(PILOT, {
      number: 7,
      title: "Add the thing",
    });
    const listEligibleTickets = t.mock.method(
      ports.tracker,
      "listEligibleTickets",
    );

    await morningLoop(ports);

    // Twice each: once to select PILOT's one ticket, and again once it is
    // worked, to confirm nothing else — MANAGER included — was left waiting.
    assert.deepEqual(
      listEligibleTickets.mock.calls.map((call) => call.arguments[0]),
      [PILOT, MANAGER, PILOT, MANAGER],
    );
  });

  it("selects one project and one ticket per iteration, working through a backlog one at a time", async () => {
    const ports = fakePorts();
    ports.store.register(PILOT);
    ports.tracker.addEligibleTicket(PILOT, {
      number: 7,
      title: "Add the thing",
    });
    ports.tracker.addEligibleTicket(PILOT, {
      number: 8,
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

  describe("a paused project", () => {
    it("is never considered, however much work it has", async (t) => {
      const ports = fakePorts();
      ports.store.register(PILOT, { paused: true });
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });
      const listEligibleTickets = t.mock.method(
        ports.tracker,
        "listEligibleTickets",
      );

      const report = await morningLoop(ports);

      assert.equal(listEligibleTickets.mock.callCount(), 0);
      assert.equal(report.outcome, "dry-queue");
    });

    it("does not stop the projects behind it being worked", async () => {
      const ports = fakePorts();
      ports.store.register(MANAGER, { paused: true });
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });

      const report = await morningLoop(ports);

      assert.equal(report.outcome, "work-selected");
      assert.deepEqual(verdicts(report.projects), [
        [MANAGER, "paused"],
        [PILOT, "selected"],
      ]);
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
  });

  describe("ready-for-agent eligibility", () => {
    it("never selects a ticket without ready-for-agent, even as its project's only ticket", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addIneligibleTicket(PILOT, {
        number: 7,
        title: "Not triaged yet",
      });

      const report = await morningLoop(ports);

      assert.equal(report.outcome, "dry-queue");
      assert.deepEqual(verdicts(report.projects), [
        [PILOT, "no-eligible-tickets"],
      ]);
    });

    it("does not select a handed-back ticket on the next invocation", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      const ticket = ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });

      await ports.tracker.handBack(ticket, "gave up");
      const report = await morningLoop(ports);

      assert.equal(report.outcome, "dry-queue");
      assert.deepEqual(verdicts(report.projects), [
        [PILOT, "no-eligible-tickets"],
      ]);
    });
  });

  describe("broken-out tickets", () => {
    it("never selects a ticket carrying ready-for-agent with an open sub-issue, even as its project's only ticket", async (t) => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addBrokenOutTicket(
        PILOT,
        { number: 66, title: "Too big for one run" },
        7,
      );
      const run = t.mock.method(ports.sandbox, "run");

      const report = await morningLoop(ports);

      assert.equal(run.mock.callCount(), 0);
      assert.equal(report.outcome, "dry-queue");
      assert.deepEqual(verdicts(report.projects), [
        [PILOT, "no-eligible-tickets"],
      ]);
    });

    it("is selectable again once it carries no more open sub-issues", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 66,
        title: "Too big for one run",
      });

      const report = await morningLoop(ports);

      assert.equal(report.outcome, "work-selected");
      assert.deepEqual(verdicts(report.projects), [[PILOT, "selected"]]);
    });

    it("selects a sibling ticket instead, when one in the same backlog is broken out", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addBrokenOutTicket(
        PILOT,
        { number: 66, title: "Too big for one run" },
        7,
      );
      ports.tracker.addEligibleTicket(PILOT, {
        number: 67,
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

    it("reads a backlog that is only broken-out tickets as having no eligible tickets, not an error", async () => {
      const ports = fakePorts();
      ports.store.register(MANAGER);
      ports.store.register(PILOT);
      ports.tracker.addBrokenOutTicket(
        MANAGER,
        { number: 66, title: "Too big for one run" },
        7,
      );

      const report = await morningLoop(ports);

      assert.equal(report.outcome, "dry-queue");
      assert.deepEqual(verdicts(report.projects), [
        [MANAGER, "no-eligible-tickets"],
        [PILOT, "no-eligible-tickets"],
      ]);
      assert.match(report.message, /nothing to do/i);
    });

    it("says a passed-over ticket was broken out, so a full-looking backlog is explicable", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addBrokenOutTicket(
        PILOT,
        { number: 66, title: "Too big for one run" },
        7,
      );

      const report = await morningLoop(ports);

      assert.match(report.message, /#66 broken out into sub-issues/);
    });
  });

  describe("blocked tickets", () => {
    it("never selects a ticket carrying ready-for-agent that an open ticket blocks, even as its project's only ticket", async (t) => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addBlockedTicket(
        PILOT,
        { number: 56, title: "Waits on #55" },
        1,
      );
      const run = t.mock.method(ports.sandbox, "run");

      const report = await morningLoop(ports);

      assert.equal(run.mock.callCount(), 0);
      assert.equal(report.outcome, "dry-queue");
      assert.deepEqual(verdicts(report.projects), [
        [PILOT, "no-eligible-tickets"],
      ]);
    });

    it("selects a sibling ticket instead, and says the blocked one was passed over", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addBlockedTicket(
        PILOT,
        { number: 56, title: "Waits on #55" },
        2,
      );
      ports.tracker.addEligibleTicket(PILOT, {
        number: 55,
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
  });

  describe("selection ordering", () => {
    /** The pull request every `reviewOf` in this suite names, since none of them care which. */
    const SOME_PULL_REQUEST = pullRequestUrl(
      "https://github.com/nadav-alon/pilot/pull/1",
    );

    /**
     * A ticket that names `parent`'s pull request, ready to add to `parent`'s
     * own repo — a review always lives beside the ticket it reviews, never in
     * another project. Naming the pull request, not just the title, is what
     * `isReviewTicket` reads to tell it from an implementation.
     */
    function reviewOf(
      parent: Ticket,
      number: number,
    ): Omit<Ticket, "repo" | "modelLabel"> {
      return {
        number,
        title: reviewTitle(parent),
        pullRequest: SOME_PULL_REQUEST,
      };
    }

    it("selects a review ticket before an implementation ticket in the same backlog", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      const implementation = ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });
      // Added after the implementation ticket, so winning proves the rule
      // rather than just reflecting backlog order.
      ports.tracker.addEligibleTicket(PILOT, reviewOf(implementation, 8));

      await morningLoop(ports);

      // The review goes first — the invocation goes on afterwards to work the
      // implementation too, since nothing else was eligible, but that is a
      // second iteration and not what this test is about.
      assert.equal(ports.sandbox.reviews[0]?.ticket.number, 8);
    });

    it("selects a project with a pending review before one with only an implementation ticket, regardless of registry order", async () => {
      const ports = fakePorts();
      ports.store.register(MANAGER);
      ports.tracker.addEligibleTicket(MANAGER, {
        number: 3,
        title: "Add another thing",
      });
      ports.store.register(PILOT);
      const implementation = ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });
      ports.tracker.addEligibleTicket(PILOT, reviewOf(implementation, 8));

      await morningLoop(ports);

      // PILOT's review goes first, however MANAGER — registered first, no
      // priority set for either — would otherwise have sorted.
      assert.equal(ports.sandbox.reviews[0]?.ticket.repo, PILOT);
      assert.equal(ports.sandbox.reviews[0]?.ticket.number, 8);
    });

    it("among implementation tickets, an explicit priority wins over registry order", async () => {
      const ports = fakePorts();
      ports.store.register(MANAGER);
      ports.tracker.addEligibleTicket(MANAGER, {
        number: 3,
        title: "Add another thing",
      });
      ports.store.register(PILOT, { priority: priority(1) });
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });

      await morningLoop(ports);

      assert.equal(ports.sandbox.runs[0]?.ticket.repo, PILOT);
    });

    it("a lower priority number wins over a higher one", async () => {
      const ports = fakePorts();
      ports.store.register(MANAGER, { priority: priority(2) });
      ports.tracker.addEligibleTicket(MANAGER, {
        number: 3,
        title: "Add another thing",
      });
      ports.store.register(PILOT, { priority: priority(1) });
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });

      await morningLoop(ports);

      assert.equal(ports.sandbox.runs[0]?.ticket.repo, PILOT);
    });

    it("with no priorities set, the least recently worked project wins", async () => {
      const ports = fakePorts();
      ports.store.register(MANAGER);
      ports.store.markWorked(MANAGER, YESTERDAY, {
        at: YESTERDAY,
        tokensUsed: tokenCount(1),
      });
      ports.tracker.addEligibleTicket(MANAGER, {
        number: 3,
        title: "Add another thing",
      });
      ports.store.register(PILOT);
      ports.store.markWorked(PILOT, LAST_WEEK, {
        at: LAST_WEEK,
        tokensUsed: tokenCount(1),
      });
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });

      await morningLoop(ports);

      assert.equal(ports.sandbox.runs[0]?.ticket.repo, PILOT);
    });

    it("a project never worked outranks one that has been, priorities being equal", async () => {
      const ports = fakePorts();
      ports.store.register(MANAGER);
      ports.store.markWorked(MANAGER, YESTERDAY, {
        at: YESTERDAY,
        tokensUsed: tokenCount(1),
      });
      ports.tracker.addEligibleTicket(MANAGER, {
        number: 3,
        title: "Add another thing",
      });
      // Never worked: no state entry at all, not even an old one.
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });

      await morningLoop(ports);

      assert.equal(ports.sandbox.runs[0]?.ticket.repo, PILOT);
    });

    describe("ticket priority, within one project", () => {
      it("a priority:1 ticket is selected over an older unlabelled ticket", async () => {
        const ports = fakePorts();
        ports.store.register(PILOT);
        ports.tracker.addEligibleTicket(PILOT, {
          number: 7,
          title: "Add the thing",
        });
        // Added after #7, so winning proves priority rather than backlog order.
        ports.tracker.addEligibleTicket(PILOT, {
          number: 8,
          title: "Add the urgent thing",
          priority: ticketPriority(1),
        });

        await morningLoop(ports);

        assert.equal(ports.sandbox.runs[0]?.ticket.number, 8);
      });

      it("a priority:1 ticket is selected over an older priority:2 ticket", async () => {
        const ports = fakePorts();
        ports.store.register(PILOT);
        ports.tracker.addEligibleTicket(PILOT, {
          number: 7,
          title: "Add the thing",
          priority: ticketPriority(2),
        });
        ports.tracker.addEligibleTicket(PILOT, {
          number: 8,
          title: "Add the urgent thing",
          priority: ticketPriority(1),
        });

        await morningLoop(ports);

        assert.equal(ports.sandbox.runs[0]?.ticket.number, 8);
      });

      it("with neither ticket labelled, the oldest ticket wins whatever order the tracker returns them in", async () => {
        const ports = fakePorts();
        ports.store.register(PILOT);
        // Added in descending order, so winning proves the tie-break rather
        // than reflecting backlog order.
        ports.tracker.addEligibleTicket(PILOT, {
          number: 8,
          title: "Add the other thing",
        });
        ports.tracker.addEligibleTicket(PILOT, {
          number: 7,
          title: "Add the thing",
        });

        await morningLoop(ports);

        assert.equal(ports.sandbox.runs[0]?.ticket.number, 7);
      });

      it("a review ticket is selected over a priority:1 implementation ticket", async () => {
        const ports = fakePorts();
        ports.store.register(PILOT);
        const implementation = ports.tracker.addEligibleTicket(PILOT, {
          number: 7,
          title: "Add the thing",
          priority: ticketPriority(1),
        });
        ports.tracker.addEligibleTicket(PILOT, {
          number: 8,
          title: reviewTitle(implementation),
          pullRequest: pullRequestUrl(
            "https://github.com/nadav-alon/pilot/pull/1",
          ),
        });

        await morningLoop(ports);

        assert.equal(ports.sandbox.reviews[0]?.ticket.number, 8);
      });

      it("with two review tickets, the oldest ticket wins whatever order the tracker returns them in", async () => {
        const ports = fakePorts();
        ports.store.register(PILOT);
        const first = ports.tracker.addEligibleTicket(PILOT, {
          number: 5,
          title: "Add the thing",
        });
        const second = ports.tracker.addEligibleTicket(PILOT, {
          number: 6,
          title: "Add the other thing",
        });
        // Added in descending order, so winning proves the tie-break rather
        // than reflecting backlog order.
        ports.tracker.addEligibleTicket(PILOT, {
          number: 9,
          title: reviewTitle(second),
          pullRequest: pullRequestUrl(
            "https://github.com/nadav-alon/pilot/pull/2",
          ),
        });
        ports.tracker.addEligibleTicket(PILOT, {
          number: 8,
          title: reviewTitle(first),
          pullRequest: pullRequestUrl(
            "https://github.com/nadav-alon/pilot/pull/1",
          ),
        });

        await morningLoop(ports);

        assert.equal(ports.sandbox.reviews[0]?.ticket.number, 8);
      });

      it("never lets a ticket's priority make its project outrank one with explicit registry priority", async () => {
        const ports = fakePorts();
        ports.store.register(MANAGER, { priority: priority(1) });
        ports.tracker.addEligibleTicket(MANAGER, {
          number: 3,
          title: "Add another thing",
        });
        ports.store.register(PILOT);
        ports.tracker.addEligibleTicket(PILOT, {
          number: 7,
          title: "Add the urgent thing",
          priority: ticketPriority(1),
        });

        await morningLoop(ports);

        assert.equal(ports.sandbox.runs[0]?.ticket.repo, MANAGER);
      });

      it("never lets a ticket's priority make its project outrank one worked less recently", async () => {
        const ports = fakePorts();
        ports.store.register(MANAGER);
        ports.tracker.addEligibleTicket(MANAGER, {
          number: 3,
          title: "Add another thing",
        });
        // MANAGER was never worked, so it waits longest; the ticket priority on
        // PILOT's ticket must not be what wins it the morning.
        ports.store.register(PILOT);
        ports.store.markWorked(PILOT, YESTERDAY, {
          at: YESTERDAY,
          tokensUsed: tokenCount(1),
        });
        ports.tracker.addEligibleTicket(PILOT, {
          number: 7,
          title: "Add the urgent thing",
          priority: ticketPriority(1),
        });

        await morningLoop(ports);

        assert.equal(ports.sandbox.runs[0]?.ticket.repo, MANAGER);
      });
    });

    describe("a truncated backlog", () => {
      it("sets backlogTruncated on the selected project", async () => {
        const ports = fakePorts();
        ports.store.register(PILOT);
        ports.tracker.addEligibleTicket(PILOT, {
          number: 7,
          title: "Add the thing",
        });
        ports.tracker.truncateBacklog(PILOT);

        const report = await morningLoop(ports);

        assert.equal(report.projects[0]?.backlogTruncated, true);
      });

      it("sets backlogTruncated on a project another outranked", async () => {
        const ports = fakePorts();
        ports.store.register(MANAGER, { priority: priority(1) });
        ports.tracker.addEligibleTicket(MANAGER, {
          number: 3,
          title: "Add another thing",
        });
        ports.store.register(PILOT);
        ports.tracker.addEligibleTicket(PILOT, {
          number: 7,
          title: "Add the thing",
        });
        ports.tracker.truncateBacklog(PILOT);
        // The gate refuses MANAGER's run, so no later iteration comes round to
        // select PILOT and its verdict stays the one the first scan gave it.
        ports.ledger.reports(spent({ weekly: Number.MAX_SAFE_INTEGER }));

        const report = await morningLoop(ports);

        const pilot = report.projects.find(({ repo }) => repo === PILOT);
        assert.equal(pilot?.verdict, "deferred");
        assert.equal(pilot?.backlogTruncated, true);
      });

      it("sets backlogTruncated on a project with no eligible tickets", async () => {
        const ports = fakePorts();
        ports.store.register(PILOT);
        ports.tracker.addBrokenOutTicket(
          PILOT,
          { number: 66, title: "Too big for one run" },
          7,
        );
        ports.tracker.truncateBacklog(PILOT);

        const report = await morningLoop(ports);

        assert.equal(report.projects[0]?.verdict, "no-eligible-tickets");
        assert.equal(report.projects[0]?.backlogTruncated, true);
      });

      it("leaves backlogTruncated absent for an untruncated listing", async () => {
        const ports = fakePorts();
        ports.store.register(PILOT);
        ports.tracker.addEligibleTicket(PILOT, {
          number: 7,
          title: "Add the thing",
        });

        const report = await morningLoop(ports);

        assert.equal(report.projects[0]?.backlogTruncated, undefined);
      });
    });

    it("never selects a paused project's ticket over another's, however high its priority", async () => {
      const ports = fakePorts();
      ports.store.register(MANAGER, { paused: true, priority: priority(1) });
      ports.tracker.addEligibleTicket(MANAGER, {
        number: 3,
        title: "Add another thing",
      });
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });

      const report = await morningLoop(ports);

      assert.equal(ports.sandbox.runs[0]?.ticket.repo, PILOT);
      assert.deepEqual(verdicts(report.projects), [
        [MANAGER, "paused"],
        [PILOT, "selected"],
      ]);
    });

    it("re-checks the gate between iterations, standing a long morning down mid-loop", async () => {
      const SPENDABLE_THIS_WEEK = 250_000_000;
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });
      ports.store.register(MANAGER);
      ports.tracker.addEligibleTicket(MANAGER, {
        number: 3,
        title: "Add another thing",
      });
      ports.ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK - 1_000 }));
      // Leaves only 1,000 tokens of reserve headroom; one run of 2,000 blows it.
      ports.sandbox.result = () => ({
        kind: "finished",
        branch: branch("issue-7-add-the-thing"),
        commits: [],
        output: "",
        tokensUsed: tokenCount(2_000),
      });

      const report = await morningLoop(ports);

      // PILOT's iteration ran; MANAGER's was selected next but the gate — now
      // counting PILOT's own cost — refused before a second run started.
      assert.equal(report.outcome, "work-selected");
      assert.equal(report.iterations.length, 1);
      assert.equal(report.iterations[0]?.repo, PILOT);
      assert.equal(report.standDown?.reason, "weekly-reserve");
      assert.equal(ports.sandbox.runs.length, 1);
      assert.match(report.message, /nadav-alon\/side-projects-manager/);
    });
  });

  describe("state", () => {
    it("reports a project with no state as never worked", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);

      const report = await morningLoop(ports);

      assert.equal(report.projects[0]?.lastWorkedAt, undefined);
    });

    it("reports when a project was last worked", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.store.markWorked(PILOT, YESTERDAY, {
        at: YESTERDAY,
        tokensUsed: tokenCount(120_000),
      });

      const report = await morningLoop(ports);

      assert.deepEqual(report.projects[0]?.lastWorkedAt, YESTERDAY);
    });

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

    it("does not select a ticket an earlier invocation worked today", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });
      ports.tracker.addEligibleTicket(PILOT, {
        number: 8,
        title: "Add the other thing",
      });
      ports.store.markWorkedOn(TODAY, { repo: PILOT, number: 7 });

      await morningLoop(ports);

      assert.deepEqual(
        ports.sandbox.runs.map((run) => run.ticket.number),
        [8],
      );
    });

    it("still selects another project's ticket with the same number as one worked today", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.store.register(MANAGER);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });
      ports.tracker.addEligibleTicket(MANAGER, {
        number: 7,
        title: "Add the other thing",
      });
      ports.store.markWorkedOn(TODAY, { repo: PILOT, number: 7 });

      await morningLoop(ports);

      assert.deepEqual(
        ports.sandbox.runs.map((run) => [run.ticket.repo, run.ticket.number]),
        [[MANAGER, 7]],
      );
    });

    it("reads a project whose only ticket was worked today as having no eligible tickets", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });
      ports.store.markWorkedOn(TODAY, { repo: PILOT, number: 7 });

      const report = await morningLoop(ports);

      assert.equal(report.outcome, "dry-queue");
      assert.deepEqual(verdicts(report.projects), [
        [PILOT, "no-eligible-tickets"],
      ]);
      assert.equal(ports.sandbox.runs.length, 0);
    });

    it("selects a ticket again once the day it was worked on has passed", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });
      ports.store.markWorkedOn(localDay(YESTERDAY), { repo: PILOT, number: 7 });

      await morningLoop(ports);

      assert.deepEqual(
        ports.sandbox.runs.map((run) => run.ticket.number),
        [7],
      );
    });

    it("records a ticket it works as worked today, dropping an earlier day's record", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });
      ports.store.markWorkedOn(localDay(YESTERDAY), {
        repo: MANAGER,
        number: 3,
      });

      await morningLoop(ports);

      assert.deepEqual((await ports.store.loadState()).workedToday, {
        day: TODAY,
        tickets: [{ repo: PILOT, number: 7 }],
      });
    });

    it("keeps the tickets an earlier invocation worked today", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });
      ports.store.markWorkedOn(TODAY, { repo: MANAGER, number: 3 });

      await morningLoop(ports);

      assert.deepEqual((await ports.store.loadState()).workedToday, {
        day: TODAY,
        tickets: [
          { repo: MANAGER, number: 3 },
          { repo: PILOT, number: 7 },
        ],
      });
    });

    it("frees the ticket for a later firing today when the sandbox could not run it", async (t) => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
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
        number: 7,
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

    it("has saved the ticket as worked today before the sandbox starts, so a run killed part way still counts", async (t) => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });
      let savedWhenRunStarted: State | undefined;
      // Reimplements `FakeSandbox.run` rather than delegating to the bound
      // original: `Sandbox.run` is overloaded on whether `model` is present,
      // and neither `.bind` nor a mock replacement keeps that shape, so a
      // request typed as the general `RunRequest` has no original overload
      // left to call through to.
      t.mock.method(ports.sandbox, "run", async (request: RunRequest) => {
        savedWhenRunStarted = await ports.store.loadState();
        ports.sandbox.runs.push(request);
        return ports.sandbox.result(request.ticket);
      });

      await morningLoop(ports);

      assert.deepEqual(savedWhenRunStarted?.workedToday, {
        day: TODAY,
        tickets: [{ repo: PILOT, number: 7 }],
      });
    });
  });

  describe("the run", () => {
    it("passes the selected ticket and the project checkout to the sandbox", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      const ticket = ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
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
        number: 7,
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
        number: 7,
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
        number: 7,
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
        number: 7,
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
        number: 7,
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
        number: 7,
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
     * a test says: `ran(ports)` did the work, and the overrides are the two
     * ways it can leave nothing to hand over.
     */
    function ran(
      ports: FakePorts,
      run: { commits?: CommitSha[]; failure?: string } = {},
    ): Ticket {
      ports.store.register(PILOT);
      const ticket = ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
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
        number: 8,
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
      assert.equal(ports.tracker.handbacks[0]?.ticket.number, ticket.number);
      assert.match(ports.tracker.handbacks[0]?.comment ?? "", /not pushed/);
      assert.match(
        ports.tracker.handbacks[0]?.comment ?? "",
        new RegExp(checkoutPath),
      );
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
        number: 7,
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
        return { repo: PILOT, number: 8, title: "Review" };
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
      const { tickets: backlog } = await ports.tracker.listEligibleTickets(PILOT);
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
        number: 7,
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
        number: 8,
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
      const { tickets: backlog } = await ports.tracker.listEligibleTickets(PILOT);
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
        number: 42,
        title: "Review the draft pull request for #7",
        pullRequest: PULL_REQUEST,
      }) as ReviewTicket;
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

      await morningLoop(ports);

      assert.deepEqual(ports.tracker.closedReviewTickets, [ticket]);
      const { tickets: backlog } = await ports.tracker.listEligibleTickets(PILOT);
      assert.deepEqual(backlog, []);
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
      assert.equal(handedBackOf(report.iterations[0]), true);
      assert.deepEqual(ports.tracker.closedReviewTickets, []);
      const [handback] = ports.tracker.handbacks;
      assert.equal(handback?.ticket.number, ticket.number);
      assert.match(handback.comment, /the review skill exited 1/);
      assert.match(handback.comment, /I could not read the diff/);
      assert.match(handback.comment, /will not be retried/);
      assert.equal(ports.sandbox.reviews.length, 1);
      assert.equal(tomorrow.outcome, "dry-queue");
    });

    it("hands back a review whose agent finished but posted nothing, naming the pull request", async () => {
      const ports = fakePorts();
      const ticket = queued(ports);
      // The sandbox process exited clean, but its own last step — posting the
      // aggregated report — never landed on the pull request.
      ports.repoHost.newCommentPosted = false;

      const report = await morningLoop(ports);

      assert.equal(failureOf(report.iterations[0])?.kind, "gave-up");
      assert.deepEqual(ports.tracker.closedReviewTickets, []);
      const [handback] = ports.tracker.handbacks;
      assert.equal(handback?.ticket.number, ticket.number);
      assert.match(handback.comment, /posted nothing/);
      assert.ok(handback.comment.includes(PULL_REQUEST));
      const { tickets: backlog } = await ports.tracker.listEligibleTickets(PILOT);
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

    it("says a review's hand-back itself failed, leaving the ticket for the developer to relabel", async (t) => {
      const ports = fakePorts();
      queued(ports);
      ports.repoHost.newCommentPosted = false;
      t.mock.method(ports.tracker, "handBack", async () => {
        throw new Error("gh is not logged in");
      });

      const report = await morningLoop(ports);

      assert.equal(handedBackOf(report.iterations[0]), false);
      assert.match(report.message, /gh is not logged in/);
      assert.match(report.message, /relabel it yourself/);
    });

    it("reports a review whose pull request cannot be checked for the comment, rather than raising it", async (t) => {
      const ports = fakePorts();
      const ticket = queued(ports);
      ports.tracker.addEligibleTicket(PILOT, { number: 7, title: "Add the thing" });
      ports.sandbox.reviewResult = () => ({
        kind: "finished",
        output: "posted findings",
        tokensUsed: tokenCount(9_000),
      });
      t.mock.method(ports.repoHost, "hasNewComment", async () => {
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
      ports.tracker.addEligibleTicket(PILOT, { number: 7, title: "Add the thing" });
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
      ports.tracker.addEligibleTicket(PILOT, { number: 7, title: "Add the thing" });
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

    it("checks the pull request for a comment made no earlier than when the review started", async () => {
      const ports = fakePorts();
      queued(ports);

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.commentChecks, [
        { pullRequest: PULL_REQUEST, since: FROZEN_NOW },
      ]);
    });

    it("is reported with nothing posted, when the agent ran but the comment never landed", async () => {
      const ports = fakePorts();
      queued(ports);
      ports.repoHost.newCommentPosted = false;

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
        number: 7,
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

    describe("the comment it leaves", () => {
      it("says why the agent stopped, and what it said before it did", async () => {
        const ports = readyToWork();
        agentGivesUp(ports);

        await morningLoop(ports);

        const [handback] = ports.tracker.handbacks;
        assert.equal(handback?.ticket.number, 7);
        assert.match(handback.comment, new RegExp(GAVE_UP));
        assert.match(handback.comment, new RegExp(SAID));
      });

    });

    describe("when the sandbox itself breaks", () => {
      it("leaves the ticket exactly as it was, since the setup is the problem", async (t) => {
        const ports = readyToWork();
        t.mock.method(ports.sandbox, "run", async () => {
          throw new Error(BROKE);
        });

        await morningLoop(ports);

        assert.deepEqual(ports.tracker.handbacks, []);
        const { tickets: backlog } = await ports.tracker.listEligibleTickets(PILOT);
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
          number: 42,
          title: "Review the draft pull request for #7",
          pullRequest: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
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
        const { tickets: backlog } = await ports.tracker.listEligibleTickets(PILOT);
        assert.ok(backlog.some((ticket) => ticket.number === review.number));
      });

      it("carries on to the next ticket", async (t) => {
        const ports = readyToWork();
        ports.tracker.addEligibleTicket(PILOT, {
          number: 8,
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
      assert.equal(handedBackOf(report.iterations[0]), false);
      assert.match(report.message, /could not be handed back/);
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
      assert.equal(handedBackOf(report.iterations[0]), true);
      assert.match(
        ports.tracker.handbacks[0]?.comment ?? "",
        /could not be discarded/,
      );
    });

    it("does not claim a branch was discarded when the agent committed nothing", async () => {
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
      assert.doesNotMatch(ports.tracker.handbacks[0]?.comment ?? "", /discard/);
    });

    it("keeps the comment small enough for a tracker to accept it", async () => {
      const ports = readyToWork();
      ports.sandbox.result = () => ({
        kind: "gave-up",
        branch: FAILED_BRANCH,
        commits: [commitSha("c0ffee1")],
        output: "x".repeat(200_000),
        tokensUsed: tokenCount(42_000),
        // A failed `execFile` carries every byte the command wrote to stderr.
        reason: "y".repeat(200_000),
      });

      await morningLoop(ports);

      // GitHub's own limit on a comment body. A comment it rejects is a
      // ticket that never gets handed back.
      assert.ok((ports.tracker.handbacks[0]?.comment.length ?? 0) < 65_536);
    });

    it("quotes output that contains code fences without breaking out of the quote", async () => {
      const ports = readyToWork();
      ports.sandbox.result = () => ({
        kind: "gave-up",
        branch: FAILED_BRANCH,
        commits: [commitSha("c0ffee1")],
        output: "I tried:\n```ts\nconst x = 1;\n```\nand it broke",
        tokensUsed: tokenCount(42_000),
        reason: GAVE_UP,
      });

      await morningLoop(ports);

      // A fence longer than any run of backticks inside, or the rest of the
      // output renders as Markdown and its `#123`s become cross-references.
      assert.match(ports.tracker.handbacks[0]?.comment ?? "", /````\n/);
    });

    it("reports the run alongside the failure, so its commits are still visible", async () => {
      const ports = readyToWork();
      agentGivesUp(ports);

      const report = await morningLoop(ports);

      assert.deepEqual(ranWith(report.iterations[0])?.commits, [commitSha("c0ffee1")]);
      assert.equal(failureOf(report.iterations[0])?.reason, GAVE_UP);
    });
  });

  describe("a run that finishes", () => {
    it("discards nothing, since a run that committed nothing left no branch behind", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
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
        number: 7,
        title: "Add the thing",
      });

      await morningLoop(ports);

      assert.equal(ports.tracker.handbacks.length, 1);
      assert.equal(ports.tracker.handbacks[0]?.ticket.number, ticket.number);
      assert.match(
        ports.tracker.handbacks[0]?.comment ?? "",
        /committed nothing/,
      );
      const { tickets: backlog } = await ports.tracker.listEligibleTickets(PILOT);
      assert.deepEqual(backlog, []);
    });

    it("takes the ticket out of the queue, so a later invocation does not select it again", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
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
        number: 7,
        title: "Add the thing",
      });
      t.mock.method(ports.tracker, "handBack", async () => {
        throw new Error("gh is not logged in");
      });

      const report = await morningLoop(ports);

      assert.equal(report.outcome, "work-selected");
      assert.match(report.message, /could not be handed back/);
      assert.match(report.message, /gh is not logged in/);
    });
  });
  /**
   * The gate is exercised here, through the loop, rather than against the
   * budget arithmetic directly: what matters is whether a morning started
   * work, not how the sum came out.
   *
   * `DEFAULT_BUDGET` holds back half of a 500,000,000-token week, so
   * 250,000,000 is the most the week may have spent before the gate refuses.
   */
  describe("the budget gate", () => {
    const SPENDABLE_THIS_WEEK = 250_000_000;

    /** A project with one thing to do, so the gate is the only question. */
    function readyToWork() {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });
      return ports;
    }

    it("starts a run while the reserve is intact", async () => {
      const ports = readyToWork();
      ports.ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK - 1 }));

      const report = await morningLoop(ports);

      assert.equal(report.outcome, "work-selected");
      assert.equal(report.standDown, undefined);
      assert.equal(ports.sandbox.runs.length, 1);
    });

    it("starts a run that leaves the reserve intact to the token", async () => {
      const ports = readyToWork();
      ports.ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK }));

      const report = await morningLoop(ports);

      assert.equal(report.outcome, "work-selected");
      assert.equal(ports.sandbox.runs.length, 1);
    });

    it("stands down rather than spend a token of the reserve", async () => {
      const ports = readyToWork();
      ports.ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK + 1 }));

      const report = await morningLoop(ports);

      assert.equal(report.outcome, "stood-down");
      assert.equal(report.standDown?.reason, "weekly-reserve");
      assert.deepEqual(ports.sandbox.runs, []);
    });

    /**
     * The two halves of the morning meet here: a gate that refused means no
     * run, and no run means nothing to hand over. A stand-down that still
     * opened a pull request would be one for a branch that was never worked.
     */
    it("hands nothing over, since a run it refused left nothing to hand over", async () => {
      const ports = readyToWork();
      ports.ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK + 1 }));

      const report = await morningLoop(ports);

      assert.equal(report.outcome, "stood-down");
      assert.deepEqual(ports.repoHost.pullRequests, []);
      assert.deepEqual(report.iterations, []);
    });

    it("stands down when the 5-hour window is spent, whatever the week looks like", async () => {
      const ports = readyToWork();
      ports.ledger.reports(spent({
        fiveHour: DEFAULT_BUDGET.fiveHourAllowance + 1,
        weekly: 0,
      }));

      const report = await morningLoop(ports);

      assert.equal(report.outcome, "stood-down");
      assert.equal(report.standDown?.reason, "five-hour-window");
      assert.deepEqual(ports.sandbox.runs, []);
    });

    it("names the window that resets later when both refuse", async () => {
      const ports = readyToWork();
      ports.ledger.reports(spent({
        fiveHour: DEFAULT_BUDGET.fiveHourAllowance + 1,
        weekly: SPENDABLE_THIS_WEEK + 1,
      }));

      const report = await morningLoop(ports);

      assert.equal(report.standDown?.reason, "weekly-reserve");
    });

    /**
     * Saturday night: the week resets at midnight, and a block opened at ten
     * runs to three in the morning. Naming the week would send a trigger back
     * at midnight to stand down all over again.
     */
    it("names the 5-hour window when it is the one that outlasts the week", async () => {
      const ports = readyToWork();
      ports.clock = new FakeClock(new Date("2026-01-03T23:00:00.000Z"));
      ports.ledger.reports({
        fiveHour: {
          openedAt: new Date("2026-01-03T22:00:00.000Z"),
          resetsAt: new Date("2026-01-04T03:00:00.000Z"),
          tokensUsed: tokenCount(DEFAULT_BUDGET.fiveHourAllowance + 1),
        },
        weekly: {
          openedAt: new Date("2025-12-28T00:00:00.000Z"),
          resetsAt: new Date("2026-01-04T00:00:00.000Z"),
          tokensUsed: tokenCount(SPENDABLE_THIS_WEEK + 1),
        },
      });

      const report = await morningLoop(ports);

      assert.equal(report.standDown?.reason, "five-hour-window");
      assert.deepEqual(
        gateRefusal(report)?.resetsAt,
        new Date("2026-01-04T03:00:00.000Z"),
      );
    });

    it("clones nothing when it stands down", async () => {
      const ports = readyToWork();
      ports.ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK + 1 }));

      await morningLoop(ports);

      assert.deepEqual(ports.repoHost.clones, []);
    });

    it("records nothing against a project it stood down on", async () => {
      const ports = readyToWork();
      ports.ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK + 1 }));

      await morningLoop(ports);

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

    describe("what the developer is told", () => {
      it("says it stood down for the budget, not that there was nothing to do", async () => {
        const ports = readyToWork();
        ports.ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK + 1 }));

        const report = await morningLoop(ports);

        assert.match(report.message, /stood down/i);
        assert.match(report.message, /reserve/i);
        assert.doesNotMatch(report.message, /nothing to do/i);
      });

      it("says which project was ready and when the window resets", async () => {
        const ports = readyToWork();
        ports.ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK + 1 }));

        const report = await morningLoop(ports);

        assert.match(report.message, /nadav-alon\/pilot/);
        assert.match(
          report.message,
          new RegExp(ports.ledger.reported.weekly.resetsAt.toISOString()),
        );
      });

      it("says the 5-hour window when that is what refused", async () => {
        const ports = readyToWork();
        ports.ledger.reports(spent({
          fiveHour: DEFAULT_BUDGET.fiveHourAllowance + 1,
        }));

        const report = await morningLoop(ports);

        assert.match(report.message, /5-hour/);
      });

      it("carries what was spent and what was spendable", async () => {
        const ports = readyToWork();
        ports.ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK + 1 }));

        const report = await morningLoop(ports);

        assert.equal(gateRefusal(report)?.tokensUsed, SPENDABLE_THIS_WEEK + 1);
        assert.equal(gateRefusal(report)?.spendable, SPENDABLE_THIS_WEEK);
        assert.deepEqual(
          gateRefusal(report)?.resetsAt,
          ports.ledger.reported.weekly.resetsAt,
        );
      });
    });

    /**
     * The ledger reads this machine's session logs, and a run writes its log
     * inside a container that is thrown away when it ends — so a morning's
     * own spend reaches the gate through the state document or not at all.
     * A gate that missed it would ration the developer's typing and never the
     * loop, which is the whole thing it was built to bound.
     */
    describe("what the mornings themselves spent", () => {
      it("counts a recorded run the ledger cannot see", async () => {
        const ports = readyToWork();
        ports.ledger.reports(spent({ weekly: 0 }));
        ports.store.markWorked(PILOT, YESTERDAY, {
          at: YESTERDAY,
          tokensUsed: tokenCount(SPENDABLE_THIS_WEEK + 1),
        });

        const report = await morningLoop(ports);

        assert.equal(report.outcome, "stood-down");
        assert.equal(report.standDown?.reason, "weekly-reserve");
        assert.deepEqual(ports.sandbox.runs, []);
      });

      it("adds them to what the ledger did see", async () => {
        const ports = readyToWork();
        ports.ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK - 100 }));
        ports.store.markWorked(PILOT, YESTERDAY, {
          at: YESTERDAY,
          tokensUsed: tokenCount(101),
        });

        const report = await morningLoop(ports);

        assert.equal(report.outcome, "stood-down");
        assert.equal(gateRefusal(report)?.tokensUsed, SPENDABLE_THIS_WEEK + 1);
      });

      it("counts every project's runs, not just the one being worked", async () => {
        const ports = readyToWork();
        ports.store.register(MANAGER);
        ports.ledger.reports(spent({ weekly: 0 }));
        ports.store.markWorked(MANAGER, YESTERDAY, {
          at: YESTERDAY,
          tokensUsed: tokenCount(SPENDABLE_THIS_WEEK + 1),
        });

        const report = await morningLoop(ports);

        assert.equal(report.outcome, "stood-down");
      });

      it("ignores runs from before the window opened", async () => {
        const ports = readyToWork();
        ports.ledger.reports(spent({ weekly: 0 }));
        ports.store.markWorked(PILOT, LAST_WEEK, {
          at: LAST_WEEK,
          tokensUsed: tokenCount(SPENDABLE_THIS_WEEK + 1),
        });

        const report = await morningLoop(ports);

        assert.equal(report.outcome, "work-selected");
        assert.equal(ports.sandbox.runs.length, 1);
      });

      /**
       * A run big enough to blow the 5-hour allowance on its own, made before
       * the current block opened. Counting it there would stand the morning
       * down; the week, which it does fall inside, has room for it.
       */
      it("leaves a run out of the 5-hour window it predates", async () => {
        const ports = readyToWork();
        ports.ledger.reports(spent({ fiveHour: 0, weekly: 0 }));
        ports.store.markWorked(PILOT, YESTERDAY, {
          at: YESTERDAY,
          tokensUsed: tokenCount(DEFAULT_BUDGET.fiveHourAllowance + 1),
        });

        const report = await morningLoop(ports);

        assert.equal(report.outcome, "work-selected");
        assert.equal(ports.sandbox.runs.length, 1);
      });
    });

    describe("the reserve fraction", () => {
      it("holds back more of the week when the developer raises it", async () => {
        const ports = readyToWork();
        ports.store.budget = {
          ...DEFAULT_BUDGET,
          reserveFraction: reserveFraction(0.9),
        };
        ports.ledger.reports(spent({ weekly: 60_000_000 }));

        const report = await morningLoop(ports);

        assert.equal(report.outcome, "stood-down");
        assert.equal(gateRefusal(report)?.spendable, 50_000_000);
      });

      it("holds back none of it at zero, and the same usage runs", async () => {
        const ports = readyToWork();
        ports.store.budget = {
          ...DEFAULT_BUDGET,
          reserveFraction: reserveFraction(0),
        };
        ports.ledger.reports(spent({ weekly: 60_000_000 }));

        const report = await morningLoop(ports);

        assert.equal(report.outcome, "work-selected");
      });

      it("is measured against the weekly allowance the developer declared", async () => {
        const ports = readyToWork();
        ports.store.budget = {
          ...DEFAULT_BUDGET,
          weeklyAllowance: tokenCount(1_000),
          reserveFraction: reserveFraction(0.5),
        };
        ports.ledger.reports(spent({ weekly: 501 }));

        const report = await morningLoop(ports);

        assert.equal(report.outcome, "stood-down");
        assert.equal(gateRefusal(report)?.spendable, 500);
      });
    });

    describe("when the gate is asked", () => {
      it("reads the ledger before the run, at the clock's instant", async (t) => {
        const ports = readyToWork();
        const read = t.mock.method(ports.ledger, "read");

        await morningLoop(ports);

        assert.equal(read.mock.callCount(), 1);
        assert.deepEqual(read.mock.calls[0]?.arguments, [FROZEN_NOW, undefined]);
      });

      it("hands the ledger the observed reset the budget declares", async (t) => {
        const ports = readyToWork();
        const observedResetAt = new Date("2026-01-01T06:00:00.000Z");
        ports.store.budget = { ...ports.store.budget, observedResetAt };
        const read = t.mock.method(ports.ledger, "read");

        await morningLoop(ports);

        assert.deepEqual(read.mock.calls[0]?.arguments, [
          FROZEN_NOW,
          observedResetAt,
        ]);
      });

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
            number: 7,
            title: "Add the thing",
          });
        });

        await morningLoop(ports);

        assert.deepEqual(order, ["gate", "run"]);
      });

      it("does not read the ledger on a morning with nothing to run", async (t) => {
        const ports = fakePorts();
        ports.store.register(PILOT);
        const read = t.mock.method(ports.ledger, "read");

        const report = await morningLoop(ports);

        assert.equal(report.outcome, "dry-queue");
        assert.equal(read.mock.callCount(), 0);
      });
    });

    describe("the spend ceiling", () => {
      it("gives the run the ceiling the budget declares", async () => {
        const ports = readyToWork();
        ports.store.budget = { ...DEFAULT_BUDGET, spendCeiling: usd(2.5) };

        await morningLoop(ports);

        assert.equal(ports.sandbox.runs[0]?.spendCeiling, 2.5);
      });
    });
  });

  describe("a limit refusal", () => {
    /** One project, three tickets: enough to see what the loop does after the limit. */
    function threeTickets(): FakePorts {
      const ports = fakePorts();
      ports.store.register(PILOT);
      for (const number of [1, 2, 3]) {
        ports.tracker.addEligibleTicket(PILOT, {
          number,
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
      const { tickets: backlog } = await ports.tracker.listEligibleTickets(PILOT);
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
        number: 42,
        title: "Review the draft pull request for #7",
        pullRequest: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
      });
      ports.sandbox.reviewResult = () => ({
        kind: "limit-refused",
        words: LIMIT_REFUSAL,
        tokensUsed: tokenCount(0),
      });

      const report = await morningLoop(ports);

      assert.equal(ports.sandbox.runs.length, 0);
      assert.deepEqual(ports.tracker.closedReviewTickets, []);
      const { tickets: backlog } = await ports.tracker.listEligibleTickets(PILOT);
      assert.ok(backlog.some((ticket) => ticket.number === review.number));
      assert.equal(report.standDown?.reason, "provider-limit");
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
        number: 7,
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
      ports.tracker.addEligibleTicket(PILOT, { number: 8, title: "Next" });
      ports.tracker.addEligibleTicket(PILOT, { number: 9, title: "After" });
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
        number: 42,
        title: reviewTitle({ repo: PILOT, number: 6, title: "Earlier" }),
        pullRequest: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
      });
      ports.store.modelDefaults = { review: HAIKU };

      await morningLoop(ports);

      assert.equal(ports.sandbox.reviews[0]?.model, HAIKU);
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
        assert.equal(ports.tracker.handbacks.length, 1);
        const comment = ports.tracker.handbacks[0]?.comment ?? "";
        assert.match(comment, /model:opus/);
        assert.match(comment, /model:haiku/);
        assert.match(comment, /keep one/i);
        assert.deepEqual((await ports.tracker.listEligibleTickets(PILOT)).tickets, []);
        assert.equal(failureOf(report.iterations[0])?.kind, "conflicting-model-labels");
      });

      it("names the labels as the ticket carries them", async () => {
        const { ports, ticket } = oneTicket();
        ports.tracker.addLabel(ticket, "Model:Opus");
        ports.tracker.addLabel(ticket, "model:haiku");

        await morningLoop(ports);

        const comment = ports.tracker.handbacks[0]?.comment ?? "";
        assert.match(comment, /`Model:Opus`/);
        assert.doesNotMatch(comment, /`model:Opus`/);
      });

      it("spends nothing, and the invocation carries on to the next ticket", async () => {
        const { ports, ticket } = oneTicket();
        ports.tracker.addLabel(ticket, "model:opus");
        ports.tracker.addLabel(ticket, "model:haiku");
        ports.tracker.addEligibleTicket(PILOT, { number: 8, title: "Next" });

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
        ports.tracker.addEligibleTicket(PILOT, { number: 8, title: "Next" });
        ports.ledger.reports(spent({ weekly: DEFAULT_BUDGET.weeklyAllowance }));

        const report = await morningLoop(ports);

        assert.equal(ports.tracker.handbacks.length, 1);
        assert.deepEqual(ports.sandbox.runs, []);
        assert.equal(report.outcome, "stood-down");
      });
    });

    it("hands back a ticket whose model label names no usable model, quoting it, and never runs it", async () => {
      const { ports, ticket } = oneTicket();
      ports.tracker.addLabel(ticket, "model:");

      await morningLoop(ports);

      assert.deepEqual(ports.sandbox.runs, []);
      assert.match(ports.tracker.handbacks[0]?.comment ?? "", /`model:`/);
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

        assert.equal(ports.tracker.handbacks.length, 1);
        const comment = ports.tracker.handbacks[0]?.comment ?? "";
        assert.match(comment, /opus/);
        assert.match(comment, /model label/);
        assert.match(comment, /refused model opus/);
        assert.doesNotMatch(comment, /gave up/);
        assert.equal(failureOf(report.iterations[0])?.kind, "model-refused");
        assert.deepEqual((await ports.tracker.listEligibleTickets(PILOT)).tickets, []);
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
          number: 42,
          title: reviewTitle({ repo: PILOT, number: 6, title: "Earlier" }),
          pullRequest: pullRequestUrl("https://github.com/nadav-alon/pilot/pull/12"),
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
      ports.tracker.addEligibleTicket(PILOT, { number: 8, title: "Next" });

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
      ports.tracker.addEligibleTicket(PILOT, { number: 7, title: "Add the thing" });
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
      ports.tracker.addEligibleTicket(PILOT, { number: 7, title: "Add the thing" });
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
      ports.tracker.addEligibleTicket(PILOT, { number: 7, title: "Add the thing" });
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
      ports.tracker.addEligibleTicket(PILOT, { number: 7, title: "Add the thing" });
      ports.sandbox.result = () => ({
        kind: "finished",
        branch: branch("issue-7-add-the-thing"),
        commits: [commitSha("c0ffee1")],
        output: "",
        tokensUsed: tokenCount(42_000),
      });
      // Just under the run's own cost: the gate lets the implementation
      // start against an empty state, but refuses the review it queues
      // before a second iteration can work it — so the review stays queued,
      // which is the thing being tested.
      ports.store.budget = {
        ...DEFAULT_BUDGET,
        weeklyAllowance: tokenCount(40_000),
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
      ports.tracker.addEligibleTicket(PILOT, { number: 7, title: "Add the thing" });
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
      ports.tracker.addEligibleTicket(PILOT, { number: 7, title: "Add the thing" });
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
        ports.tracker.addEligibleTicket(PILOT, { number: 7, title: "Add the thing" });
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
            number: 7,
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
        ports.clock = new FakeClock(new Date("2026-03-05T14:37:00.000Z"));

        await morningLoop(ports);

        assert.equal(
          ports.tracker.summaries[0]?.title,
          "Morning loop summary — 2026-03-05 14:37",
        );
      });
    });
  });
});
