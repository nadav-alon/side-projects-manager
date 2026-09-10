import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { morningRun, type ProjectOutcome } from "./morning-run.ts";
import {
  DEFAULT_BUDGET,
  branch,
  repoSlug,
  reserveFraction,
  tokenCount,
  usd,
  type Ticket,
} from "./ports/index.ts";
import {
  FROZEN_NOW,
  FakeClock,
  FakeRepoHost,
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

describe("morningRun", () => {
  it("reports a dry queue when nothing is registered", async () => {
    const ports = fakePorts();

    const report = await morningRun(ports);

    assert.equal(report.outcome, "dry-queue");
    assert.deepEqual(report.projects, []);
    assert.match(report.message, /nothing to do/i);
  });

  it("reports a dry queue when every backlog is empty", async () => {
    const ports = fakePorts();
    ports.store.register(MANAGER);
    ports.store.register(PILOT);

    const report = await morningRun(ports);

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

    await morningRun(ports);

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

    await morningRun(ports);

    assert.equal(run.mock.callCount(), 0);
  });

  it("selects the project it found work in", async () => {
    const ports = fakePorts();
    ports.store.register(PILOT);
    ports.tracker.addEligibleTicket(PILOT, {
      number: 7,
      title: "Add the thing",
    });

    const report = await morningRun(ports);

    assert.equal(report.outcome, "work-selected");
    assert.deepEqual(verdicts(report.projects), [[PILOT, "selected"]]);
    assert.match(report.message, /nadav-alon\/pilot/);
  });

  it("stops considering projects once one is selected, since an iteration works one project", async (t) => {
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

    await morningRun(ports);

    assert.equal(listEligibleTickets.mock.callCount(), 1);
    assert.deepEqual(listEligibleTickets.mock.calls[0]?.arguments, [PILOT]);
  });

  it("timestamps the report from the injected clock, not wall time", async () => {
    const ports = fakePorts();
    const startedAt = ports.clock.now();

    const report = await morningRun(ports);

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

      const report = await morningRun(ports);

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

      const report = await morningRun(ports);

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

      const report = await morningRun(ports);

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

  describe("state", () => {
    it("reports a project with no state as never worked", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);

      const report = await morningRun(ports);

      assert.equal(report.projects[0]?.lastWorkedAt, undefined);
    });

    it("reports when a project was last worked", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.store.markWorked(PILOT, YESTERDAY, {
        at: YESTERDAY,
        tokensUsed: tokenCount(120_000),
      });

      const report = await morningRun(ports);

      assert.deepEqual(report.projects[0]?.lastWorkedAt, YESTERDAY);
    });

    it("is written back after every invocation, including a quiet one", async (t) => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      const saveState = t.mock.method(ports.store, "saveState");

      await morningRun(ports);

      assert.equal(saveState.mock.callCount(), 1);
    });

    it("keeps what earlier invocations recorded", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.store.markWorked(PILOT, YESTERDAY, {
        at: YESTERDAY,
        tokensUsed: tokenCount(120_000),
      });

      await morningRun(ports);
      const report = await morningRun(ports);

      assert.deepEqual(report.projects[0]?.lastWorkedAt, YESTERDAY);
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

      await morningRun(ports);

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

      await morningRun(ports);

      assert.deepEqual(ports.repoHost.clones, [PILOT]);
    });

    it("clones nothing when the queue is dry", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);

      await morningRun(ports);

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
        branch: branch("issue-7-add-the-thing"),
        commits: ["c0ffee1", "c0ffee2"],
        output: "implemented the thing",
        tokensUsed: tokenCount(42_000),
      });

      const report = await morningRun(ports);

      assert.deepEqual(report.run, {
        branch: branch("issue-7-add-the-thing"),
        commits: ["c0ffee1", "c0ffee2"],
        output: "implemented the thing",
        tokensUsed: tokenCount(42_000),
      });
    });

    it("has no run to report on a quiet morning", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);

      const report = await morningRun(ports);

      assert.equal(report.run, undefined);
    });

    it("says in the message what the run left behind", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });
      ports.sandbox.result = () => ({
        branch: branch("issue-7-add-the-thing"),
        commits: ["c0ffee1"],
        output: "",
        tokensUsed: tokenCount(42_000),
      });

      const report = await morningRun(ports);

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

      await morningRun(ports);
      const report = await morningRun(ports);

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
        branch: branch("issue-7-add-the-thing"),
        commits: [],
        output: "",
        tokensUsed: tokenCount(42_000),
      });

      await morningRun(ports);

      const state = await ports.store.loadState();
      assert.deepEqual(state.get(PILOT)?.runs, [
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

      await morningRun(ports);

      const state = await ports.store.loadState();
      assert.deepEqual(
        state.get(PILOT)?.runs.map((run) => run.at),
        [YESTERDAY, FROZEN_NOW],
      );
    });

    it("records nothing against a project it never ran", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);

      await morningRun(ports);

      const state = await ports.store.loadState();
      assert.equal(state.get(PILOT), undefined);
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
      run: { commits?: string[]; failure?: string } = {},
    ): Ticket {
      ports.store.register(PILOT);
      const ticket = ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });
      ports.sandbox.result = () => ({
        branch: BRANCH,
        commits: run.commits ?? ["c0ffee1"],
        output: "",
        tokensUsed: tokenCount(42_000),
        ...(run.failure !== undefined && { failure: run.failure }),
      });
      return ticket;
    }

    it("is opened for the branch a run left commits on", async () => {
      const ports = fakePorts();
      const ticket = ran(ports);

      await morningRun(ports);

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

      const report = await morningRun(ports);

      assert.equal(report.pullRequest, FakeRepoHost.RUN_PULL_REQUEST);
      assert.match(report.message, new RegExp(FakeRepoHost.RUN_PULL_REQUEST));
    });

    it("is not opened for a run that committed nothing", async () => {
      const ports = fakePorts();
      ran(ports, { commits: [] });

      const report = await morningRun(ports);

      assert.deepEqual(ports.repoHost.pullRequests, []);
      assert.equal(report.pullRequest, undefined);
    });

    it("leaves the message saying nothing was left behind", async () => {
      const ports = fakePorts();
      ran(ports, { commits: [] });

      const report = await morningRun(ports);

      // Never the branch: the sandbox keeps no branch for a run that
      // committed nothing, so naming one would send the developer looking
      // for something that was never created.
      assert.match(report.message, /left nothing behind/);
      assert.doesNotMatch(report.message, /issue-7-add-the-thing/);
    });

    it("is not opened for a run the agent did not finish", async () => {
      const ports = fakePorts();
      ran(ports, { failure: "the agent gave up" });

      const report = await morningRun(ports);

      assert.deepEqual(ports.repoHost.pullRequests, []);
      assert.equal(report.pullRequest, undefined);
    });

    it("leaves a failed run's commits named, so they can be judged", async () => {
      const ports = fakePorts();
      ran(ports, { failure: "the agent gave up" });

      const report = await morningRun(ports);

      assert.match(report.message, /1 commit on issue-7-add-the-thing/);
      assert.match(report.message, /the agent gave up/);
    });

    it("is not opened on a morning that ran nothing", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);

      const report = await morningRun(ports);

      assert.deepEqual(ports.repoHost.pullRequests, []);
      assert.equal(report.pullRequest, undefined);
    });

    it("still leaves the project recorded as worked, at what the run cost", async () => {
      const ports = fakePorts();
      ran(ports);

      await morningRun(ports);

      const state = await ports.store.loadState();
      assert.deepEqual(state.get(PILOT), {
        lastWorkedAt: FROZEN_NOW,
        runs: [{ at: FROZEN_NOW, tokensUsed: tokenCount(42_000) }],
      });
    });

    it("leaves the work recorded even when it could not be opened", async () => {
      const ports = fakePorts();
      ran(ports);
      ports.repoHost.draftPullRequest = async () => {
        throw new Error("pull requests are disabled on this repository");
      };

      await assert.rejects(morningRun(ports), /pull requests are disabled/);

      const state = await ports.store.loadState();
      assert.deepEqual(state.get(PILOT)?.runs, [
        { at: FROZEN_NOW, tokensUsed: tokenCount(42_000) },
      ]);
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
        branch: branch("issue-7-add-the-thing"),
        commits: ["c0ffee1"],
        output: "",
        tokensUsed: tokenCount(42_000),
      });
      return ticket;
    }

    it("is opened against the ticket the run worked, naming its pull request", async () => {
      const ports = fakePorts();
      const ticket = ranSuccessfully(ports);

      await morningRun(ports);

      assert.deepEqual(
        ports.tracker.reviewTickets.map((review) => ({
          parent: review.parent,
          pullRequest: review.pullRequest,
        })),
        [{ parent: ticket, pullRequest: FakeRepoHost.RUN_PULL_REQUEST }],
      );
    });

    it("is opened by the loop rather than asked of the agent", async (t) => {
      const ports = fakePorts();
      ranSuccessfully(ports);
      // The agent is handed the ticket and nothing else: whatever it did or
      // failed to do in the sandbox, the review is the loop's to open, and
      // opening it exactly once is what makes that true.
      const run = t.mock.method(ports.sandbox, "run");

      await morningRun(ports);

      assert.equal(run.mock.callCount(), 1);
      assert.equal(ports.tracker.reviewTickets.length, 1);
    });

    it("is opened only once the pull request it names exists", async (t) => {
      const ports = fakePorts();
      ranSuccessfully(ports);
      const order: string[] = [];
      t.mock.method(ports.repoHost, "openDraftPullRequest", async () => {
        order.push("pull request");
        return FakeRepoHost.RUN_PULL_REQUEST;
      });
      t.mock.method(ports.tracker, "createReviewTicket", async () => {
        order.push("review ticket");
        return { repo: PILOT, number: 8, title: "Review" };
      });

      await morningRun(ports);

      assert.deepEqual(order, ["pull request", "review ticket"]);
    });

    it("leaves the ticket it reviews exactly as it found it", async () => {
      const ports = fakePorts();
      const ticket = ranSuccessfully(ports);

      await morningRun(ports);

      // Still open, still eligible, still itself: a review is queued beside
      // the ticket that earned it, and closing that one is the developer's.
      const backlog = await ports.tracker.listEligibleTickets(PILOT);
      assert.ok(backlog.some((eligible) => eligible.number === ticket.number));
      assert.deepEqual(
        backlog.find((eligible) => eligible.number === ticket.number),
        ticket,
      );
    });

    it("is reported, so the developer is told the review is queued", async () => {
      const ports = fakePorts();
      ranSuccessfully(ports);

      const report = await morningRun(ports);

      const review = ports.tracker.reviewTickets[0]?.ticket;
      assert.deepEqual(report.reviewTicket, review);
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
        branch: branch("issue-7-add-the-thing"),
        commits: [],
        output: "the agent gave up",
        tokensUsed: tokenCount(42_000),
      });

      const report = await morningRun(ports);

      // Nothing was opened, so there is nothing to review.
      assert.deepEqual(ports.tracker.reviewTickets, []);
      assert.equal(report.reviewTicket, undefined);
    });

    it("is not opened on a morning that ran nothing", async () => {
      const ports = fakePorts();
      ports.store.register(PILOT);

      const report = await morningRun(ports);

      assert.deepEqual(ports.tracker.reviewTickets, []);
      assert.equal(report.reviewTicket, undefined);
    });

    it("leaves the work recorded even when it could not be opened", async (t) => {
      const ports = fakePorts();
      ranSuccessfully(ports);
      t.mock.method(ports.tracker, "createReviewTicket", async () => {
        throw new Error("issues are disabled on this repository");
      });

      await assert.rejects(morningRun(ports), /issues are disabled/);

      const state = await ports.store.loadState();
      assert.deepEqual(state.get(PILOT)?.runs, [
        { at: FROZEN_NOW, tokensUsed: tokenCount(42_000) },
      ]);
    });
  });

  describe("a run that falls over", () => {
    it("still writes state back, since it still spent the morning", async (t) => {
      const ports = fakePorts();
      ports.store.register(PILOT);
      ports.tracker.addEligibleTicket(PILOT, {
        number: 7,
        title: "Add the thing",
      });
      t.mock.method(ports.sandbox, "run", async () => {
        throw new Error("docker is not running");
      });
      const saveState = t.mock.method(ports.store, "saveState");

      await assert.rejects(morningRun(ports), /docker is not running/);

      assert.equal(saveState.mock.callCount(), 1);
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

      const report = await morningRun(ports);

      assert.equal(report.outcome, "work-selected");
      assert.equal(report.standDown, undefined);
      assert.equal(ports.sandbox.runs.length, 1);
    });

    it("starts a run that leaves the reserve intact to the token", async () => {
      const ports = readyToWork();
      ports.ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK }));

      const report = await morningRun(ports);

      assert.equal(report.outcome, "work-selected");
      assert.equal(ports.sandbox.runs.length, 1);
    });

    it("stands down rather than spend a token of the reserve", async () => {
      const ports = readyToWork();
      ports.ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK + 1 }));

      const report = await morningRun(ports);

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

      const report = await morningRun(ports);

      assert.equal(report.outcome, "stood-down");
      assert.deepEqual(ports.repoHost.pullRequests, []);
      assert.equal(report.pullRequest, undefined);
      assert.equal(report.run, undefined);
    });

    it("stands down when the 5-hour window is spent, whatever the week looks like", async () => {
      const ports = readyToWork();
      ports.ledger.reports(spent({
        fiveHour: DEFAULT_BUDGET.fiveHourAllowance + 1,
        weekly: 0,
      }));

      const report = await morningRun(ports);

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

      const report = await morningRun(ports);

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

      const report = await morningRun(ports);

      assert.equal(report.standDown?.reason, "five-hour-window");
      assert.deepEqual(
        report.standDown?.resetsAt,
        new Date("2026-01-04T03:00:00.000Z"),
      );
    });

    it("clones nothing when it stands down", async () => {
      const ports = readyToWork();
      ports.ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK + 1 }));

      await morningRun(ports);

      assert.deepEqual(ports.repoHost.clones, []);
    });

    it("records nothing against a project it stood down on", async () => {
      const ports = readyToWork();
      ports.ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK + 1 }));

      await morningRun(ports);

      const state = await ports.store.loadState();
      assert.equal(state.get(PILOT), undefined);
    });

    it("still writes state back on a morning it stood down", async (t) => {
      const ports = readyToWork();
      ports.ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK + 1 }));
      const saveState = t.mock.method(ports.store, "saveState");

      await morningRun(ports);

      assert.equal(saveState.mock.callCount(), 1);
    });

    describe("what the developer is told", () => {
      it("says it stood down for the budget, not that there was nothing to do", async () => {
        const ports = readyToWork();
        ports.ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK + 1 }));

        const report = await morningRun(ports);

        assert.match(report.message, /stood down/i);
        assert.match(report.message, /reserve/i);
        assert.doesNotMatch(report.message, /nothing to do/i);
      });

      it("says which project was ready and when the window resets", async () => {
        const ports = readyToWork();
        ports.ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK + 1 }));

        const report = await morningRun(ports);

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

        const report = await morningRun(ports);

        assert.match(report.message, /5-hour/);
      });

      it("carries what was spent and what was spendable", async () => {
        const ports = readyToWork();
        ports.ledger.reports(spent({ weekly: SPENDABLE_THIS_WEEK + 1 }));

        const report = await morningRun(ports);

        assert.equal(report.standDown?.tokensUsed, SPENDABLE_THIS_WEEK + 1);
        assert.equal(report.standDown?.spendable, SPENDABLE_THIS_WEEK);
        assert.deepEqual(
          report.standDown?.resetsAt,
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

        const report = await morningRun(ports);

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

        const report = await morningRun(ports);

        assert.equal(report.outcome, "stood-down");
        assert.equal(report.standDown?.tokensUsed, SPENDABLE_THIS_WEEK + 1);
      });

      it("counts every project's runs, not just the one being worked", async () => {
        const ports = readyToWork();
        ports.store.register(MANAGER);
        ports.ledger.reports(spent({ weekly: 0 }));
        ports.store.markWorked(MANAGER, YESTERDAY, {
          at: YESTERDAY,
          tokensUsed: tokenCount(SPENDABLE_THIS_WEEK + 1),
        });

        const report = await morningRun(ports);

        assert.equal(report.outcome, "stood-down");
      });

      it("ignores runs from before the window opened", async () => {
        const ports = readyToWork();
        ports.ledger.reports(spent({ weekly: 0 }));
        ports.store.markWorked(PILOT, LAST_WEEK, {
          at: LAST_WEEK,
          tokensUsed: tokenCount(SPENDABLE_THIS_WEEK + 1),
        });

        const report = await morningRun(ports);

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

        const report = await morningRun(ports);

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

        const report = await morningRun(ports);

        assert.equal(report.outcome, "stood-down");
        assert.equal(report.standDown?.spendable, 50_000_000);
      });

      it("holds back none of it at zero, and the same usage runs", async () => {
        const ports = readyToWork();
        ports.store.budget = {
          ...DEFAULT_BUDGET,
          reserveFraction: reserveFraction(0),
        };
        ports.ledger.reports(spent({ weekly: 60_000_000 }));

        const report = await morningRun(ports);

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

        const report = await morningRun(ports);

        assert.equal(report.outcome, "stood-down");
        assert.equal(report.standDown?.spendable, 500);
      });
    });

    describe("when the gate is asked", () => {
      it("reads the ledger before the run, at the clock's instant", async (t) => {
        const ports = readyToWork();
        const read = t.mock.method(ports.ledger, "read");

        await morningRun(ports);

        assert.equal(read.mock.callCount(), 1);
        assert.deepEqual(read.mock.calls[0]?.arguments, [FROZEN_NOW]);
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

        await morningRun(ports);

        assert.deepEqual(order, ["gate", "run"]);
      });

      it("does not read the ledger on a morning with nothing to run", async (t) => {
        const ports = fakePorts();
        ports.store.register(PILOT);
        const read = t.mock.method(ports.ledger, "read");

        const report = await morningRun(ports);

        assert.equal(report.outcome, "dry-queue");
        assert.equal(read.mock.callCount(), 0);
      });
    });

    describe("the spend ceiling", () => {
      it("gives the run the ceiling the budget declares", async () => {
        const ports = readyToWork();
        ports.store.budget = { ...DEFAULT_BUDGET, spendCeiling: usd(2.5) };

        await morningRun(ports);

        assert.equal(ports.sandbox.runs[0]?.spendCeiling, 2.5);
      });
    });
  });
});
