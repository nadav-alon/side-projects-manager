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
} from "./ports/index.ts";
import {
  FROZEN_NOW,
  FakeRepoHost,
  fakePorts,
  spent,
} from "./testing/index.ts";

const MANAGER = repoSlug("nadav-alon/side-projects-manager");
const PILOT = repoSlug("nadav-alon/pilot");

const YESTERDAY = new Date("2025-12-31T06:00:00.000Z");

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
      ports.ledger.windows = spent({ weekly: SPENDABLE_THIS_WEEK - 1 });

      const report = await morningRun(ports);

      assert.equal(report.outcome, "work-selected");
      assert.equal(report.standDown, undefined);
      assert.equal(ports.sandbox.runs.length, 1);
    });

    it("starts a run that leaves the reserve intact to the token", async () => {
      const ports = readyToWork();
      ports.ledger.windows = spent({ weekly: SPENDABLE_THIS_WEEK });

      const report = await morningRun(ports);

      assert.equal(report.outcome, "work-selected");
      assert.equal(ports.sandbox.runs.length, 1);
    });

    it("stands down rather than spend a token of the reserve", async () => {
      const ports = readyToWork();
      ports.ledger.windows = spent({ weekly: SPENDABLE_THIS_WEEK + 1 });

      const report = await morningRun(ports);

      assert.equal(report.outcome, "stood-down");
      assert.equal(report.standDown?.reason, "weekly-reserve");
      assert.deepEqual(ports.sandbox.runs, []);
    });

    it("stands down when the 5-hour window is spent, whatever the week looks like", async () => {
      const ports = readyToWork();
      ports.ledger.windows = spent({
        fiveHour: DEFAULT_BUDGET.fiveHourAllowance + 1,
        weekly: 0,
      });

      const report = await morningRun(ports);

      assert.equal(report.outcome, "stood-down");
      assert.equal(report.standDown?.reason, "five-hour-window");
      assert.deepEqual(ports.sandbox.runs, []);
    });

    it("names the week when both windows refuse, since it is the one that resets later", async () => {
      const ports = readyToWork();
      ports.ledger.windows = spent({
        fiveHour: DEFAULT_BUDGET.fiveHourAllowance + 1,
        weekly: SPENDABLE_THIS_WEEK + 1,
      });

      const report = await morningRun(ports);

      assert.equal(report.standDown?.reason, "weekly-reserve");
    });

    it("clones nothing when it stands down", async () => {
      const ports = readyToWork();
      ports.ledger.windows = spent({ weekly: SPENDABLE_THIS_WEEK + 1 });

      await morningRun(ports);

      assert.deepEqual(ports.repoHost.clones, []);
    });

    it("records nothing against a project it stood down on", async () => {
      const ports = readyToWork();
      ports.ledger.windows = spent({ weekly: SPENDABLE_THIS_WEEK + 1 });

      await morningRun(ports);

      const state = await ports.store.loadState();
      assert.equal(state.get(PILOT), undefined);
    });

    it("still writes state back on a morning it stood down", async (t) => {
      const ports = readyToWork();
      ports.ledger.windows = spent({ weekly: SPENDABLE_THIS_WEEK + 1 });
      const saveState = t.mock.method(ports.store, "saveState");

      await morningRun(ports);

      assert.equal(saveState.mock.callCount(), 1);
    });

    describe("what the developer is told", () => {
      it("says it stood down for the budget, not that there was nothing to do", async () => {
        const ports = readyToWork();
        ports.ledger.windows = spent({ weekly: SPENDABLE_THIS_WEEK + 1 });

        const report = await morningRun(ports);

        assert.match(report.message, /stood down/i);
        assert.match(report.message, /reserve/i);
        assert.doesNotMatch(report.message, /nothing to do/i);
      });

      it("says which project was ready and when headroom returns", async () => {
        const ports = readyToWork();
        ports.ledger.windows = spent({ weekly: SPENDABLE_THIS_WEEK + 1 });

        const report = await morningRun(ports);

        assert.match(report.message, /nadav-alon\/pilot/);
        assert.match(
          report.message,
          new RegExp(ports.ledger.windows.weekly.resetsAt.toISOString()),
        );
      });

      it("says the 5-hour window when that is what refused", async () => {
        const ports = readyToWork();
        ports.ledger.windows = spent({
          fiveHour: DEFAULT_BUDGET.fiveHourAllowance + 1,
        });

        const report = await morningRun(ports);

        assert.match(report.message, /5-hour/);
      });

      it("carries what was spent and what was spendable", async () => {
        const ports = readyToWork();
        ports.ledger.windows = spent({ weekly: SPENDABLE_THIS_WEEK + 1 });

        const report = await morningRun(ports);

        assert.equal(report.standDown?.tokensUsed, SPENDABLE_THIS_WEEK + 1);
        assert.equal(report.standDown?.spendable, SPENDABLE_THIS_WEEK);
        assert.deepEqual(
          report.standDown?.resetsAt,
          ports.ledger.windows.weekly.resetsAt,
        );
      });
    });

    describe("the reserve fraction", () => {
      it("holds back more of the week when the developer raises it", async () => {
        const ports = readyToWork();
        ports.store.budget = {
          ...DEFAULT_BUDGET,
          reserveFraction: reserveFraction(0.9),
        };
        ports.ledger.windows = spent({ weekly: 60_000_000 });

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
        ports.ledger.windows = spent({ weekly: 60_000_000 });

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
        ports.ledger.windows = spent({ weekly: 501 });

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
